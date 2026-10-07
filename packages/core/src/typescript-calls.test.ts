import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, type FossilDatabase } from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { runIndex } from './run-index.js';
import { typeCheckedCalls, typeCheckingRequested } from './typescript-calls.js';

const now = () => new Date('2026-10-07T12:00:00.000Z');

describe('type-checked TypeScript calls', () => {
  let repo: FixtureRepo;
  let fossil: FossilDatabase;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    fossil = openDatabase(IN_MEMORY);
    await repo.write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { strict: true, module: 'nodenext', target: 'es2022', noEmit: true },
        include: ['src'],
      }),
    );
    await repo.write(
      'src/repo.ts',
      'export class Repo {\n  save(): number {\n    return 1;\n  }\n}\n',
    );
    await repo.write(
      'src/factory.ts',
      "import { Repo } from './repo.js';\nexport function make(): Repo {\n  return new Repo();\n}\n",
    );
    // No stated type on `r`: only the checker knows `make()` returns a Repo.
    await repo.write(
      'src/app.ts',
      "import { make } from './factory.js';\nexport function run() {\n  const r = make();\n  return r.save();\n}\n",
    );
    await repo.commit('App');
  });

  afterEach(async () => {
    fossil.close();
    await repo.cleanup();
  });

  const callEdges = () =>
    fossil.sqlite
      .prepare(
        `select s.qualified_name as caller, t.qualified_name as callee,
                json_extract(r.provenance_json, '$.method') as method, r.evidence_type as level,
                r.confidence as confidence
           from relations r join symbols s on s.id = r.source_id join symbols t on t.id = r.target_id
          where r.relation = 'CALLS' and r.source_type = 'symbol' order by caller, callee`,
      )
      .all();

  it('resolves calls name-based reading cannot follow', async () => {
    await runIndex(fossil.db, repo.root, { now, typescript: true });

    expect(callEdges()).toContainEqual({
      caller: 'run',
      callee: 'Repo.save',
      method: 'typescript-checker',
      level: 'DERIVED',
      confidence: 1,
    });
    // Without the checker the call through `r` stays unresolved.
    const plain = openDatabase(IN_MEMORY);
    await runIndex(plain.db, repo.root, { now });
    const methods = plain.sqlite
      .prepare(
        "select json_extract(provenance_json, '$.method') as m from relations where relation = 'CALLS'",
      )
      .all() as { m: string }[];
    expect(methods.map((row) => row.m)).not.toContain('typescript-checker');
    plain.close();
  });

  it('skips files with uncommitted changes, whose lines do not match HEAD', async () => {
    await repo.write(
      'src/app.ts',
      "import { make } from './factory.js';\n\n\nexport function run() {\n  return make().save();\n}\n",
    );

    const checked = await typeCheckedCalls(repo.root);

    expect(checked.calls.some((call) => call.fromPath === 'src/app.ts')).toBe(false);
    expect(checked.calls.some((call) => call.fromPath === 'src/factory.ts')).toBe(true);
    expect(checked.note).toMatch(/1 file\(s\) with uncommitted changes/);
    expect(checked.compiler).toMatch(/^\d+\./);
  });

  it('compiles each package of a monorepo without a root project', async () => {
    await repo.move('tsconfig.json', 'packages/app/tsconfig.json');
    await repo.move('src', 'packages/app/src');
    await repo.commit('Move into a package');

    const checked = await typeCheckedCalls(repo.root);

    expect(checked.calls).toContainEqual(
      expect.objectContaining({ fromPath: 'packages/app/src/app.ts', toName: 'save' }),
    );
  });

  it('is opt-in', () => {
    expect(typeCheckingRequested({})).toBe(false);
    expect(typeCheckingRequested({ CODEFOSSIL_TYPESCRIPT: '1' })).toBe(true);
  });
});
