import { describe, expect, it } from 'vitest';
import type { ImportReference } from '@codefossil/parser';
import { parseManifest } from '../manifests.js';
import { parseTsConfig } from '../tsconfig.js';
import { createResolver, matchPaths } from './index.js';

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

describe('matchPaths', () => {
  const patterns = {
    '@/*': ['./*'],
    '@/lib/*': ['./src/lib/*', './vendor/*'],
    '*.css': ['./styles/*.css'],
    config: ['./config/index.ts'],
    'config/*': ['./config/*'],
  };

  it('prefers an exact key over wildcard patterns', () => {
    expect(matchPaths(patterns, 'config')).toEqual({
      pattern: 'config',
      targets: ['./config/index.ts'],
    });
  });

  it('picks the wildcard pattern with the longest prefix and substitutes every target', () => {
    expect(matchPaths(patterns, '@/lib/api')).toEqual({
      pattern: '@/lib/*',
      targets: ['./src/lib/api', './vendor/api'],
    });
    expect(matchPaths(patterns, '@/app/page')).toEqual({
      pattern: '@/*',
      targets: ['./app/page'],
    });
  });

  it('matches suffixes and captures the empty string', () => {
    expect(matchPaths(patterns, 'theme.css')).toEqual({
      pattern: '*.css',
      targets: ['./styles/theme.css'],
    });
    expect(matchPaths(patterns, 'config/')).toMatchObject({ targets: ['./config/'] });
    expect(matchPaths(patterns, 'zod')).toBeNull();
  });

  it('breaks ties between equally long prefixes by declaration order', () => {
    expect(matchPaths({ 'a*': ['first/*'], 'a*z': ['second/*'] }, 'abz')).toMatchObject({
      pattern: 'a*',
    });
  });
});

