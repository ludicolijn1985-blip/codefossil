import { posix } from 'node:path';
import type { Ecosystem, Manifest } from '../manifests.js';

/** How an import was resolved. */
export type Resolution =
  | {
      readonly kind: 'files';
      /** Repository-relative target files (a Go package can be several). */
      readonly paths: readonly string[];
      readonly confidence: number;
      /** The rule that produced the result, stored in provenance. */
      readonly method: string;
    }
  | {
      readonly kind: 'dependency';
      readonly ecosystem: Ecosystem;
      readonly name: string;
      readonly manifestPath: string;
      readonly method: string;
    }
  /** Standard library or runtime built-in: not a repository or declared dependency. */
  | { readonly kind: 'builtin' }
  | { readonly kind: 'unresolved'; readonly reason: string };

export const unresolved = (reason: string): Resolution => ({ kind: 'unresolved', reason });

export interface RepositoryLayout {
  /** Every file at the snapshot, repository-relative with forward slashes. */
  readonly files: ReadonlySet<string>;
  readonly manifests: readonly Manifest[];
}

/** The directory of a repository path; `''` for the root. */
export function dirOf(path: string): string {
  const dir = posix.dirname(path);
  return dir === '.' ? '' : dir;
}

/** Join and normalize; returns null when the result escapes the repository root. */
export function joinPath(...parts: string[]): string | null {
  const joined = posix.normalize(parts.filter((p) => p !== '').join('/'));
  if (joined === '.') return '';
  if (joined.startsWith('../') || joined === '..' || posix.isAbsolute(joined)) return null;
  return joined;
}

/** `a/b/c` → `['a/b/c', 'a/b', 'a', '']`. */
export function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let current = dir; ; current = dirOf(current)) {
    out.push(current);
    if (current === '') return out;
  }
}

/** Lookups shared by the per-language resolvers, built once per snapshot. */
export class LayoutIndex {
  readonly files: ReadonlySet<string>;
  private readonly manifestsByDir = new Map<string, Manifest[]>();

  constructor(layout: RepositoryLayout) {
    this.files = layout.files;
    this.manifests = layout.manifests;
    for (const manifest of layout.manifests) {
      const dir = dirOf(manifest.path);
      this.manifestsByDir.set(dir, [...(this.manifestsByDir.get(dir) ?? []), manifest]);
    }
  }

  readonly manifests: readonly Manifest[];

  /** The first existing path among `candidates`. */
  firstExisting(candidates: readonly (string | null)[]): string | null {
    return candidates.find((c): c is string => c !== null && this.files.has(c)) ?? null;
  }

  /** Manifests of an ecosystem from the file's directory up to the root, nearest first. */
  manifestsAbove(path: string, ecosystem: Ecosystem): Manifest[] {
    return ancestors(dirOf(path)).flatMap((dir) =>
      (this.manifestsByDir.get(dir) ?? []).filter((m) => m.ecosystem === ecosystem),
    );
  }
}
