import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FossilDatabase } from './client.js';
import { entityExists } from './entities.js';
import { registerRepository } from './repositories.js';
import * as schema from './schema.js';
import { openTestDatabase, seedCommitAndFile } from './test-helpers.js';

describe('entityExists', () => {
  let fossil: FossilDatabase;
  let repositoryId: number;
  let otherRepositoryId: number;
  let fileId: number;
  let commitId: number;

  beforeEach(() => {
    fossil = openTestDatabase();
    repositoryId = registerRepository(fossil.db, { path: '/work/app', name: 'app' }).id;
    otherRepositoryId = registerRepository(fossil.db, { path: '/work/other', name: 'other' }).id;
    ({ commitId, fileId } = seedCommitAndFile(fossil, repositoryId));
  });

  afterEach(() => {
    fossil.close();
  });

  it('finds entities that carry their own repository id', () => {
    expect(entityExists(fossil.db, repositoryId, { type: 'commit', id: commitId })).toBe(true);
    expect(entityExists(fossil.db, repositoryId, { type: 'file', id: fileId })).toBe(true);
    expect(entityExists(fossil.db, otherRepositoryId, { type: 'commit', id: commitId })).toBe(
      false,
    );
    expect(entityExists(fossil.db, repositoryId, { type: 'issue', id: 1 })).toBe(false);
  });

  it('only treats the relation repository itself as an existing repository entity', () => {
    expect(entityExists(fossil.db, repositoryId, { type: 'repository', id: repositoryId })).toBe(
      true,
    );
    expect(
      entityExists(fossil.db, repositoryId, { type: 'repository', id: otherRepositoryId }),
    ).toBe(false);
  });

  it('resolves symbols and tests through their file', () => {
    const symbol = fossil.db
      .insert(schema.symbols)
      .values({
        fileId,
        stableKey: 'fn:calculateVAT',
        name: 'calculateVAT',
        kind: 'function',
        startLine: 1,
        endLine: 5,
      })
      .returning()
      .get();
    const test = fossil.db
      .insert(schema.tests)
      .values({ fileId, symbolId: symbol.id, framework: 'vitest', name: 'calculates VAT' })
      .returning()
      .get();

    expect(entityExists(fossil.db, repositoryId, { type: 'symbol', id: symbol.id })).toBe(true);
    expect(entityExists(fossil.db, otherRepositoryId, { type: 'symbol', id: symbol.id })).toBe(
      false,
    );
    expect(entityExists(fossil.db, repositoryId, { type: 'test', id: test.id })).toBe(true);
    expect(entityExists(fossil.db, otherRepositoryId, { type: 'test', id: test.id })).toBe(false);
  });

  it('resolves reviews through their pull request', () => {
    const pr = fossil.db
      .insert(schema.pullRequests)
      .values({
        repositoryId,
        provider: 'github',
        externalId: '421',
        title: 'Add VAT',
        state: 'merged',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      .returning()
      .get();
    const review = fossil.db
      .insert(schema.reviews)
      .values({ pullRequestId: pr.id, author: 'grace', submittedAt: '2026-01-02T00:00:00.000Z' })
      .returning()
      .get();

    expect(entityExists(fossil.db, repositoryId, { type: 'pull_request', id: pr.id })).toBe(true);
    expect(entityExists(fossil.db, repositoryId, { type: 'review', id: review.id })).toBe(true);
    expect(entityExists(fossil.db, otherRepositoryId, { type: 'review', id: review.id })).toBe(
      false,
    );
  });
});
