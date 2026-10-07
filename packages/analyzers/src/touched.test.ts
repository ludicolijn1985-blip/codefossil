import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, type FossilDatabase } from '@codefossil/db';
import { runIndex } from '@codefossil/core';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { analyzeTouchedSymbols } from './touched.js';

const now = () => new Date('2026-10-07T12:00:00.000Z');
const fn = (name: string, body = 'return 1;') => `export function ${name}() {\n  ${body}\n}\n`;

describe('analyzeTouchedSymbols', () => {
  let repo: FixtureRepo;
  let fossil: FossilDatabase;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    fossil = openDatabase(IN_MEMORY);
  });

  afterEach(async () => {
    fossil.close();
    await repo.cleanup();
  });

  it('says which touched functions are new, renamed or changed, with their covered lines', async () => {
    await repo.write('src/a.ts', `${fn('keep')}${fn('old', 'return 2;')}`);
    await repo.commit('Base');
    const before = (await repo.git('rev-parse', 'HEAD')).trim();
    await repo.write(
      'src/a.ts',
      `${fn('keep', 'return 3;')}${fn('renamed', 'return 2;')}${fn('fresh', 'return keep();')}`,
    );
    await repo.commit('Change keep, rename old, add fresh');
    const range = (await repo.git('rev-list', `${before}..HEAD`)).trim().split('\n');
    // Coverage written after the commit: keep ran, the others did not.
    await repo.write('coverage/lcov.info', 'SF:src/a.ts\nDA:2,1\nDA:5,0\nDA:8,0\nend_of_record\n');
    const { repositoryId } = await runIndex(fossil.db, repo.root, { now });

    const report = analyzeTouchedSymbols(fossil.db, repositoryId, range);

    expect(
      report.symbols.map((s) => [
        s.symbol.qualifiedName,
        s.change,
        s.from?.qualifiedName ?? null,
        s.coverage ? `${String(s.coverage.hit)}/${String(s.coverage.found)}` : null,
      ]),
    ).toEqual([
      ['fresh', 'new', null, '0/1'],
      ['renamed', 'renamed', 'old', '0/1'],
      ['keep', 'changed', null, '1/1'],
    ]);
    expect(report).toMatchObject({ total: 3, withCoverage: 3 });
    // fresh calls keep: a change to keep can break fresh.
    expect(report.symbols.map((s) => s.callers)).toEqual([0, 0, 1]);
  });
});
