import { describe, expect, it } from 'vitest';
import { isManifestPath, ManifestParseError, parseManifest } from './manifests.js';

const names = (path: string, content: string) =>
  parseManifest(path, content).dependencies.map((d) => `${d.scope}:${d.name}@${d.version ?? '-'}`);

describe('isManifestPath', () => {
  it.each([
    ['package.json', true],
    ['packages/db/package.json', true],
    ['go.mod', true],
    ['crates/core/Cargo.toml', true],
    ['pyproject.toml', true],
    ['requirements-dev.txt', true],
    ['node_modules/zod/package.json', false],
    ['vendor/github.com/x/go.mod', false],
    ['tsconfig.json', false],
  ])('%s → %s', (path, expected) => {
    expect(isManifestPath(path)).toBe(expected);
  });
});

describe('package.json', () => {
  it('reads name, dependencies by scope and export entries', () => {
    const manifest = parseManifest(
      'packages/db/package.json',
      JSON.stringify({
        name: '@acme/db',
        main: './dist/index.js',
        exports: {
          '.': { source: './src/index.ts', types: './dist/index.d.ts', default: './dist/index.js' },
          './testing': './src/testing.ts',
        },
        dependencies: { zod: '^4.0.0' },
        devDependencies: { vitest: '^5.0.0' },
        peerDependencies: { react: '>=18' },
        optionalDependencies: { fsevents: '*' },
      }),
    );
    expect(manifest).toMatchObject({ ecosystem: 'npm', packageName: '@acme/db' });
    expect(manifest.entries).toEqual({
      '.': ['./src/index.ts', './dist/index.d.ts', './dist/index.js', './dist/index.js'],
      './testing': ['./src/testing.ts'],
    });
    expect(manifest.dependencies.map((d) => `${d.scope}:${d.name}`)).toEqual([
      'runtime:zod',
      'dev:vitest',
      'peer:react',
      'optional:fsevents',
    ]);
  });

  it('accepts a plain string export', () => {
    expect(parseManifest('package.json', '{"exports":"./index.js"}').entries).toEqual({
      '.': ['./index.js'],
    });
  });

  it('rejects invalid JSON with a ManifestParseError', () => {
    expect(() => parseManifest('package.json', '{ nope')).toThrow(ManifestParseError);
    expect(() => parseManifest('package.json', '[]')).toThrow(ManifestParseError);
  });
});

describe('go.mod', () => {
  it('reads the module path and single and grouped requires', () => {
    const content = [
      'module github.com/acme/shop // the shop',
      '',
      'go 1.22',
      'require github.com/google/uuid v1.6.0',
      'require (',
      '\tgithub.com/sirupsen/logrus v1.9.3 // indirect',
      '\tgolang.org/x/text v0.14.0',
      ')',
      'replace example.com/x => ../x',
    ].join('\n');
    expect(parseManifest('go.mod', content).packageName).toBe('github.com/acme/shop');
    expect(names('go.mod', content)).toEqual([
      'runtime:github.com/google/uuid@v1.6.0',
      'runtime:github.com/sirupsen/logrus@v1.9.3',
      'runtime:golang.org/x/text@v0.14.0',
    ]);
  });
});

describe('Cargo.toml', () => {
  it('reads package name and dependency tables, including target-specific ones', () => {
    const content = [
      '[package]',
      'name = "shop"',
      '[dependencies]',
      'serde = { version = "1", features = ["derive"] }',
      'tokio = "1.37"',
      'local = { path = "../local" }',
      'fancy = { version = "0.2", optional = true }',
      '[dev-dependencies]',
      'proptest = "1"',
      '[build-dependencies]',
      'cc = "1"',
      "[target.'cfg(windows)'.dependencies]",
      'winapi = "0.3"',
    ].join('\n');
    expect(parseManifest('Cargo.toml', content).packageName).toBe('shop');
    expect(names('Cargo.toml', content)).toEqual([
      'runtime:serde@1',
      'runtime:tokio@1.37',
      'runtime:local@-',
      'optional:fancy@0.2',
      'dev:proptest@1',
      'build:cc@1',
      'runtime:winapi@0.3',
    ]);
  });

  it('rejects invalid TOML', () => {
    expect(() => parseManifest('Cargo.toml', '[package\nname=')).toThrow(ManifestParseError);
  });
});

describe('Python manifests', () => {
  it('reads PEP 621, optional, dependency groups and Poetry tables', () => {
    const content = [
      '[project]',
      'name = "shop"',
      'dependencies = ["requests>=2.31", "PyYAML (==6.0)", "rich[jupyter]; python_version > \'3.8\'"]',
      '[project.optional-dependencies]',
      'pg = ["psycopg"]',
      '[dependency-groups]',
      'dev = ["pytest"]',
      '[tool.poetry.dependencies]',
      'python = "^3.12"',
      'httpx = "^0.27"',
      '[tool.poetry.group.lint.dependencies]',
      'ruff = { version = "0.5" }',
    ].join('\n');
    expect(names('pyproject.toml', content)).toEqual([
      'runtime:requests@>=2.31',
      'runtime:PyYAML@==6.0',
      'runtime:rich@-',
      'optional:psycopg@-',
      'dev:pytest@-',
      'runtime:httpx@^0.27',
      'dev:ruff@0.5',
    ]);
  });

  it('reads requirements files, skipping options, URLs and comments', () => {
    const content = [
      '# pinned',
      'Django==5.0  # web',
      '-r base.txt',
      '-e git+https://github.com/x/y.git#egg=y',
      'https://example.com/pkg.whl',
      'numpy',
      '',
    ].join('\n');
    expect(names('requirements.txt', content)).toEqual(['runtime:Django@==5.0', 'runtime:numpy@-']);
    expect(names('requirements-dev.txt', 'pytest\n')).toEqual(['dev:pytest@-']);
  });
});
