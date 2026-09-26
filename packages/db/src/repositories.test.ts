import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FossilDatabase } from './client.js';
import {
  findRepositoryByPath,
  listRepositories,
  markRepositoryIndexed,
  registerRepository,
} from './repositories.js';
import { openTestDatabase } from './test-helpers.js';

describe('repositories', () => {
  let fossil: FossilDatabase;

  beforeEach(() => {
    fossil = openTestDatabase();
  });

  afterEach(() => {
    fossil.close();
  });

  it('registers a repository with nullable metadata defaulting to null', () => {
    const repo = registerRepository(fossil.db, { path: '/work/app', name: 'app' });
    expect(repo).toMatchObject({
      path: '/work/app',
      name: 'app',
      remoteUrl: null,
      defaultBranch: null,
      indexedAt: null,
    });
    expect(repo.id).toBeGreaterThan(0);
  });

  it('updates metadata instead of duplicating when the path is registered again', () => {
    const first = registerRepository(fossil.db, { path: '/work/app', name: 'app' });
    const second = registerRepository(fossil.db, {
      path: '/work/app',
      name: 'app-renamed',
      defaultBranch: 'main',
    });
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('app-renamed');
    expect(second.defaultBranch).toBe('main');
    expect(listRepositories(fossil.db)).toHaveLength(1);
  });

  it('rejects an empty path', () => {
    expect(() => registerRepository(fossil.db, { path: '', name: 'app' })).toThrow();
  });

  it('finds a repository by path', () => {
    registerRepository(fossil.db, { path: '/work/app', name: 'app' });
    expect(findRepositoryByPath(fossil.db, '/work/app')?.name).toBe('app');
    expect(findRepositoryByPath(fossil.db, '/work/missing')).toBeUndefined();
  });

  it('lists repositories sorted by name', () => {
    registerRepository(fossil.db, { path: '/b', name: 'beta' });
    registerRepository(fossil.db, { path: '/a', name: 'alpha' });
    expect(listRepositories(fossil.db).map((r) => r.name)).toEqual(['alpha', 'beta']);
  });

  it('records when a repository was indexed', () => {
    const repo = registerRepository(fossil.db, { path: '/work/app', name: 'app' });
    const updated = markRepositoryIndexed(fossil.db, repo.id, new Date('2026-09-26T10:00:00Z'));
    expect(updated?.indexedAt).toBe('2026-09-26T10:00:00.000Z');
  });

  it('returns undefined when marking an unknown repository as indexed', () => {
    expect(markRepositoryIndexed(fossil.db, 42, new Date())).toBeUndefined();
  });
});
