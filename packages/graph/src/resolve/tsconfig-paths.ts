import { extendedConfigPaths, type TsConfig } from '../tsconfig.js';
import { ancestors, dirOf, joinPath } from './layout.js';

/** `compilerOptions.paths` as it applies to one config, after `extends`. */
interface EffectivePaths {
  readonly patterns: Readonly<Record<string, readonly string[]>>;
  /** The config file that declared `paths` (it may be an extended base). */
  readonly definedIn: string;
}

/** The resolution settings of one config with its `extends` chain applied. */
export interface EffectiveTsConfig {
  /** Repository directory `baseUrl` points at; null when unset or outside the repository. */
  readonly baseUrl: string | null;
  /** The config file that declared the effective `baseUrl`. */
  readonly baseUrlDefinedIn: string | null;
  readonly paths: EffectivePaths | null;
}

const EMPTY: EffectiveTsConfig = { baseUrl: null, baseUrlDefinedIn: null, paths: null };

/** Names `tsc` and editors look for when finding the config that governs a file. */
const GOVERNING_NAMES = ['tsconfig.json', 'jsconfig.json'];

export interface PathMatch {
  /** The `paths` key that matched, e.g. `@/*`. */
  readonly pattern: string;
  /** Targets with `*` substituted, in declaration order. */
  readonly targets: readonly string[];
}

/**
 * Match a specifier against `paths` the way TypeScript does: an exact key
 * wins; otherwise the wildcard pattern with the longest prefix, the first
 * declared on a tie. `*` in each target is replaced by what the wildcard matched.
 */
export function matchPaths(
  patterns: Readonly<Record<string, readonly string[]>>,
  specifier: string,
): PathMatch | null {
  const exact = patterns[specifier];
  if (exact && !specifier.includes('*')) return { pattern: specifier, targets: exact };

  let best: { pattern: string; prefix: string; suffix: string } | null = null;
  for (const pattern of Object.keys(patterns)) {
    const star = pattern.indexOf('*');
    if (star === -1) continue;
    const prefix = pattern.slice(0, star);
    const suffix = pattern.slice(star + 1);
    const fits =
      specifier.length >= prefix.length + suffix.length &&
      specifier.startsWith(prefix) &&
      specifier.endsWith(suffix);
    if (fits && (!best || prefix.length > best.prefix.length)) best = { pattern, prefix, suffix };
  }
  if (!best) return null;
  const captured = specifier.slice(best.prefix.length, specifier.length - best.suffix.length);
  return {
    pattern: best.pattern,
    targets: (patterns[best.pattern] ?? []).map((target) => target.replace('*', captured)),
  };
}

/**
 * TypeScript configuration lookups for one snapshot. The config governing a
 * file is the nearest `tsconfig.json` (or `jsconfig.json`) above it; its
 * `extends` chain is followed only through files in the repository.
 * `include`/`exclude`/`files` are not evaluated: like most bundlers, the
 * nearest config applies to every file below it.
 */
export class TsConfigIndex {
  private readonly byPath: ReadonlyMap<string, TsConfig>;
  private readonly effective = new Map<string, EffectiveTsConfig>();
  private readonly governing = new Map<string, string | null>();

  constructor(
    private readonly files: ReadonlySet<string>,
    configs: readonly TsConfig[],
  ) {
    this.byPath = new Map(configs.map((config) => [config.path, config]));
  }

  /** The governing config's path and effective settings for a file, if any. */
  forFile(
    path: string,
  ): { readonly configPath: string; readonly config: EffectiveTsConfig } | null {
    const dir = dirOf(path);
    let configPath = this.governing.get(dir);
    if (configPath === undefined) {
      configPath = this.findGoverning(dir);
      this.governing.set(dir, configPath);
    }
    if (!configPath) return null;
    let config = this.effective.get(configPath);
    if (!config) {
      // Cached per root only, so a cut `extends` cycle never depends on query order.
      config = this.resolve(configPath, new Set());
      this.effective.set(configPath, config);
    }
    return { configPath, config };
  }

  private findGoverning(dir: string): string | null {
    for (const candidateDir of ancestors(dir)) {
      for (const name of GOVERNING_NAMES) {
        const candidate = joinPath(candidateDir, name);
        if (candidate !== null && this.files.has(candidate)) return candidate;
      }
    }
    return null;
  }

  /**
   * Apply `extends` (later entries override earlier ones, the file itself
   * overrides all), resolving `baseUrl` against the file that declares it.
   * A config that is missing, unparseable or part of a cycle contributes nothing.
   */
  private resolve(path: string, visiting: Set<string>): EffectiveTsConfig {
    const config = this.byPath.get(path);
    if (!config || visiting.has(path)) return EMPTY;
    visiting.add(path);

    let result = EMPTY;
    for (const parent of extendedConfigPaths(config, this.files)) {
      const inherited = this.resolve(parent, visiting);
      result = {
        baseUrl: inherited.baseUrlDefinedIn ? inherited.baseUrl : result.baseUrl,
        baseUrlDefinedIn: inherited.baseUrlDefinedIn ?? result.baseUrlDefinedIn,
        paths: inherited.paths ?? result.paths,
      };
    }
    if (config.baseUrl !== null) {
      result = {
        ...result,
        baseUrl: joinPath(dirOf(path), config.baseUrl),
        baseUrlDefinedIn: path,
      };
    }
    if (config.paths !== null) {
      result = { ...result, paths: { patterns: config.paths, definedIn: path } };
    }

    visiting.delete(path);
    return result;
  }
}

/**
 * Where `paths` targets are resolved from: `baseUrl` when set, otherwise the
 * directory of the config that declared `paths`. Null when `baseUrl` points
 * outside the repository.
 */
export function pathsBase(config: EffectiveTsConfig): string | null {
  if (!config.paths) return null;
  if (config.baseUrlDefinedIn) return config.baseUrl;
  return dirOf(config.paths.definedIn);
}
