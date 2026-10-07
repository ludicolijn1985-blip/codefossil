import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, setGraphIndexedSha, type FossilDatabase } from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { describeIndexHeadState, indexHeadState } from './index-freshness.js';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-10-06T12:00:00.000Z');

describe('indexHeadState', () => {
  let fossil: FossilDatabase;
  let repo: FixtureRepo;

  beforeEach(async () => {
    fossil = openDatabase(IN_MEMORY);
    repo = await createFixtureRepo();
    await repo.write('a.js', 'export const a = 1;\n');
    await repo.commit('First');
  });

  afterEach(async () => {
    fossil.close();
    await repo.cleanup();
  });

  const state = async () => {
    const { repositoryId } = await runIndex(fossil.db, repo.root, { now });
    return { repositoryId, read: () => indexHeadState(fossil.db, repositoryId, repo.root) };
  };

  it('is current at the indexed HEAD and behind after new commits', async () => {
    const { read } = await state();
    expect((await read()).freshness).toBe('current');
    expect(describeIndexHeadState(await read())).toBeNull();

    await repo.commit('Second');
    const behind = await read();
    expect(behind.freshness).toBe('behind');
    expect(describeIndexHeadState(behind)).toBeNull();
    expect(describeIndexHeadState(behind, { includeBehind: true })).toContain('newer commits');
  });

  it('is diverged when HEAD moved off the indexed commit', async () => {
    await repo.git('checkout', '-q', '-b', 'side');
    await repo.commit('Side');
    const { read } = await state();
    await repo.git('checkout', '-q', 'main');

    const diverged = await read();
    expect(diverged.freshness).toBe('diverged');
    expect(describeIndexHeadState(diverged)).toContain('not in the history of HEAD');
  });

  it('is unknown when the indexed commit is not in this clone, and unindexed before any run', async () => {
    const { repositoryId, read } = await state();
    setGraphIndexedSha(fossil.db, repositoryId, 'f'.repeat(40));
    expect((await read()).freshness).toBe('unknown');

    const empty = openDatabase(IN_MEMORY);
    try {
      const other = await runIndex(empty.db, repo.root, { now });
      empty.sqlite.exec('UPDATE repositories SET graph_indexed_sha = NULL');
      expect((await indexHeadState(empty.db, other.repositoryId, repo.root)).freshness).toBe(
        'unindexed',
      );
    } finally {
      empty.close();
    }
  });
});
