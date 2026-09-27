import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { symbolChangeCommits, symbolsChangedIn } from './analysis.js';
import type { FossilDatabase } from './client.js';
import { registerRepository } from './repositories.js';
import * as schema from './schema.js';
import { openTestDatabase } from './test-helpers.js';

/** More ids than SQLite accepts as bound parameters in one statement. */
const MANY = 40_000;

describe('analysis reads', () => {
  let fossil: FossilDatabase;
  let symbolId: number;
  let commitId: number;

  beforeEach(() => {
    fossil = openTestDatabase();
    const repositoryId = registerRepository(fossil.db, { path: '/work/app', name: 'app' }).id;
    const file = fossil.db
      .insert(schema.files)
      .values({ repositoryId, path: 'src/vat.ts' })
      .returning()
      .get();
    commitId = fossil.db
      .insert(schema.commits)
      .values({
        repositoryId,
        sha: 'a'.repeat(40),
        authorName: 'Ada',
        authorEmail: 'ada@example.com',
        authoredAt: '2026-01-01T00:00:00.000Z',
        committedAt: '2026-01-01T00:00:00.000Z',
        subject: 'Add VAT',
      })
      .returning()
      .get().id;
    symbolId = fossil.db
      .insert(schema.symbols)
      .values({
        fileId: file.id,
        stableKey: 'function:calculateVAT',
        name: 'calculateVAT',
        qualifiedName: 'calculateVAT',
        kind: 'function',
        startLine: 1,
        endLine: 3,
      })
      .returning()
      .get().id;
    fossil.db.insert(schema.symbolVersions).values({ symbolId, commitId, contentHash: 'h' }).run();
  });

  afterEach(() => {
    fossil.close();
  });

  it('accepts id lists beyond the bound-parameter limit', () => {
    const symbolIds = [symbolId, ...Array.from({ length: MANY }, (_, i) => symbolId + i + 1)];
    expect(symbolChangeCommits(fossil.db, symbolIds)).toEqual(new Map([[symbolId, [commitId]]]));
    const commitIds = [commitId, ...Array.from({ length: MANY }, (_, i) => commitId + i + 1)];
    expect(symbolsChangedIn(fossil.db, commitIds).map((s) => s.symbolId)).toEqual([symbolId]);
  });

  it('returns nothing for no ids', () => {
    expect(symbolsChangedIn(fossil.db, [])).toEqual([]);
    expect(symbolChangeCommits(fossil.db, []).size).toBe(0);
  });
});
