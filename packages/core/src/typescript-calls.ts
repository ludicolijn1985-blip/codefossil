import { createRequire } from 'node:module';
import { join, relative, sep } from 'node:path';
import type * as TS from 'typescript';
import { listHeadFiles, runGit } from '@codefossil/git';

/** A call the TypeScript type checker resolved to a declaration in the repository. */
export interface CheckedCall {
  /** Repository-relative path of the calling file. */
  readonly fromPath: string;
  /** 1-based line of the call. */
  readonly line: number;
  /** The callee as written (`this.repo.save`). */
  readonly text: string;
  /** Repository-relative path, 1-based line and name of the declaration it resolves to. */
  readonly toPath: string;
  readonly toLine: number;
  readonly toName: string;
}

export interface CheckedCalls {
  readonly calls: readonly CheckedCall[];
  /** Why no or fewer calls were checked (no compiler, no config, dirty files); null when none. */
  readonly note: string | null;
  /** The compiler version that resolved them. */
  readonly compiler: string | null;
}

/** Projects (a tsconfig and its references) compiled at most. */
const MAX_PROJECTS = 50;
/** Calls kept at most; a larger program is cut off with a note. */
const MAX_CALLS = 500_000;
const MAX_CALLEE_TEXT = 120;

type TypeScript = typeof TS;

/**
 * The TypeScript compiler installed alongside codefossil, or — only when
 * `fromRepository` is asked for explicitly — the one the repository
 * installed. Loading the repository's runs code from its node_modules.
 */
function loadTypeScript(root: string, fromRepository: boolean): TypeScript | null {
  const name = 'typescript';
  const places = [import.meta.url, ...(fromRepository ? [join(root, 'package.json')] : [])];
  for (const from of places) {
    try {
      return createRequire(from)(name) as TypeScript;
    } catch {
      // Not resolvable from here: try the next place.
    }
  }
  return null;
}

/** Files with uncommitted changes: their lines do not match HEAD, so their calls are skipped. */
async function dirtyFiles(root: string): Promise<Set<string>> {
  const output = await runGit(root, ['diff', '--name-only', '-z', 'HEAD', '--']);
  return new Set(output.split('\0').filter((path) => path !== ''));
}

/** A committed `tsconfig.json` outside `node_modules`. */
const PACKAGE_CONFIG = /(^|\/)tsconfig\.json$/;

/**
 * The parsed configs to compile: the root tsconfig and, recursively, the
 * projects it references; in a monorepo without a compilable root project,
 * every `tsconfig.json` committed at HEAD (one per package), shallowest first.
 */
function projects(
  ts: TypeScript,
  root: string,
  headFiles: ReadonlySet<string>,
): TS.ParsedCommandLine[] {
  const first = ts.findConfigFile(root, ts.sys.fileExists.bind(ts.sys), 'tsconfig.json');
  const host: TS.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: () => undefined,
  };
  const found: TS.ParsedCommandLine[] = [];
  const seen = new Set<string>();
  const pending = first && !relative(root, first).startsWith('..') ? [first] : [];
  let fellBack = false;
  while (found.length < MAX_PROJECTS) {
    if (pending.length === 0) {
      if (found.length > 0 || fellBack) break;
      fellBack = true;
      const packages = [...headFiles]
        .filter((path) => PACKAGE_CONFIG.test(path) && !path.includes('node_modules/'))
        .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
        .map((path) => join(root, path));
      if (packages.length === 0) break;
      pending.push(...packages);
    }
    const path = pending.shift() ?? '';
    if (seen.has(path)) continue;
    seen.add(path);
    const parsed = ts.getParsedCommandLineOfConfigFile(path, { noEmit: true }, host);
    if (!parsed) continue;
    if (parsed.fileNames.length > 0) found.push(parsed);
    for (const reference of parsed.projectReferences ?? []) {
      const target = ts.resolveProjectReferencePath(reference);
      if (!relative(root, target).startsWith('..')) pending.push(target);
    }
  }
  return found;
}

/** The declaration a call reaches, for a constructor its class. */
function declarationOf(
  ts: TypeScript,
  checker: TS.TypeChecker,
  call: TS.CallExpression | TS.NewExpression,
): TS.Declaration | undefined {
  let declaration: TS.Declaration | undefined = checker.getResolvedSignature(call)?.declaration;
  if (!declaration || ts.isJSDocSignature(declaration)) {
    let symbol = checker.getSymbolAtLocation(
      ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression,
    );
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  }
  if (declaration && ts.isConstructorDeclaration(declaration)) return declaration.parent;
  return declaration;
}

