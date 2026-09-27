import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FossilDatabase } from './client.js';
import { registerRepository } from './repositories.js';
import * as schema from './schema.js';
import { commitsByShaPrefix, recentCommits, searchFiles } from './search.js';
import { openTestDatabase } from './test-helpers.js';

describe('search', () => {
  let fossil: FossilDatabase;
  let repositoryId: number;

  beforeEach(() => {
    fossil = openTestDatabase();
    repositoryId = registerRepository(fossil.db, { path: '/work/app', name: 'app' }).id;
    for (const [path, deletedAt] of [
      ['src/tax/vat.ts', null],
      ['src/tax/old_vat.ts', '2026-01-01T00:00:00.000Z'],
      ['docs/100%.md', null],
      ['README.md', null],
    ] as const) {
      fossil.db.insert(schema.files).values({ repositoryId, path, deletedAt }).run();
    }
    ['aaa1', 'bbb2'].forEach((prefix, i) => {
      fossil.db
        .insert(schema.commits)
        .values({
          repositoryId,
          sha: prefix.padEnd(40, '0'),
          authorName: 'Ada',
          authorEmail: 'ada@example.com',
          authoredAt: `2026-01-0${i + 1}T00:00:00.000Z`,
          committedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
          subject: `Commit ${i + 1}`,
        })
        .run();
    });
  });

  afterEach(() => {
    fossil.close();
  });

  it('finds files by path fragment, current files first', () => {
    expect(searchFiles(fossil.db, repositoryId, 'vat').map((f) => f.path)).toEqual([
      'src/tax/vat.ts',
      'src/tax/old_vat.ts',
    ]);
    expect(searchFiles(fossil.db, repositoryId, 'VAT')).toHaveLength(2);
    expect(searchFiles(fossil.db, repositoryId, '', 2)).toHaveLength(2);
  });

  it('treats LIKE wildcards in user input literally', () => {
    expect(searchFiles(fossil.db, repositoryId, '100%').map((f) => f.path)).toEqual([
      'docs/100%.md',
    ]);
    expect(searchFiles(fossil.db, repositoryId, 'old_').map((f) => f.path)).toEqual([
      'src/tax/old_vat.ts',
    ]);
    expect(searchFiles(fossil.db, repositoryId, '%')).toHaveLength(1);
  });

  it('lists recent commits newest first and finds them by sha prefix', () => {
    expect(recentCommits(fossil.db, repositoryId).map((c) => c.subject)).toEqual([
      'Commit 2',
      'Commit 1',
    ]);
    expect(commitsByShaPrefix(fossil.db, repositoryId, 'AAA1')).toHaveLength(1);
  });
});
