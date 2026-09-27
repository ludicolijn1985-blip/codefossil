import { parse as parseToml } from 'smol-toml';
import type { RuntimeConstraint } from './runtime.js';

export type Ecosystem = 'npm' | 'go' | 'cargo' | 'pypi';
export type DependencyScope = 'runtime' | 'dev' | 'peer' | 'optional' | 'build';

export interface ManifestDependency {
  readonly ecosystem: Ecosystem;
  readonly name: string;
  /** Version constraint as written, or null when none is given. */
  readonly version: string | null;
  readonly scope: DependencyScope;
}

export interface Manifest {
  /** Repository-relative path of the manifest file. */
  readonly path: string;
  readonly ecosystem: Ecosystem;
  /** The package this manifest defines: npm name, Go module path, crate or project name. */
  readonly packageName: string | null;
  readonly dependencies: readonly ManifestDependency[];
  /**
   * npm only: candidate entry files per export subpath (`.`, `./testing`),
   * relative to the manifest's directory, in resolution order.
   */
  readonly entries: Readonly<Record<string, readonly string[]>>;
  /** Runtime versions the manifest declares support for (`engines.node`, `requires-python`, …). */
  readonly runtimes: readonly RuntimeConstraint[];
}

export class ManifestParseError extends Error {
  override readonly name = 'ManifestParseError';
}

type Parser = (path: string, content: string) => Manifest;

const REQUIREMENTS_FILE = /(^|\/)requirements[^/]*\.txt$/;

/** The parser for a manifest file, or null when `path` is not a manifest CODEFOSSIL reads. */
function parserFor(path: string): Parser | null {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (name === 'package.json') return parsePackageJson;
  if (name === 'go.mod') return parseGoMod;
  if (name === 'Cargo.toml') return parseCargoToml;
  if (name === 'pyproject.toml') return parsePyproject;
  if (REQUIREMENTS_FILE.test(path)) return parseRequirements;
  return null;
}

