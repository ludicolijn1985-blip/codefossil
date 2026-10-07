import type { ImportReference } from '@codefossil/parser';
import {
  ancestors,
  dirOf,
  joinPath,
  unresolved,
  type LayoutIndex,
  type Resolution,
} from './layout.js';
import { PYTHON_IMPORT_DISTRIBUTIONS, PYTHON_STDLIB } from './python-stdlib.js';

/** Confidence when a module was found by path suffix, i.e. its source root was inferred. */
const INFERRED_ROOT_CONFIDENCE = 0.9;

/** PyPI names compare case-insensitively with `-`, `_` and `.` equivalent. */
export const normalizePythonName = (name: string): string =>
  name.toLowerCase().replace(/[-_.]+/g, '_');

/** Map of every dotted module path suffix to the files that define it. */
export class PythonModules {
  private readonly bySuffix = new Map<string, string[]>();
  /** Full dotted path from the repository root to the file. */
  private readonly fromRoot = new Map<string, string>();

  constructor(files: Iterable<string>) {
    for (const file of files) {
      if (!file.endsWith('.py')) continue;
      const parts = file.slice(0, -3).split('/');
      if (parts.at(-1) === '__init__') parts.pop();
      if (parts.length === 0) continue;
      this.fromRoot.set(parts.join('.'), file);
      for (let i = 0; i < parts.length; i++) {
        const key = parts.slice(i).join('.');
        this.bySuffix.set(key, [...(this.bySuffix.get(key) ?? []), file]);
      }
    }
  }

  /**
   * The file defining `module`: exact from the root (confidence 1), or the
   * single file whose path ends with it (source root inferred). Ambiguous
   * suffix matches resolve to nothing rather than a guess.
   */
  find(module: string): { path: string; confidence: number } | null {
    const exact = this.fromRoot.get(module);
    if (exact) return { path: exact, confidence: 1 };
    const matches = this.bySuffix.get(module) ?? [];
    return matches.length === 1 && matches[0]
      ? { path: matches[0], confidence: INFERRED_ROOT_CONFIDENCE }
      : null;
  }
}

/** `pkg/mod.py` or `pkg/mod/__init__.py` under `dir`. */
function moduleFile(index: LayoutIndex, dir: string, dotted: string): string | null {
  const base = joinPath(dir, dotted.split('.').join('/'));
  if (base === null) return null;
  return index.firstExisting([`${base}.py`, joinPath(base, '__init__.py')]);
}

function resolveRelative(index: LayoutIndex, fromPath: string, ref: ImportReference): Resolution {
  const dots = /^\.+/.exec(ref.specifier)?.[0].length ?? 0;
  const rest = ref.specifier.slice(dots);
  // One dot is the file's own package; each extra dot goes one package up.
  const dir = ancestors(dirOf(fromPath))[dots - 1];
  if (dir === undefined) return unresolved('relative import escapes the repository');

  const paths = new Set<string>();
  let namesAreAttributes = (ref.names ?? []).length === 0;
  for (const name of ref.names ?? []) {
    const submodule = moduleFile(index, dir, rest ? `${rest}.${name}` : name);
    if (submodule) paths.add(submodule);
    else namesAreAttributes = true;
  }
  if (namesAreAttributes) {
    const module = rest
      ? moduleFile(index, dir, rest)
      : index.firstExisting([joinPath(dir, '__init__.py')]);
    if (module) paths.add(module);
  }
  return paths.size > 0
    ? { kind: 'files', paths: [...paths], confidence: 1, method: 'python-relative' }
    : unresolved('no module file matches the relative import');
}

export function resolvePython(
  index: LayoutIndex,
  modules: PythonModules,
  fromPath: string,
  ref: ImportReference,
  installed: ReadonlyMap<string, readonly string[]> = new Map(),
): Resolution {
  if (ref.specifier.startsWith('.')) return resolveRelative(index, fromPath, ref);

  const found = new Map<string, number>();
  const names = ref.names ?? [];
  for (const name of names) {
    const submodule = modules.find(`${ref.specifier}.${name}`);
    if (submodule) found.set(submodule.path, submodule.confidence);
  }
  if (found.size < names.length || names.length === 0) {
    const module = modules.find(ref.specifier);
    if (module) found.set(module.path, module.confidence);
  }
  if (found.size > 0) {
    return {
      kind: 'files',
      paths: [...found.keys()],
      confidence: Math.min(...found.values()),
      method: 'python-module-path',
    };
  }

  const topLevel = ref.specifier.split('.')[0] ?? '';
  const declared = (names: readonly string[], method: string): Resolution | null => {
    const wanted = new Set(names.map(normalizePythonName));
    for (const manifest of index.manifestsAbove(fromPath, 'pypi')) {
      const dependency = manifest.dependencies.find((dep) =>
        wanted.has(normalizePythonName(dep.name)),
      );
      if (dependency) {
        return {
          kind: 'dependency',
          ecosystem: 'pypi',
          name: dependency.name,
          manifestPath: manifest.path,
          method,
        };
      }
    }
    return null;
  };

  const sameName = declared([topLevel], 'declared-distribution');
  if (sameName) return sameName;
  const installedName = installed.get(topLevel);
  const fromEnvironment = installedName
    ? declared(installedName, 'installed-distribution-import-name')
    : null;
  if (fromEnvironment) return fromEnvironment;
  const knownName = PYTHON_IMPORT_DISTRIBUTIONS[topLevel];
  const renamed = knownName ? declared(knownName, 'declared-distribution-import-name') : null;
  if (renamed) return renamed;
  if (PYTHON_STDLIB.has(topLevel)) return { kind: 'builtin' };
  return unresolved(
    'not a repository module, the standard library or a declared distribution of that import name',
  );
}
