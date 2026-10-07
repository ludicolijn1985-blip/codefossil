import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, relative, sep } from 'node:path';
import type { TsConfig } from '@codefossil/graph';

/**
 * What is installed in the working tree (not in git): packages in
 * `node_modules` and a Python virtual environment. Read only to explain names
 * that the committed files leave open, never as history.
 */

/** A repository-relative path for an absolute one, or null when it lies outside the root. */
function insideRoot(root: string, absolute: string): string | null {
  const path = relative(realpathSync(root), absolute);
  if (path === '' || isAbsolute(path)) return null;
  const parts = path.split(sep);
  return parts[0] === '..' ? null : parts.join('/');
}

/**
 * The working tree is untrusted (a repository can commit a `.venv` or a
 * `node_modules`): every read here fails soft, follows no link out of the
 * repository, and is bounded.
 */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Whether `path` (after following links) is still inside the repository. */
function staysInside(root: string, path: string): boolean {
  try {
    return insideRoot(root, realpathSync(path)) !== null;
  } catch {
    return false;
  }
}

/** Directory entries, at most `limit`; none when the directory cannot be listed. */
function listDirectory(path: string, limit: number): string[] {
  try {
    return readdirSync(path).slice(0, limit);
  } catch {
    return [];
  }
}

/** Largest metadata file read (`top_level.txt`, `RECORD`); real ones are far smaller. */
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

/** A small text file's content, or null when it is missing, too large or unreadable. */
function readSmallText(path: string): string | null {
  try {
    const info = statSync(path);
    if (!info.isFile() || info.size > MAX_METADATA_BYTES) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** `@scope/name/sub/path` or `name/sub` — no relative, absolute or parent segments. */
const PACKAGE_SPECIFIER = /^(?:@[\w.-]+\/)?[\w.-]+(?:\/[\w.-]+)*$/;

/**
 * The repository file a package `extends` entry (`"@repo/tsconfig/base.json"`)
 * names, resolved like Node through `node_modules` from the config's
 * directory up to the root. Workspace packages are symlinks into the
 * repository, so their configs count; a package installed from a registry
 * lies outside it and stays unread (null).
 */
export function packageConfigPath(root: string, configPath: string, entry: string): string | null {
  if (!PACKAGE_SPECIFIER.test(entry) || entry.split('/').some((part) => part === '..')) {
    return null;
  }
  for (let dir = dirname(join(root, configPath)); ; dir = dirname(dir)) {
    const base = join(dir, 'node_modules', ...entry.split('/'));
    for (const candidate of [base, `${base}.json`, join(base, 'tsconfig.json')]) {
      if (!isFile(candidate)) continue;
      try {
        return insideRoot(root, realpathSync(candidate));
      } catch {
        return null;
      }
    }
    if (relative(root, dir) === '' || dirname(dir) === dir) return null;
  }
}

/** A config whose package `extends` entries are rewritten to the repository files they name. */
export function withPackageExtends(root: string, config: TsConfig): TsConfig {
  const rewritten = config.extends.map((entry) => {
    if (entry.startsWith('./') || entry.startsWith('../')) return entry;
    const target = packageConfigPath(root, config.path, entry);
    if (!target) return entry;
    const path = posix.relative(posix.dirname(config.path), target);
    return path.startsWith('../') ? path : `./${path}`;
  });
  return { ...config, extends: rewritten };
}

/** Where virtual environments usually live, relative to the root. */
const VIRTUAL_ENVIRONMENTS = ['.venv', 'venv', 'env'];
/** Distributions read at most; a real environment has far fewer. */
const MAX_DISTRIBUTIONS = 5000;

/** `site-packages` directories of a virtual environment (Unix `lib/pythonX.Y`, Windows `Lib`). */
function sitePackages(root: string, venv: string): string[] {
  const lib = join(venv, 'lib');
  const candidates = [
    join(venv, 'Lib', 'site-packages'),
    ...listDirectory(lib, 64)
      .filter((entry) => /^python\d/.test(entry))
      .map((entry) => join(lib, entry, 'site-packages')),
  ];
  return candidates.filter((dir) => isDirectory(dir) && staysInside(root, dir));
}

/** Import names a distribution provides: `top_level.txt`, else the top entries of `RECORD`. */
function importNames(distInfo: string): string[] {
  const topLevel = readSmallText(join(distInfo, 'top_level.txt'));
  if (topLevel !== null) {
    return topLevel
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^[A-Za-z_][\w]*$/.test(line));
  }
  const record = readSmallText(join(distInfo, 'RECORD'));
  if (record === null) return [];
  const names = new Set<string>();
  for (const line of record.split(/\r?\n/)) {
    const path = line.split(',')[0] ?? '';
    const top = path.split('/')[0] ?? '';
    const name = top.endsWith('.py') ? top.slice(0, -3) : path.includes('/') ? top : '';
    if (/^[A-Za-z_][\w]*$/.test(name) && !top.includes('.dist-info')) names.add(name);
  }
  return [...names];
}

/**
 * Import names provided by the distributions installed in the repository's
 * virtual environment (`yaml` → `PyYAML`), read from their `*.dist-info`.
 * Empty when there is no environment.
 */
export function installedPythonImports(root: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  let read = 0;
  for (const name of VIRTUAL_ENVIRONMENTS) {
    const venv = join(root, name);
    if (!isDirectory(venv) || !staysInside(root, venv) || !isFile(join(venv, 'pyvenv.cfg'))) {
      continue;
    }
    for (const site of sitePackages(root, venv)) {
      for (const entry of listDirectory(site, MAX_DISTRIBUTIONS * 4)) {
        const match = /^(.+?)-[^-]+\.dist-info$/.exec(entry);
        if (!match?.[1] || read++ >= MAX_DISTRIBUTIONS) continue;
        const distInfo = join(site, entry);
        if (!isDirectory(distInfo) || !staysInside(root, distInfo)) continue;
        const distribution = match[1];
        for (const importName of importNames(distInfo)) {
          const known = result.get(importName) ?? [];
          if (!known.includes(distribution)) result.set(importName, [...known, distribution]);
        }
      }
    }
  }
  return result;
}
