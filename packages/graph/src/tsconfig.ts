import { posix } from 'node:path';

/**
 * The parts of a `tsconfig.json` (or `jsconfig.json`) that decide how
 * imports resolve. Values are kept as written; relative paths are resolved
 * against the file's directory when the effective configuration is built.
 */
export interface TsConfig {
  /** Repository-relative path of the config file. */
  readonly path: string;
  /** `extends` entries in declaration order (a string or, since TS 5.0, an array). */
  readonly extends: readonly string[];
  readonly baseUrl: string | null;
  /** `compilerOptions.paths`: pattern → substitution targets, in declaration order. */
  readonly paths: Readonly<Record<string, readonly string[]>> | null;
}

export class TsConfigParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TsConfigParseError';
  }
}

const CONFIG_FILE = /^(?:[tj]sconfig(?:\..+)?\.json)$/;

/**
 * Files read as TypeScript configuration: `tsconfig.json`, `jsconfig.json` and
 * the common `tsconfig.<variant>.json` bases. Other files named by `extends`
 * are read on demand, see {@link extendedConfigPaths}.
 */
export function isTsConfigPath(path: string): boolean {
  return CONFIG_FILE.test(posix.basename(path));
}

/** The index just past the JSON string literal starting at `start`. */
function stringEnd(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
  return i + 1;
}

function stripComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += text.charAt(i);
      i++;
    }
  }
  return out;
}

function stripTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = stringEnd(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text[i] === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text.charAt(j))) j++;
      if (text[j] === '}' || text[j] === ']') {
        i++;
        continue;
      }
    }
    out += text.charAt(i);
    i++;
  }
  return out;
}

/**
 * Remove comments and trailing commas, which `tsconfig.json` allows, leaving
 * string contents untouched so the result parses with `JSON.parse`.
 */
export function stripJsonComments(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function parsePaths(value: unknown): Record<string, string[]> | null {
  if (!isRecord(value)) return null;
  const paths: Record<string, string[]> = {};
  for (const [pattern, targets] of Object.entries(value)) {
    // TypeScript rejects patterns with more than one `*`; so do we.
    if (pattern.split('*').length > 2) continue;
    paths[pattern] = stringList(targets).filter((t) => t.split('*').length <= 2);
  }
  return paths;
}

const BYTE_ORDER_MARK = 0xfeff;

function withoutBom(content: string): string {
  return content.charCodeAt(0) === BYTE_ORDER_MARK ? content.slice(1) : content;
}

/** Parse a tsconfig tolerantly: comments, trailing commas and a BOM are accepted. */
export function parseTsConfig(path: string, content: string): TsConfig {
  let json: unknown;
  try {
    json = JSON.parse(stripJsonComments(withoutBom(content)));
  } catch (error) {
    throw new TsConfigParseError(
      `${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(json)) throw new TsConfigParseError(`${path} is not a JSON object`);
  const options = isRecord(json.compilerOptions) ? json.compilerOptions : {};
  return {
    path,
    extends: stringList(json.extends),
    baseUrl: typeof options.baseUrl === 'string' ? options.baseUrl : null,
    paths: parsePaths(options.paths),
  };
}

/**
 * The repository path an `extends` entry points at, or null when it names
 * something outside the repository (a package in `node_modules`, an absolute
 * path, or a path escaping the root) or a file that does not exist.
 * Like `tsc`, `./base` also finds `./base.json`.
 */
export function resolveExtends(
  configPath: string,
  entry: string,
  files: ReadonlySet<string>,
): string | null {
  if (!entry.startsWith('./') && !entry.startsWith('../')) return null;
  const dir = posix.dirname(configPath);
  const joined = posix.normalize(posix.join(dir, entry));
  if (joined.startsWith('../') || joined === '..' || posix.isAbsolute(joined)) return null;
  if (files.has(joined)) return joined;
  const withJson = `${joined}.json`;
  return !joined.endsWith('.json') && files.has(withJson) ? withJson : null;
}

/** Repository config files that `config` extends. */
export function extendedConfigPaths(config: TsConfig, files: ReadonlySet<string>): string[] {
  return config.extends.flatMap((entry) => resolveExtends(config.path, entry, files) ?? []);
}
