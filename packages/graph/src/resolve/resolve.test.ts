import { describe, expect, it } from 'vitest';
import type { ImportReference } from '@codefossil/parser';
import { parseManifest } from '../manifests.js';
import { createResolver } from './index.js';

function resolverFor(files: string[], manifests: Record<string, string> = {}) {
  return createResolver({
    files: new Set([...files, ...Object.keys(manifests)]),
    manifests: Object.entries(manifests).map(([path, content]) => parseManifest(path, content)),
  });
}

const ref = (specifier: string, kind: ImportReference['kind'] = 'import', names?: string[]) =>
  names ? { specifier, kind, names } : { specifier, kind };

describe('ECMAScript resolution', () => {
  const resolve = resolverFor(
    [
      'src/app.ts',
      'src/tax/vat.ts',
      'src/tax/index.ts',
      'src/util.js',
      'src/view.tsx',
      'packages/db/src/index.ts',
      'packages/db/src/testing.ts',
    ],
    {
      'package.json': JSON.stringify({
        dependencies: { zod: '^4' },
        devDependencies: { vitest: '^5' },
      }),
      'packages/db/package.json': JSON.stringify({
        name: '@acme/db',
        exports: {
          '.': { source: './src/index.ts', default: './dist/index.js' },
          './testing': './src/testing.ts',
        },
      }),
    },
  );

  it.each([
    ['./tax/vat.js', 'src/tax/vat.ts'], // TypeScript ESM: .js names the .ts source
    ['./tax/vat', 'src/tax/vat.ts'],
    ['./tax', 'src/tax/index.ts'],
    ['./util.js', 'src/util.js'],
    ['./view', 'src/view.tsx'],
    ['@acme/db', 'packages/db/src/index.ts'],
    ['@acme/db/testing', 'packages/db/src/testing.ts'],
  ])('%s from src/app.ts → %s', (specifier, path) => {
    expect(resolve('src/app.ts', 'typescript', ref(specifier))).toEqual({
      kind: 'files',
      paths: [path],
      confidence: 1,
      method: specifier.startsWith('@') ? 'workspace-package-entry' : 'relative-path',
    });
  });

  it('resolves directories like Node: package.json main, then index, with or without a trailing slash', () => {
    const tree = resolverFor(
      [
        'index.js',
        'lib/express.js',
        'examples/auth/index.js',
        'vendor/pkg/lib/main.js',
        'vendor/pkg/index.js',
      ],
      {
        'package.json': JSON.stringify({ name: 'express' }),
        'vendor/pkg/package.json': JSON.stringify({ main: 'lib/main.js' }),
      },
    );
    for (const specifier of ['../..', '../../', '../../index', '../../index.js']) {
      expect(tree('examples/auth/index.js', 'javascript', ref(specifier))).toMatchObject({
        kind: 'files',
        paths: ['index.js'],
      });
    }
    expect(tree('index.js', 'javascript', ref('./vendor/pkg'))).toMatchObject({
      paths: ['vendor/pkg/lib/main.js'],
    });
    expect(tree('index.js', 'javascript', ref('./vendor/pkg/'))).toMatchObject({
      paths: ['vendor/pkg/lib/main.js'],
    });
  });

  it('follows each importer’s toolchain when source and output files share a stem', () => {
    const both = resolverFor(['lib/shim.ts', 'lib/shim.js', 'lib/app.ts', 'lib/app.js']);
    // tsc maps ./shim.js to the TypeScript source…
    expect(both('lib/app.ts', 'typescript', ref('./shim.js'))).toMatchObject({
      paths: ['lib/shim.ts'],
    });
    // …while Node, running a JavaScript file, loads the literal shim.js.
    expect(both('lib/app.js', 'javascript', ref('./shim.js'))).toMatchObject({
      paths: ['lib/shim.js'],
    });
  });

  it('maps bare specifiers to the declaring manifest, including subpaths and scoped names', () => {
    expect(resolve('packages/db/src/index.ts', 'typescript', ref('zod/mini'))).toEqual({
      kind: 'dependency',
      ecosystem: 'npm',
      name: 'zod',
      manifestPath: 'package.json',
      method: 'declared-package',
    });
  });

  it('treats Node built-ins as builtin', () => {
    expect(resolve('src/app.ts', 'typescript', ref('node:fs'))).toEqual({ kind: 'builtin' });
    expect(resolve('src/app.ts', 'typescript', ref('path'))).toEqual({ kind: 'builtin' });
    expect(resolve('src/app.ts', 'typescript', ref('fs/promises'))).toEqual({ kind: 'builtin' });
  });

  it('reports what it cannot decide instead of guessing', () => {
    expect(resolve('src/app.ts', 'typescript', ref('./missing')).kind).toBe('unresolved');
    expect(resolve('src/app.ts', 'typescript', ref('../../../outside')).kind).toBe('unresolved');
    expect(resolve('src/app.ts', 'typescript', ref('left-pad')).kind).toBe('unresolved');
    expect(resolve('src/app.ts', 'typescript', ref('@acme/db/nope')).kind).toBe('unresolved');
  });
});