function nameOf(ts: TypeScript, declaration: TS.Declaration): string | null {
  const name = ts.getNameOfDeclaration(declaration);
  if (name && (ts.isIdentifier(name) || ts.isPrivateIdentifier(name))) return name.text;
  // `const f = () => …`: the variable names the function.
  const parent = declaration.parent as TS.Node | undefined;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  return null;
}

/**
 * Resolve every call in the repository's TypeScript with the type checker:
 * calls through variables, parameters, generics, overloads and re-exports
 * that name-based resolution cannot follow. Only calls between files that
 * are committed unchanged at HEAD are returned. Opt-in: building the program
 * takes time and may load the repository's own compiler.
 */
export async function typeCheckedCalls(
  root: string,
  options: { readonly fromRepository?: boolean } = {},
): Promise<CheckedCalls> {
  const ts = loadTypeScript(root, options.fromRepository === true);
  if (!ts) {
    return {
      calls: [],
      note: options.fromRepository
        ? 'TypeScript is installed neither next to codefossil nor in the repository'
        : 'TypeScript is not installed next to codefossil (npm install -g codefossil typescript); ' +
          "--typescript-from-repo uses the repository's own, running its code",
      compiler: null,
    };
  }
  const headFiles = await listHeadFiles(root);
  const configs = projects(ts, root, headFiles);
  if (configs.length === 0) {
    return {
      calls: [],
      note: 'no tsconfig.json with files in the repository',
      compiler: ts.version,
    };
  }
  const dirty = await dirtyFiles(root);
  const repoPath = (fileName: string): string | null => {
    const path = relative(root, fileName).split(sep).join('/');
    if (path.startsWith('..') || path.includes('node_modules/') || !headFiles.has(path))
      return null;
    return dirty.has(path) ? null : path;
  };

  const calls: CheckedCall[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const config of configs) {
    const program = ts.createProgram({
      rootNames: config.fileNames,
      options: { ...config.options, noEmit: true },
      projectReferences: config.projectReferences ?? [],
    });
    const checker = program.getTypeChecker();
    for (const source of program.getSourceFiles()) {
      if (source.isDeclarationFile) continue;
      const fromPath = repoPath(source.fileName);
      if (!fromPath) continue;
      // Iterative walk: repository sources are untrusted and may nest deeply.
      const stack: TS.Node[] = [source];
      for (let node = stack.pop(); node; node = stack.pop()) {
        if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
          const declaration = declarationOf(ts, checker, node);
          const target = declaration?.getSourceFile();
          const toPath = target && !target.isDeclarationFile ? repoPath(target.fileName) : null;
          const toName = declaration ? nameOf(ts, declaration) : null;
          if (declaration && target && toPath && toName) {
            const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
            const toLine =
              target.getLineAndCharacterOfPosition(declaration.getStart(target)).line + 1;
            const key = `${fromPath}:${String(line)}>${toPath}:${String(toLine)}`;
            if (!seen.has(key)) {
              seen.add(key);
              calls.push({
                fromPath,
                line,
                text: node.expression.getText(source).replace(/\s+/g, '').slice(0, MAX_CALLEE_TEXT),
                toPath,
                toLine,
                toName,
              });
              if (calls.length >= MAX_CALLS) {
                truncated = true;
                break;
              }
            }
          }
        }
        node.forEachChild((child) => {
          stack.push(child);
        });
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  const notes = [
    ...(dirty.size > 0
      ? [`${String(dirty.size)} file(s) with uncommitted changes were skipped`]
      : []),
    ...(truncated ? [`stopped after ${String(MAX_CALLS)} calls`] : []),
  ];
  return { calls, note: notes.length > 0 ? notes.join('; ') : null, compiler: ts.version };
}

export const TYPESCRIPT_ENV = 'CODEFOSSIL_TYPESCRIPT';

/** The opt-in: `CODEFOSSIL_TYPESCRIPT=1`. */
export function typeCheckingRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[TYPESCRIPT_ENV] === '1' || env[TYPESCRIPT_ENV] === 'true';
}
