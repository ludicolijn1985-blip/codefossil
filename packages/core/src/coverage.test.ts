import { utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  currentFileCoverage,
  fileCoverage,
  findFileByPath,
  IN_MEMORY,
  openDatabase,
  type FossilDatabase,
} from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { parseLcov } from './coverage.js';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-09-26T12:00:00.000Z');

describe('parseLcov', () => {
  it('reads instrumented and hit lines per file, merging repeated records', () => {
    const report = [
      'TN:',
      'SF:/repo/src/a.ts',
      'DA:1,3',
      'DA:2,0',
      'DA:3,1,abc123',
      'end_of_record',
      'SF:/repo/src/a.ts',
      'DA:2,4',
      'DA:5,0',
      'end_of_record',
      'SF:src/b.ts',
      'DA:x,1',
      'DA:0,1',
      'DA:7,NaN',
      'DA:4,0',
      'end_of_record',
    ].join('\n');

    expect(parseLcov(report)).toEqual([
      { path: '/repo/src/a.ts', found: [1, 2, 3, 5], hit: [1, 2, 3] },
      // Malformed and zero line numbers are skipped.
      { path: 'src/b.ts', found: [4], hit: [] },
    ]);
  });

  it('ignores data outside a file record', () => {
    expect(parseLcov('DA:1,1\nend_of_record\n')).toEqual([]);
  });
});

describe('indexCoverage', () => {
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

  it('reads an lcov report from the working tree and maps it to repository files', async () => {
    const r = fixture();
    await r.write('src/cart.ts', 'export function total() {\n  return 1;\n}\n');
    await r.commit('Cart');
    const report = [
      `SF:${join(r.root, 'src', 'cart.ts')}`,
      'DA:1,1',
      'DA:2,0',
      'end_of_record',
      'SF:../elsewhere/x.ts',
      'DA:1,1',
      'end_of_record',
      'SF:src/missing.ts',
      'DA:1,1',
      'end_of_record',
    ].join('\n');
    await r.write('coverage/lcov.info', report);

    const first = await runIndex(fossil.db, r.root, { now });
    expect(first.coverage).toEqual({
      report: 'coverage/lcov.info',
      files: 1,
      skipped: 2,
      unchanged: false,
      error: null,
    });
    const cart = findFileByPath(fossil.db, first.repositoryId, 'src/cart.ts');
    expect(currentFileCoverage(fossil.db, cart?.id ?? 0)).toMatchObject({
      found: [1, 2],
      hit: [1],
      report: 'coverage/lcov.info',
    });

    const second = await runIndex(fossil.db, r.root, { now });
    expect(second.coverage).toMatchObject({ unchanged: true, files: 1 });
  });

  it('does not apply a report written before the file last changed', async () => {
    const r = fixture();
    await r.write('src/cart.ts', 'export function total() {\n  return 1;\n}\n');
    await r.commit('Cart');
    await r.write('coverage/lcov.info', 'SF:src/cart.ts\nDA:1,1\nend_of_record\n');
    const old = new Date('2000-01-01T00:00:00Z');
    await utimes(join(r.root, 'coverage', 'lcov.info'), old, old);

    const { repositoryId } = await runIndex(fossil.db, r.root, { now });

    const cart = findFileByPath(fossil.db, repositoryId, 'src/cart.ts');
    // Stored as reported, but not presented as the file's coverage.
    expect(fileCoverage(fossil.db, repositoryId).size).toBe(1);
    expect(currentFileCoverage(fossil.db, cart?.id ?? 0)).toBeUndefined();
  });

  it('forgets coverage once the report is gone', async () => {
    const r = fixture();
    await r.write('src/cart.ts', 'export const x = 1;\n');
    await r.commit('Cart');
    await r.write('lcov.info', 'SF:src/cart.ts\nDA:1,1\nend_of_record\n');
    const { repositoryId } = await runIndex(fossil.db, r.root, { now });
    expect(fileCoverage(fossil.db, repositoryId).size).toBe(1);

    await r.remove('lcov.info');
    const after = await runIndex(fossil.db, r.root, { now });

    expect(after.coverage.report).toBeNull();
    expect(fileCoverage(fossil.db, repositoryId).size).toBe(0);
    expect(
      fossil.sqlite.prepare("select count(*) as n from evidence where type = 'coverage'").get(),
    ).toEqual({ n: 0 });
  });
});
