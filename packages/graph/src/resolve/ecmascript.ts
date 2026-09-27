import { builtinModules } from 'node:module';
import type { ImportReference } from '@codefossil/parser';
import { dirOf, joinPath, unresolved, type LayoutIndex, type Resolution } from './layout.js';

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
function fileCandidates(index: LayoutIndex, base: string, importerIsTypeScript: boolean): string[] {
  const extension = /\.[cm]?jsx?$/.exec(base)?.[0];
  const stem = extension ? base.slice(0, -extension.length) : base;
  const sourceSwaps =
    extension && importerIsTypeScript
      ? (SOURCE_FOR_OUTPUT[extension] ?? []).map((ext) => stem + ext)
      : [];
  // A directory resolves like Node does: its package.json entry, then index.*.
  const directory = base === '' ? '' : `${base}/`;
  const manifest = index.manifests.find(
    (m) => m.ecosystem === 'npm' && m.path === `${directory}package.json`,
  );
  const packageEntries = (manifest?.entries['.'] ?? []).flatMap((target) => {
    const path = joinPath(base, target);
    return path === null ? [] : [path, ...EXTENSIONS.map((ext) => path + ext)];
  });
  return [
    ...sourceSwaps,
    ...(base === '' ? [] : [base, ...EXTENSIONS.map((ext) => base + ext)]),
    ...packageEntries,
    ...EXTENSIONS.map((ext) => `${directory}index${ext}`),
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

export function resolveEcmascript(
  index: LayoutIndex,
  fromPath: string,
  ref: ImportReference,
): Resolution {
  const spec = ref.specifier;
  if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
    const base = joinPath(dirOf(fromPath), spec);
    if (base === null) return unresolved('path escapes the repository');
    const found = index.firstExisting(fileCandidates(index, base, TYPESCRIPT_FILE.test(fromPath)));
    return found
      ? { kind: 'files', paths: [found], confidence: 1, method: 'relative-path' }
      : unresolved('no file matches the relative path');
  }
  if (spec.startsWith('/')) return unresolved('absolute paths are not portable');
  if (spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0] ?? '')) {
    return { kind: 'builtin' };
  }

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
    : unresolved(`package ${name} is not declared in any package.json above the file`);
}
