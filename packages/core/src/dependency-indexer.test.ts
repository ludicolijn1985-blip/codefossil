import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileImports,
  findFileByPath,
  IN_MEMORY,
  importedBy,
  listDependencies,
  openDatabase,
  outgoingRelations,
  type FossilDatabase,
} from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { IMPORT_RESOLVER_PRODUCER } from './dependency-indexer.js';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-09-26T12:00:00.000Z');

const PACKAGE_JSON = JSON.stringify({
  name: 'shop',
  dependencies: { zod: '^4.0.0' },
  devDependencies: { vitest: '^5.0.0' },
});

describe('indexDependencies', () => {
  let repo: FixtureRepo | undefined;
  let fossil: FossilDatabase;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    fossil = openDatabase(IN_MEMORY);
  });

  afterEach(async () => {
    fossil.close();
    await repo?.cleanup();
  });

  const fixture = (): FixtureRepo => {
    if (!repo) throw new Error('fixture repo was not created');
    return repo;
  };

  const fileId = (repositoryId: number, path: string): number => {
    const file = findFileByPath(fossil.db, repositoryId, path);
    if (!file) throw new Error(`${path} is not indexed`);
    return file.id;
  };

  const importsOf = (repositoryId: number, path: string) =>
    outgoingRelations(fossil.db, repositoryId, { type: 'file', id: fileId(repositoryId, path) });

  async function seed(): Promise<FixtureRepo> {
    const r = fixture();
    await r.write('package.json', PACKAGE_JSON);
    await r.write(
      'src/app.ts',
      [
        "import { vat } from './tax/vat.js';",
        "import { z } from 'zod';",
        "import { readFile } from 'node:fs';",
        "import pad from 'left-pad';",
        "export { vat } from './tax/vat.js';",
      ].join('\n'),
    );
    await r.write('src/tax/vat.ts', 'export const vat = 0.21;\n');
    await r.commit('Initial shop');
    return r;
  }

  it('records resolved imports, declared dependencies and what could not be resolved', async () => {
    const r = await seed();
    const { repositoryId, dependencies } = await runIndex(fossil.db, r.root, { now });

    expect(dependencies).toMatchObject({
      mode: 'full',
      filesParsed: 2,
      manifests: 1,
      manifestErrors: [],
      dependencies: 2,
      importEdges: 1,
      dependencyEdges: 1,
      builtinImports: 1,
      unresolvedImports: 1,
    });

    const edges = importsOf(repositoryId, 'src/app.ts');
    const imports = edges.find((e) => e.relation === 'IMPORTS');
    expect(imports).toMatchObject({
      targetType: 'file',
      targetId: fileId(repositoryId, 'src/tax/vat.ts'),
      evidenceType: 'DERIVED',
      confidence: 1,
    });
    // Imported twice (import + re-export): one edge citing both statements.
    expect(imports?.provenanceJson).toMatchObject({
      producer: IMPORT_RESOLVER_PRODUCER,
      method: 'relative-path',
    });
    expect(imports?.provenanceJson.evidenceIds).toHaveLength(2);
    expect(edges.find((e) => e.relation === 'DEPENDS_ON')?.targetType).toBe('dependency');

    const byResolution = fileImports(fossil.db, fileId(repositoryId, 'src/app.ts')).map(
      (i) => `${i.specifier} → ${i.resolution}: ${i.resolutionDetail ?? ''}`,
    );
    expect(byResolution).toEqual([
      './tax/vat.js → files: src/tax/vat.ts',
      'zod → dependency: npm:zod',
      'node:fs → builtin: ',
      'left-pad → unresolved: package left-pad is not declared in any package.json above the file',
      './tax/vat.js → files: src/tax/vat.ts',
    ]);

    expect(
      listDependencies(fossil.db, repositoryId).map((d) => `${d.scope}:${d.name}:${d.usedBy}`),
    ).toEqual(['dev:vitest:0', 'runtime:zod:1']);
    expect(importedBy(fossil.db, repositoryId, fileId(repositoryId, 'src/tax/vat.ts'))).toEqual([
      { path: 'src/app.ts', confidence: 1 },
    ]);
  });

  it('updates incrementally and removes edges that no longer hold at HEAD', async () => {
    const r = await seed();
    const { repositoryId } = await runIndex(fossil.db, r.root, { now });

    // Unchanged HEAD: nothing to do.
    expect((await runIndex(fossil.db, r.root, { now })).dependencies.mode).toBe('unchanged');

    // Deleting the target breaks the edge although app.ts itself did not change.
    await r.remove('src/tax/vat.ts');
    await r.commit('Drop vat');
    const afterDelete = await runIndex(fossil.db, r.root, { now });
    expect(afterDelete.dependencies).toMatchObject({
      mode: 'incremental',
      filesParsed: 0,
      importEdges: 0,
    });
    expect(importsOf(repositoryId, 'src/app.ts').filter((e) => e.relation === 'IMPORTS')).toEqual(
      [],
    );

    // Removing zod from the manifest makes it non-current and drops the file edge.
    await r.write(
      'package.json',
      JSON.stringify({ name: 'shop', devDependencies: { vitest: '^5.0.0' } }),
    );
    await r.commit('Drop zod');
    await runIndex(fossil.db, r.root, { now });
    expect(listDependencies(fossil.db, repositoryId).map((d) => d.name)).toEqual(['vitest']);
    expect(
      importsOf(repositoryId, 'src/app.ts').filter((e) => e.relation === 'DEPENDS_ON'),
    ).toEqual([]);
  });

  it('resolves workspace packages to source and marks them internal', async () => {
    const r = fixture();
    await r.write(
      'apps/web/package.json',
      JSON.stringify({ name: 'web', dependencies: { '@acme/db': 'workspace:*' } }),
    );
    await r.write('apps/web/src/main.ts', "import { open } from '@acme/db';\n");
    await r.write(
      'packages/db/package.json',
      JSON.stringify({ name: '@acme/db', exports: { '.': { source: './src/index.ts' } } }),
    );
    await r.write('packages/db/src/index.ts', 'export const open = () => 1;\n');
    await r.commit('Monorepo');

    const { repositoryId } = await runIndex(fossil.db, r.root, { now });

    expect(
      importedBy(fossil.db, repositoryId, fileId(repositoryId, 'packages/db/src/index.ts')),
    ).toEqual([{ path: 'apps/web/src/main.ts', confidence: 1 }]);
    expect(listDependencies(fossil.db, repositoryId)).toEqual([
      expect.objectContaining({ name: '@acme/db', internal: true, usedBy: 0 }),
    ]);
  });

  it('reports a broken manifest instead of failing', async () => {
    const r = fixture();
    await r.write('package.json', '{ "name": ');
    await r.write('src/a.ts', "import './b';\n");
    await r.write('src/b.ts', 'export {};\n');
    await r.commit('Broken manifest');

    const { dependencies } = await runIndex(fossil.db, r.root, { now });

    expect(dependencies.manifestErrors).toHaveLength(1);
    expect(dependencies.manifestErrors[0]).toContain('package.json');
    expect(dependencies.importEdges).toBe(1);
  });

  it('links to files that exist at HEAD even when the indexed history never touched them', async () => {
    const r = fixture();
    await r.write('lib/util.py', 'def helper():\n    pass\n');
    await r.write('lib/main.py', 'from .util import helper\n');
    await r.commit('Before the window');
    await r.write('lib/main.py', 'from .util import helper\nhelper()\n');
    await r.commit('Inside the window');

    const { repositoryId } = await runIndex(fossil.db, r.root, {
      now,
      since: new Date('2026-01-01T10:00:00Z'),
    });

    expect(importedBy(fossil.db, repositoryId, fileId(repositoryId, 'lib/util.py'))).toEqual([
      { path: 'lib/main.py', confidence: 1 },
    ]);
  });

  it('resolves Go packages within the module and required modules', async () => {
    const r = fixture();
    await r.write('go.mod', 'module example.com/shop\n\nrequire github.com/google/uuid v1.6.0\n');
    await r.write(
      'main.go',
      'package main\n\nimport (\n  "fmt"\n  "example.com/shop/tax"\n  "github.com/google/uuid"\n)\n',
    );
    await r.write('tax/vat.go', 'package tax\n');
    await r.write('tax/rates.go', 'package tax\n');
    await r.commit('Go shop');

    const { dependencies, repositoryId } = await runIndex(fossil.db, r.root, { now });

    expect(dependencies).toMatchObject({ importEdges: 2, dependencyEdges: 1, builtinImports: 1 });
    expect(importsOf(repositoryId, 'main.go').filter((e) => e.relation === 'IMPORTS')).toHaveLength(
      2,
    );
  });
});