describe('Python resolution', () => {
  const resolve = resolverFor(
    [
      'shop/__init__.py',
      'shop/models.py',
      'shop/views.py',
      'shop/core/__init__.py',
      'shop/core/db.py',
      'src/lib/helpers.py',
      'a/util.py',
      'b/util.py',
    ],
    { 'pyproject.toml': '[project]\ndependencies = ["PyYAML", "requests"]' },
  );

  it('resolves relative imports, preferring submodules for imported names', () => {
    expect(
      resolve('shop/core/db.py', 'python', ref('..', 'from', ['models', 'views'])),
    ).toMatchObject({
      paths: ['shop/models.py', 'shop/views.py'],
      confidence: 1,
    });
    expect(resolve('shop/views.py', 'python', ref('.core.db', 'from', ['connect']))).toMatchObject({
      paths: ['shop/core/db.py'],
    });
    expect(resolve('shop/views.py', 'python', ref('.', 'from', ['something']))).toMatchObject({
      paths: ['shop/__init__.py'],
    });
  });

  it('resolves absolute module paths exactly, or by a unique suffix with lower confidence', () => {
    expect(resolve('shop/views.py', 'python', ref('shop.core.db'))).toMatchObject({
      paths: ['shop/core/db.py'],
      confidence: 1,
    });
    expect(resolve('src/app.py', 'python', ref('lib.helpers'))).toMatchObject({
      paths: ['src/lib/helpers.py'],
      confidence: 0.9,
    });
    // Two files end with util.py: ambiguous, so no edge.
    expect(resolve('main.py', 'python', ref('util')).kind).toBe('unresolved');
  });

  it('maps declared distributions by normalized name only', () => {
    expect(resolve('shop/views.py', 'python', ref('requests'))).toMatchObject({
      kind: 'dependency',
      name: 'requests',
    });
    // `yaml` is provided by PyYAML, but the names differ: not guessed.
    expect(resolve('shop/views.py', 'python', ref('yaml')).kind).toBe('unresolved');
  });
});

describe('Go resolution', () => {
  const resolve = resolverFor(
    ['main.go', 'tax/vat.go', 'tax/rates.go', 'tax/vat_test.go', 'internal/db/db.go'],
    { 'go.mod': 'module github.com/acme/shop\nrequire github.com/google/uuid v1.6.0\n' },
  );

  it('resolves module-internal packages to their non-test files', () => {
    expect(resolve('main.go', 'go', ref('github.com/acme/shop/tax'))).toEqual({
      kind: 'files',
      paths: ['tax/vat.go', 'tax/rates.go'],
      confidence: 1,
      method: 'go-module-package',
    });
  });

  it('distinguishes standard library, required modules and unknown modules', () => {
    expect(resolve('main.go', 'go', ref('net/http'))).toEqual({ kind: 'builtin' });
    expect(resolve('main.go', 'go', ref('github.com/google/uuid'))).toMatchObject({
      kind: 'dependency',
      name: 'github.com/google/uuid',
    });
    expect(resolve('main.go', 'go', ref('github.com/unknown/x')).kind).toBe('unresolved');
  });
});

describe('Rust resolution', () => {
  const resolve = resolverFor(
    ['src/lib.rs', 'src/tax.rs', 'src/tax/rates.rs', 'src/util/mod.rs', 'src/util/fmt.rs'],
    { 'Cargo.toml': '[package]\nname="shop"\n[dependencies]\nserde_json = "1"\nmy-crate = "1"\n' },
  );

  it('resolves mod declarations next to lib.rs and inside module directories', () => {
    expect(resolve('src/lib.rs', 'rust', ref('tax', 'mod'))).toMatchObject({
      paths: ['src/tax.rs'],
    });
    expect(resolve('src/lib.rs', 'rust', ref('util', 'mod'))).toMatchObject({
      paths: ['src/util/mod.rs'],
    });
    expect(resolve('src/tax.rs', 'rust', ref('rates', 'mod'))).toMatchObject({
      paths: ['src/tax/rates.rs'],
    });
  });

  it('follows crate, self and super paths to the deepest module file', () => {
    expect(resolve('src/util/fmt.rs', 'rust', ref('crate::tax::rates::Rate', 'use'))).toMatchObject(
      {
        paths: ['src/tax/rates.rs'],
      },
    );
    expect(resolve('src/util/fmt.rs', 'rust', ref('crate::Config', 'use'))).toMatchObject({
      paths: ['src/lib.rs'],
    });
    expect(resolve('src/tax.rs', 'rust', ref('self::rates', 'use'))).toMatchObject({
      paths: ['src/tax/rates.rs'],
    });
    expect(resolve('src/tax/rates.rs', 'rust', ref('super::Vat', 'use'))).toMatchObject({
      paths: ['src/tax.rs'],
    });
    // util::fmt → super → util → super → crate root → tax
    expect(resolve('src/util/fmt.rs', 'rust', ref('super::super::tax', 'use'))).toMatchObject({
      paths: ['src/tax.rs'],
      method: 'rust-super-path',
    });
    expect(resolve('src/util/mod.rs', 'rust', ref('super::tax::rates', 'use'))).toMatchObject({
      paths: ['src/tax/rates.rs'],
    });
    expect(resolve('src/util/fmt.rs', 'rust', ref('super::super::super::x', 'use')).kind).toBe(
      'unresolved',
    );
    expect(resolve('src/lib.rs', 'rust', ref('super::x', 'use')).kind).toBe('unresolved');
  });

  it('maps crates with - and _ spelled differently, and knows std', () => {
    expect(resolve('src/lib.rs', 'rust', ref('my_crate::x', 'use'))).toMatchObject({
      kind: 'dependency',
      name: 'my-crate',
    });
    expect(resolve('src/lib.rs', 'rust', ref('std::io', 'use'))).toEqual({ kind: 'builtin' });
    expect(resolve('src/lib.rs', 'rust', ref('rand::Rng', 'use')).kind).toBe('unresolved');
  });
});