export function isManifestPath(path: string): boolean {
  // Vendored dependencies carry their own manifests, which do not describe this repository.
  if (/(^|\/)(node_modules|vendor)\//.test(path)) return false;
  return parserFor(path) !== null;
}

/** Parse a manifest. Throws ManifestParseError when its content is invalid. */
export function parseManifest(path: string, content: string): Manifest {
  const parser = parserFor(path);
  if (!parser) throw new ManifestParseError(`${path} is not a supported manifest`);
  try {
    return parser(path, content);
  } catch (error) {
    if (error instanceof ManifestParseError) throw error;
    const detail = error instanceof Error ? error.message : String(error);
    throw new ManifestParseError(`Cannot parse ${path}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// npm

const NPM_SCOPES: readonly (readonly [string, DependencyScope])[] = [
  ['dependencies', 'runtime'],
  ['devDependencies', 'dev'],
  ['peerDependencies', 'peer'],
  ['optionalDependencies', 'optional'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** All string leaves of an `exports` value, in declaration order (conditions first to last). */
function exportTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(exportTargets);
  if (isRecord(value)) return Object.values(value).flatMap(exportTargets);
  return [];
}

function packageEntries(json: Record<string, unknown>): Record<string, string[]> {
  const entries: Record<string, string[]> = {};
  const { exports } = json;
  const isSubpathMap = isRecord(exports) && Object.keys(exports).some((key) => key.startsWith('.'));
  if (isSubpathMap) {
    for (const [subpath, target] of Object.entries(exports)) {
      if (subpath.startsWith('.')) entries[subpath] = exportTargets(target);
    }
  } else if (exports !== undefined) {
    entries['.'] = exportTargets(exports);
  }
  const legacy = ['types', 'module', 'main']
    .map((field) => json[field])
    .filter((value): value is string => typeof value === 'string');
  entries['.'] = [...(entries['.'] ?? []), ...legacy];
  return entries;
}

function parsePackageJson(path: string, content: string): Manifest {
  const json: unknown = JSON.parse(content);
  if (!isRecord(json)) throw new ManifestParseError(`${path} is not a JSON object`);
  const dependencies = NPM_SCOPES.flatMap(([field, scope]) => {
    const section = json[field];
    if (!isRecord(section)) return [];
    return Object.entries(section).map(([name, version]) => ({
      ecosystem: 'npm' as const,
      name,
      version: typeof version === 'string' ? version : null,
      scope,
    }));
  });
  return {
    path,
    ecosystem: 'npm',
    packageName: typeof json.name === 'string' ? json.name : null,
    dependencies,
    entries: packageEntries(json),
    runtimes:
      isRecord(json.engines) && typeof json.engines.node === 'string'
        ? [{ runtime: 'node', constraint: json.engines.node }]
        : [],
  };
}

// ---------------------------------------------------------------------------
// Go

function parseGoMod(path: string, content: string): Manifest {
  const lines = content.split('\n').map((line) => line.replace(/\/\/.*$/, '').trim());
  let packageName: string | null = null;
  const dependencies: ManifestDependency[] = [];
  const runtimes: RuntimeConstraint[] = [];
  let inRequireBlock = false;
  const addRequire = (spec: string) => {
    const [name, version] = spec.split(/\s+/);
    if (name)
      dependencies.push({ ecosystem: 'go', name, version: version ?? null, scope: 'runtime' });
  };

  for (const line of lines) {
    if (inRequireBlock) {
      if (line === ')') inRequireBlock = false;
      else if (line) addRequire(line);
      continue;
    }
    const module = /^module\s+(\S+)/.exec(line);
    if (module?.[1]) packageName = module[1].replace(/^"|"$/g, '');
    // The `go` directive is the minimum Go version the module supports.
    const go = /^go\s+(\d+\.\d+(?:\.\d+)?)$/.exec(line);
    if (go?.[1]) runtimes.push({ runtime: 'go', constraint: `>=${go[1]}` });
    if (/^require\s*\($/.test(line)) inRequireBlock = true;
    else if (line.startsWith('require ')) addRequire(line.slice('require '.length).trim());
  }
  return { path, ecosystem: 'go', packageName, dependencies, entries: {}, runtimes };
}

// ---------------------------------------------------------------------------
// Cargo

const CARGO_SCOPES: readonly (readonly [string, DependencyScope])[] = [
  ['dependencies', 'runtime'],
  ['dev-dependencies', 'dev'],
  ['build-dependencies', 'build'],
];

function cargoTable(table: unknown): ManifestDependency[] {
  if (!isRecord(table)) return [];
  return CARGO_SCOPES.flatMap(([key, scope]) => {
    const section = table[key];
    if (!isRecord(section)) return [];
    return Object.entries(section).map(([name, spec]) => {
      const version =
        typeof spec === 'string'
          ? spec
          : isRecord(spec) && typeof spec.version === 'string'
            ? spec.version
            : null;
      const optional = isRecord(spec) && spec.optional === true;
      return { ecosystem: 'cargo' as const, name, version, scope: optional ? 'optional' : scope };
    });
  });
}

function parseCargoToml(path: string, content: string): Manifest {
  const toml = parseToml(content);
  const pkg = toml.package;
  const targets = isRecord(toml.target) ? Object.values(toml.target) : [];
  const dependencies = [...cargoTable(toml), ...targets.flatMap(cargoTable)];
  return {
    path,
    ecosystem: 'cargo',
    packageName: isRecord(pkg) && typeof pkg.name === 'string' ? pkg.name : null,
    dependencies,
    entries: {},
    runtimes:
      isRecord(pkg) && typeof pkg['rust-version'] === 'string'
        ? [{ runtime: 'rust', constraint: `>=${pkg['rust-version']}` }]
        : [],
  };
}

// ---------------------------------------------------------------------------
// Python

/** PEP 508: `name[extras] (version) ; marker`. */
const REQUIREMENT = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*([^;]*)/;

function requirement(spec: string, scope: DependencyScope): ManifestDependency | null {
  const match = REQUIREMENT.exec(spec.trim());
  if (!match?.[1]) return null;
  const version = (match[2] ?? '').replace(/[()]/g, '').trim();
  return { ecosystem: 'pypi', name: match[1], version: version || null, scope };
}

function requirementList(value: unknown, scope: DependencyScope): ManifestDependency[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((spec) => {
    const dep = typeof spec === 'string' ? requirement(spec, scope) : null;
    return dep ? [dep] : [];
  });
}

function poetryTable(value: unknown, scope: DependencyScope): ManifestDependency[] {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([name]) => name.toLowerCase() !== 'python')
    .map(([name, spec]) => ({
      ecosystem: 'pypi' as const,
      name,
      version:
        typeof spec === 'string'
          ? spec
          : isRecord(spec) && typeof spec.version === 'string'
            ? spec.version
            : null,
      scope,
    }));
}

function parsePyproject(path: string, content: string): Manifest {
  const toml = parseToml(content);
  const project = isRecord(toml.project) ? toml.project : {};
  const poetry = isRecord(toml.tool) && isRecord(toml.tool.poetry) ? toml.tool.poetry : {};
  const optional = isRecord(project['optional-dependencies'])
    ? Object.values(project['optional-dependencies'])
    : [];
  const groups = isRecord(toml['dependency-groups'])
    ? Object.values(toml['dependency-groups'])
    : [];
  const poetryGroups = isRecord(poetry.group) ? Object.values(poetry.group) : [];
  const dependencies = [
    ...requirementList(project.dependencies, 'runtime'),
    ...optional.flatMap((list) => requirementList(list, 'optional')),
    ...groups.flatMap((list) => requirementList(list, 'dev')),
    ...poetryTable(poetry.dependencies, 'runtime'),
    ...poetryTable(poetry['dev-dependencies'], 'dev'),
    ...poetryGroups.flatMap((group) =>
      poetryTable(isRecord(group) ? group.dependencies : null, 'dev'),
    ),
  ];
  const name =
    typeof project.name === 'string'
      ? project.name
      : typeof poetry.name === 'string'
        ? poetry.name
        : null;
  const poetryPython = isRecord(poetry.dependencies) ? poetry.dependencies.python : undefined;
  const python =
    typeof project['requires-python'] === 'string'
      ? project['requires-python']
      : typeof poetryPython === 'string'
        ? poetryPython
        : null;
  return {
    path,
    ecosystem: 'pypi',
    packageName: name,
    dependencies,
    entries: {},
    runtimes: python ? [{ runtime: 'python', constraint: python }] : [],
  };
}

function parseRequirements(path: string, content: string): Manifest {
  const scope: DependencyScope = /(dev|test|lint|doc)/i.test(path) ? 'dev' : 'runtime';
  const dependencies = content
    .split('\n')
    .map((line) => line.replace(/(^|\s)#.*$/, '').trim())
    // Options (-r, -e, --index-url) and direct URLs are not named requirements.
    .filter((line) => line && !line.startsWith('-') && !/^[a-z+]+:\/\//i.test(line))
    .flatMap((line) => {
      const dep = requirement(line, scope);
      return dep ? [dep] : [];
    });
  return { path, ecosystem: 'pypi', packageName: null, dependencies, entries: {}, runtimes: [] };
}
