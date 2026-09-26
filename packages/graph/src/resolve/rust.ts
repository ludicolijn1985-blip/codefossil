import { posix } from 'node:path';
import type { ImportReference } from '@codefossil/parser';
import { dirOf, joinPath, unresolved, type LayoutIndex, type Resolution } from './layout.js';

const BUILTIN_CRATES = new Set(['std', 'core', 'alloc', 'proc_macro', 'test']);
/** Files whose child modules live next to them rather than in a same-named directory. */
const MODULE_ROOTS = new Set(['mod.rs', 'lib.rs', 'main.rs']);

/** Directory holding the child modules of the module defined by `file`. */
function childModuleDir(file: string): string {
  const name = posix.basename(file);
  return MODULE_ROOTS.has(name)
    ? dirOf(file)
    : `${dirOf(file)}/${name.slice(0, -3)}`.replace(/^\//, '');
}

/** `dir/name.rs` or `dir/name/mod.rs`. */
function moduleFile(index: LayoutIndex, dir: string, name: string): string | null {
  return index.firstExisting([joinPath(dir, `${name}.rs`), joinPath(dir, name, 'mod.rs')]);
}

function crateRoot(index: LayoutIndex, fromPath: string): string | null {
  const manifest = index.manifestsAbove(fromPath, 'cargo')[0];
  if (!manifest) return null;
  const dir = dirOf(manifest.path);
  return index.firstExisting([joinPath(dir, 'src/lib.rs'), joinPath(dir, 'src/main.rs')]);
}

/**
 * The module path of a file inside a crate: `src/util/fmt.rs` → `util::fmt`,
 * `src/util/mod.rs` → `util`, `src/lib.rs` → (root). Null for files outside
 * the crate's module tree (tests, examples, `src/bin`).
 */
function modulePath(root: string, file: string): string[] | null {
  if (file === root) return [];
  const srcDir = dirOf(root);
  const prefix = srcDir === '' ? '' : `${srcDir}/`;
  if (!file.startsWith(prefix) || !file.endsWith('.rs')) return null;
  const segments = file.slice(prefix.length, -3).split('/');
  if (segments[0] === 'bin') return null;
  return segments.at(-1) === 'mod' ? segments.slice(0, -1) : segments;
}

/**
 * Resolve an absolute module path from the crate root to the deepest module
 * file that exists. The last segments of a `use` are usually items rather
 * than modules, so the file of the deepest module found is the target. The
 * `base` modules (from `self`/`super`) must exist; only `rest` may be items.
 */
function resolveModulePath(
  index: LayoutIndex,
  root: string,
  base: readonly string[],
  rest: readonly string[],
): string | null {
  let file = root;
  let dir = dirOf(root);
  let depth = 0;
  for (const segment of [...base, ...rest]) {
    const next = moduleFile(index, dir, segment);
    if (!next) break;
    file = next;
    dir = childModuleDir(next);
    depth++;
  }
  return depth >= base.length ? file : null;
}

/** `use crate::…`, `self::…` and `super::super::…` paths. */
function resolveRelativeUse(
  index: LayoutIndex,
  fromPath: string,
  segments: readonly string[],
): Resolution {
  const root = crateRoot(index, fromPath);
  if (!root) return unresolved('no crate root (src/lib.rs or src/main.rs) found');
  const own = modulePath(root, fromPath);
  if (own === null) return unresolved('file is not part of the crate module tree');

  let base: readonly string[];
  let rest = segments;
  if (segments[0] === 'crate') {
    base = [];
    rest = segments.slice(1);
  } else {
    let ups = 0;
    while (rest[ups] === 'super') ups++;
    if (ups === 0) {
      base = own; // self::
      rest = segments.slice(1);
    } else {
      if (ups > own.length) return unresolved('super:: goes above the crate root');
      base = own.slice(0, own.length - ups);
      rest = segments.slice(ups);
    }
  }
  const target = resolveModulePath(index, root, base, rest);
  return target
    ? { kind: 'files', paths: [target], confidence: 1, method: `rust-${segments[0] ?? ''}-path` }
    : unresolved(`no module file for ${segments.join('::')}`);
}

export function resolveRust(
  index: LayoutIndex,
  fromPath: string,
  ref: ImportReference,
): Resolution {
  if (ref.kind === 'mod') {
    const file = moduleFile(index, childModuleDir(fromPath), ref.specifier);
    return file
      ? { kind: 'files', paths: [file], confidence: 1, method: 'rust-mod-declaration' }
      : unresolved(`no file for module ${ref.specifier}`);
  }

  const segments = ref.specifier.split('::');
  const first = segments[0] ?? '';
  if (first === 'crate' || first === 'self' || first === 'super') {
    return resolveRelativeUse(index, fromPath, segments);
  }
  if (BUILTIN_CRATES.has(first)) return { kind: 'builtin' };

  // Crate names use `-` in Cargo.toml and `_` in code.
  const declaring = index
    .manifestsAbove(fromPath, 'cargo')
    .find((m) => m.dependencies.some((dep) => dep.name.replaceAll('-', '_') === first));
  const dependency = declaring?.dependencies.find((dep) => dep.name.replaceAll('-', '_') === first);
  return declaring && dependency
    ? {
        kind: 'dependency',
        ecosystem: 'cargo',
        name: dependency.name,
        manifestPath: declaring.path,
        method: 'declared-crate',
      }
    : unresolved(`crate ${first} is not declared in Cargo.toml`);
}
