import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IN_MEMORY, openDatabase, type FossilDatabase } from '@codefossil/db';
import { runIndex } from '@codefossil/core';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { analyzeOwnership } from './ownership.js';

const now = () => new Date('2026-10-07T12:00:00.000Z');
const lines = (n: number, tag: string) =>
  Array.from({ length: n }, (_, i) => `export const ${tag}${String(i)} = ${String(i)};`).join(
    '\n',
  ) + '\n';

describe('analyzeOwnership', () => {
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

  const commitAs = async (author: string, message: string) => {
    await repo.git('add', '-A');
    await repo.git('commit', '-q', `--author=${author}`, '-m', message);
  };

  it('shares each file among its authors, flags files whose author left, and finds the bus factor', async () => {
    await repo.write('src/a.ts', lines(10, 'a'));
    await repo.commit('Ada writes a');
    await repo.write('src/b.ts', lines(2, 'b'));
    await repo.commit('Ada starts b');
    await repo.write('src/b.ts', lines(12, 'b'));
    await commitAs('Bob Builder <bob@example.com>', 'Bob grows b');
    await repo.write('src/c.ts', lines(5, 'c'));
    await commitAs('Bob Builder <bob@example.com>', 'Bob writes c');
    await repo.write('src/a.test.ts', lines(3, 't'));
    await commitAs('Bob Builder <bob@example.com>', 'Bob tests a');
    const { repositoryId } = await runIndex(fossil.db, repo.root, { now });

    // Fixture commits are an hour apart: with a 30-minute window only the latest author is active.
    const report = analyzeOwnership(fossil.db, repositoryId, { activeDays: 1 / 48 });

    expect(report.filesConsidered).toBe(3); // the test file is left out
    expect(report.files.map((f) => `${f.atRisk ? '!' : ' '}${f.file.path}`)).toEqual([
      '!src/a.ts',
      ' src/b.ts',
      ' src/c.ts',
    ]);
    const b = report.files.find((f) => f.file.path === 'src/b.ts');
    expect(b?.authors.map((a) => [a.author, a.share, a.active])).toEqual([
      ['Bob Builder', 0.833, true],
      ['Ada Lovelace', 0.167, false],
    ]);
    // Without Bob, b.ts and c.ts have nobody who wrote a substantial part of them.
    expect(report).toMatchObject({ busFactor: 1, busFactorAuthors: ['Bob Builder'] });
    expect(report.classification).toBe('INFERRED');

    // Another spelling with the same email is the same person, shown under the latest name.
    await repo.write('src/a.ts', lines(11, 'a'));
    await commitAs('A. Lovelace <ADA@example.com>', 'Ada, renamed, touches a');
    await repo.write('src/a.ts', lines(12, 'a'));
    await commitAs('a. lovelace <noreply@github.com>', 'Same name, other case, no real email');
    await runIndex(fossil.db, repo.root, { now });
    const merged = analyzeOwnership(fossil.db, repositoryId, { path: 'src/a.ts' });
    // Three commits by one person under three spellings: one author.
    expect(merged.files[0]?.authors.map((a) => a.commits)).toEqual([3]);
    expect(merged.files[0]?.authors[0]?.author.toLowerCase()).toBe('a. lovelace');

    const scoped = analyzeOwnership(fossil.db, repositoryId, { path: 'src/c.ts' });
    expect(scoped.files.map((f) => f.file.path)).toEqual(['src/c.ts']);
    expect(analyzeOwnership(fossil.db, repositoryId, { path: 'src/c' }).filesConsidered).toBe(0);
  });
});
