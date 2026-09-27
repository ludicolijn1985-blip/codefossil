/**
 * Runtime support a manifest declares: the oldest Node.js, Python, Go or
 * Rust version the project says it runs on. Only declared constraints count —
 * a `.nvmrc` names the version developers use, not the oldest one supported.
 */

export const RUNTIMES = ['node', 'python', 'go', 'rust'] as const;
export type Runtime = (typeof RUNTIMES)[number];

export interface RuntimeConstraint {
  readonly runtime: Runtime;
  /** The constraint as written, e.g. `>=22` or `^3.10`. */
  readonly constraint: string;
}

export interface Version {
  readonly major: number;
  readonly minor: number;
}

/** A version after a lower-bound operator (`>=`, `>`, `^`, `~=`, `~`, `==`) or on its own. */
const LOWER_BOUND = /(?:^|[\s,(])(?:>=|>|\^|~=|~|==|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?/g;
/** Upper bounds (`<23`, `<=3.12`, `!=3.0`) say nothing about the oldest supported version. */
const NOT_LOWER_BOUND = /(?:<=?|!=)\s*v?\d+(?:\.(?:\d+|x|\*))*/g;

/**
 * The oldest version a constraint admits, or null when it sets no lower
 * bound. With alternatives (`^18 || ^20`) the smallest bound wins.
 */
export function minimumVersion(constraint: string): Version | null {
  let best: Version | null = null;
  for (const clause of constraint.split('||')) {
    for (const match of clause.replace(NOT_LOWER_BOUND, ' ').matchAll(LOWER_BOUND)) {
      const [, major = '', minor = ''] = match;
      const version = { major: Number(major), minor: /^\d+$/.test(minor) ? Number(minor) : 0 };
      if (!best || compareVersions(version, best) < 0) best = version;
    }
  }
  return best;
}

export function compareVersions(a: Version, b: Version): number {
  return a.major - b.major || a.minor - b.minor;
}

export function formatVersion(version: Version, runtime: Runtime): string {
  // Go and Rust releases are 1.x; the minor number is what identifies them.
  return runtime === 'go' || runtime === 'rust' || version.minor > 0
    ? `${version.major}.${version.minor}`
    : String(version.major);
}
