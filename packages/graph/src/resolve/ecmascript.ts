import { builtinModules } from 'node:module';
import type { ImportReference } from '@codefossil/parser';
import { dirOf, joinPath, unresolved, type LayoutIndex, type Resolution } from './layout.js';
import { matchPaths, pathsBase, type TsConfigIndex } from './tsconfig-paths.js';

const EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** TypeScript ESM code imports `./a.js` for a source file named `a.ts`. */
const SOURCE_FOR_OUTPUT: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

const BUILTINS = new Set(builtinModules);

const TYPESCRIPT_FILE = /\.[cm]?tsx?$/;

/**
 * Candidate files in the order the importer's own toolchain would try them.
 * TypeScript (`tsc`) maps `./a.js` to the source `a.ts` before the literal
 * file; Node, which runs JavaScript importers, only knows the literal file.
 * Mixing the two up would claim an edge to the wrong file.
 */
function fileCandidates(base: string, importerIsTypeScript: boolean): string[] {
  const extension = /\.[cm]?jsx?$/.exec(base)?.[0];
  const stem = extension ? base.slice(0, -extension.length) : base;
  const sourceSwaps =
    extension && importerIsTypeScript
      ? (SOURCE_FOR_OUTPUT[extension] ?? []).map((ext) => stem + ext)
      : [];
  return [
    ...sourceSwaps,
    base,
    ...EXTENSIONS.map((ext) => base + ext),
    ...EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
}

/** `@scope/pkg/sub/path` → [`@scope/pkg`, `./sub/path`]; `pkg` → [`pkg`, `.`]. */
function splitPackage(specifier: string): [string, string] {
  const parts = specifier.split('/');
  const size = specifier.startsWith('@') ? 2 : 1;
  const name = parts.slice(0, size).join('/');
  const rest = parts.slice(size).join('/');
  return [name, rest ? `./${rest}` : '.'];
}

/**
 * A bare specifier through the governing tsconfig, as `tsc` does before
 * looking for packages: `paths` first, then `baseUrl`. Returns the resolved
 * files, or why a matching `paths` pattern found nothing, or null when the
 * config does not apply. A `paths` key names the specifier on purpose and may
 * shadow a Node built-in; a broad `baseUrl` lookup may not, since a stray
 * `src/assert.ts` would otherwise capture `import 'assert'`.
 */
function resolveAlias(
  index: LayoutIndex,
  tsconfigs: TsConfigIndex,
  fromPath: string,
  spec: string,
  isBuiltin: boolean,
): Resolution | { readonly aliasMiss: string } | null {
  const governing = tsconfigs.forFile(fromPath);
  if (!governing) return null;
  const { config } = governing;
  const importerIsTypeScript = TYPESCRIPT_FILE.test(fromPath);
  let aliasMiss: string | null = null;

  const { paths } = config;
  const base = pathsBase(config);
  const match = paths && base !== null ? matchPaths(paths.patterns, spec) : null;
  if (paths && base !== null && match) {
    const candidates = match.targets.flatMap((target) => {
      const joined = joinPath(base, target);
      return joined === null ? [] : fileCandidates(joined, importerIsTypeScript);
    });
    const found = index.firstExisting(candidates);
    const method = `tsconfig-paths:${paths.definedIn}#${match.pattern}`;
    if (found) return { kind: 'files', paths: [found], confidence: 1, method };
    aliasMiss = `tsconfig path ${match.pattern} in ${paths.definedIn} matched but no target file exists`;
  }

  if (!isBuiltin && config.baseUrlDefinedIn && config.baseUrl !== null) {
    const joined = joinPath(config.baseUrl, spec);
    const found =
      joined === null ? null : index.firstExisting(fileCandidates(joined, importerIsTypeScript));
    if (found) {
      const method = `tsconfig-base-url:${config.baseUrlDefinedIn}`;
      return { kind: 'files', paths: [found], confidence: 1, method };
    }
  }
  return aliasMiss ? { aliasMiss } : null;
}

export function resolveEcmascript(
  index: LayoutIndex,
  tsconfigs: TsConfigIndex,
  fromPath: string,
  ref: ImportReference,
): Resolution {
  const spec = ref.specifier;
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    const base = joinPath(dirOf(fromPath), spec);
    if (base === null) return unresolved('path escapes the repository');
    const found = index.firstExisting(fileCandidates(base, TYPESCRIPT_FILE.test(fromPath)));
    return found
      ? { kind: 'files', paths: [found], confidence: 1, method: 'relative-path' }
      : unresolved('no file matches the relative path');
  }
  if (spec.startsWith('/')) return unresolved('absolute paths are not portable');
  if (spec.startsWith('node:')) return { kind: 'builtin' };

  const isBuiltin = BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0] ?? '');
  const alias = resolveAlias(index, tsconfigs, fromPath, spec, isBuiltin);
  if (alias && !('aliasMiss' in alias)) return alias;
  if (isBuiltin) return { kind: 'builtin' };

  const [name, subpath] = splitPackage(spec);
  // A package defined in this repository (a workspace) resolves to its source.
  const workspace = index.manifests.find((m) => m.ecosystem === 'npm' && m.packageName === name);
  if (workspace) {
    const packageDir = dirOf(workspace.path);
    const targets = workspace.entries[subpath] ?? [];
    const found = index.firstExisting(targets.map((target) => joinPath(packageDir, target)));
    return found
      ? { kind: 'files', paths: [found], confidence: 1, method: 'workspace-package-entry' }
      : unresolved(`workspace package ${name} has no existing entry for ${subpath}`);
  }

  const declaring = index
    .manifestsAbove(fromPath, 'npm')
    .find((manifest) => manifest.dependencies.some((dep) => dep.name === name));
  return declaring
    ? {
        kind: 'dependency',
        ecosystem: 'npm',
        name,
        manifestPath: declaring.path,
        method: 'declared-package',
      }
    : unresolved(
        alias?.aliasMiss ?? `package ${name} is not declared in any package.json above the file`,
      );
}
