import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, type FossilDatabase } from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { extractionVersion } from '@codefossil/parser';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-10-07T12:00:00.000Z');

describe('parse cache', () => {
  let repo: FixtureRepo;
  let fossil: FossilDatabase;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    fossil = openDatabase(IN_MEMORY);
    await repo.write('src/a.ts', 'export function a() {\n  return 1;\n}\n');
    await repo.commit('Add a');
    await repo.git('checkout', '-q', '-b', 'feature');
    await repo.write('src/a.ts', 'export function a() {\n  return 2;\n}\nclass {{{\n');
    await repo.commit('Change a, with a syntax error');
  });

  afterEach(async () => {
    fossil.close();
    await repo.cleanup();
  });

  /** Index the feature branch, leave it (pruning its commit) and come back. */
  async function returnToFeature(beforeReturn: () => void = () => undefined) {
    await runIndex(fossil.db, repo.root, { now });
    await repo.git('checkout', '-q', 'main');
    await runIndex(fossil.db, repo.root, { now });
    beforeReturn();
    await repo.git('checkout', '-q', 'feature');
    return runIndex(fossil.db, repo.root, { now });
  }

  const cacheRows = () =>
    fossil.sqlite.prepare('select version, result_json from parsed_blobs').all() as {
      version: string;
      result_json: string;
    }[];

  it('reuses parse results, syntax-error flags included', async () => {
    const back = await returnToFeature();

    expect(back.symbols).toMatchObject({ versionsParsed: 1, versionsFromCache: 1 });
    expect(cacheRows().every((row) => row.version === extractionVersion())).toBe(true);
    const flags = cacheRows().map(
      (row) => (JSON.parse(row.result_json) as { hasSyntaxErrors: boolean }).hasSyntaxErrors,
    );
    expect(flags).toContain(true);
    // The syntax error still lowers the confidence of what was derived from that version.
    const modifies = fossil.sqlite
      .prepare(
        "select confidence from relations where relation = 'MODIFIES' order by id desc limit 1",
      )
      .get() as { confidence: number };
    expect(modifies.confidence).toBe(0.8);
  });

  it('parses again when a cached result is from another version or unreadable', async () => {
    const back = await returnToFeature(() => {
      fossil.sqlite.exec("update parsed_blobs set version = 'symbols@1'");
    });
    expect(back.symbols.versionsFromCache).toBe(0);

    const corrupt = await returnToFeature(() => {
      fossil.sqlite.exec(`update parsed_blobs set result_json = '{"symbols":"nope"}'`);
    });
    expect(corrupt.symbols).toMatchObject({ versionsParsed: 1, versionsFromCache: 0 });
  });
});