describe('TypeScript paths and baseUrl', () => {
  function resolverWithConfigs(
    files: string[],
    configs: Record<string, object>,
    manifests: Record<string, string> = {},
  ) {
    return createResolver({
      files: new Set([...files, ...Object.keys(configs), ...Object.keys(manifests)]),
      manifests: Object.entries(manifests).map(([path, content]) => parseManifest(path, content)),
      tsconfigs: Object.entries(configs).map(([path, json]) =>
        parseTsConfig(path, JSON.stringify(json)),
      ),
    });
  }

  const resolve = resolverWithConfigs(
    [
      'apps/web/app/page.tsx',
      'apps/web/lib/api.ts',
      'apps/web/lib/format.ts',
      'apps/web/components/card.tsx',
      'apps/web/scripts/build.js',
      'apps/api/src/server.ts',
    ],
    {
      'tsconfig.base.json': { compilerOptions: { strict: true } },
      'apps/web/tsconfig.json': {
        extends: '../../tsconfig.base.json',
        compilerOptions: { paths: { '@/*': ['./*'] } },
      },
    },
    {
      'apps/web/package.json': JSON.stringify({ dependencies: { next: '^16' } }),
    },
  );

  it('resolves an alias to a file relative to the config that declares paths', () => {
    expect(resolve('apps/web/app/page.tsx', 'tsx', ref('@/lib/api'))).toEqual({
      kind: 'files',
      paths: ['apps/web/lib/api.ts'],
      confidence: 1,
      method: 'tsconfig-paths:apps/web/tsconfig.json#@/*',
    });
    expect(resolve('apps/web/app/page.tsx', 'tsx', ref('@/components/card'))).toMatchObject({
      paths: ['apps/web/components/card.tsx'],
    });
  });

  it('keeps the .js → .ts source mapping for TypeScript importers only', () => {
    expect(resolve('apps/web/app/page.tsx', 'tsx', ref('@/lib/format.js'))).toMatchObject({
      paths: ['apps/web/lib/format.ts'],
    });
    expect(resolve('apps/web/scripts/build.js', 'javascript', ref('@/lib/format.js')).kind).toBe(
      'unresolved',
    );
  });

  it('explains a matching alias whose targets do not exist', () => {
    expect(resolve('apps/web/app/page.tsx', 'tsx', ref('@/lib/missing'))).toEqual({
      kind: 'unresolved',
      reason: 'tsconfig path @/* in apps/web/tsconfig.json matched but no target file exists',
    });
  });

  it('falls through to packages when no alias matches', () => {
    expect(resolve('apps/web/app/page.tsx', 'tsx', ref('next/link'))).toMatchObject({
      kind: 'dependency',
      name: 'next',
    });
    expect(resolve('apps/web/app/page.tsx', 'tsx', ref('node:fs'))).toEqual({ kind: 'builtin' });
  });

  it('applies only the nearest tsconfig.json', () => {
    // apps/api is governed by no config declaring paths.
    expect(resolve('apps/api/src/server.ts', 'typescript', ref('@/lib/api')).kind).toBe(
      'unresolved',
    );
  });

  it('inherits paths through extends, relative to the base that declares them', () => {
    const inherited = resolverWithConfigs(
      ['packages/ui/src/button.tsx', 'shared/theme.ts'],
      {
        'tsconfig.base.json': { compilerOptions: { paths: { '#shared/*': ['./shared/*'] } } },
        'configs/tsconfig.lib.json': { extends: '../tsconfig.base.json' },
        'packages/ui/tsconfig.json': { extends: ['../../configs/tsconfig.lib'] },
      },
    );
    expect(
      inherited('packages/ui/src/button.tsx', 'tsx', ref('#shared/theme')),
    ).toEqual({
      kind: 'files',
      paths: ['shared/theme.ts'],
      confidence: 1,
      method: 'tsconfig-paths:tsconfig.base.json##shared/*',
    });
  });

  it('lets a later extends entry and the config itself override inherited paths', () => {
    const overridden = resolverWithConfigs(
      ['app/main.ts', 'app/sub/main.ts', 'a/x.ts', 'b/x.ts', 'c/x.ts'],
      {
        'a.json': { compilerOptions: { paths: { '~/*': ['./a/*'] } } },
        'b.json': { compilerOptions: { paths: { '~/*': ['./b/*'] } } },
        'app/tsconfig.json': { extends: ['../a.json', '../b.json'] },
        'app/sub/tsconfig.json': {
          extends: '../tsconfig.json',
          compilerOptions: { paths: { '~/*': ['../../c/*'] } },
        },
      },
    );
    expect(overridden('app/main.ts', 'typescript', ref('~/x'))).toMatchObject({
      paths: ['b/x.ts'],
    });
    expect(overridden('app/sub/main.ts', 'typescript', ref('~/x'))).toMatchObject({
      paths: ['c/x.ts'],
      method: 'tsconfig-paths:app/sub/tsconfig.json#~/*',
    });
  });

  it('resolves paths from baseUrl, which is relative to the config declaring it', () => {
    const withBase = resolverWithConfigs(
      ['svc/src/app.ts', 'svc/src/orders/order.ts', 'svc/src/lib/log.ts'],
      {
        'svc/tsconfig.base.json': { compilerOptions: { baseUrl: './src' } },
        'svc/tsconfig.json': {
          extends: './tsconfig.base.json',
          compilerOptions: { paths: { '@lib/*': ['lib/*'] } },
        },
      },
    );
    expect(withBase('svc/src/app.ts', 'typescript', ref('@lib/log'))).toEqual({
      kind: 'files',
      paths: ['svc/src/lib/log.ts'],
      confidence: 1,
      method: 'tsconfig-paths:svc/tsconfig.json#@lib/*',
    });
    // Bare specifiers are also looked up under baseUrl.
    expect(withBase('svc/src/app.ts', 'typescript', ref('orders/order.js'))).toEqual({
      kind: 'files',
      paths: ['svc/src/orders/order.ts'],
      confidence: 1,
      method: 'tsconfig-base-url:svc/tsconfig.base.json',
    });
  });

  it('lets an explicit paths key, but not baseUrl, shadow a Node built-in', () => {
    const shadowing = resolverWithConfigs(['src/app.ts', 'src/assert.ts', 'shims/events.ts'], {
      'tsconfig.json': {
        compilerOptions: { baseUrl: './src', paths: { events: ['../shims/events.ts'] } },
      },
    });
    expect(shadowing('src/app.ts', 'typescript', ref('assert'))).toEqual({ kind: 'builtin' });
    expect(shadowing('src/app.ts', 'typescript', ref('events'))).toMatchObject({
      paths: ['shims/events.ts'],
      method: 'tsconfig-paths:tsconfig.json#events',
    });
  });

  it('never follows extends or baseUrl outside the repository, and survives cycles', () => {
    const guarded = resolverWithConfigs(
      ['app/main.ts', 'app/lib/x.ts'],
      {
        'app/tsconfig.json': {
          extends: ['../../outside/tsconfig.json', './loop.json'],
          compilerOptions: { baseUrl: '../..', paths: { '~/*': ['lib/*'] } },
        },
        'app/loop.json': { extends: './tsconfig.json' },
      },
    );
    // baseUrl escapes the root, so paths relative to it cannot be resolved.
    expect(guarded('app/main.ts', 'typescript', ref('~/x')).kind).toBe('unresolved');
  });

  it('does not apply an unparseable governing config from further up', () => {
    const shadowed = createResolver({
      files: new Set(['tsconfig.json', 'pkg/tsconfig.json', 'pkg/src/a.ts', 'pkg/src/b.ts']),
      manifests: [],
      // pkg/tsconfig.json exists but could not be parsed: the root config does not govern pkg.
      tsconfigs: [
        parseTsConfig('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.' } })),
      ],
    });
    expect(shadowed('pkg/src/a.ts', 'typescript', ref('pkg/src/b')).kind).toBe('unresolved');
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
