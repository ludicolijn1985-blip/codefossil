import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FossilDatabase } from './client.js';
import { recordRelation } from './relations.js';
import { registerRepository } from './repositories.js';
import { getIndexStatus } from './status.js';
import { openTestDatabase, seedCommitAndFile } from './test-helpers.js';

describe('getIndexStatus', () => {
  let fossil: FossilDatabase;

  beforeEach(() => {
    fossil = openTestDatabase();
  });

  afterEach(() => {
    fossil.close();
  });

  it('returns undefined for an unknown repository', () => {
    expect(getIndexStatus(fossil.db, 1)).toBeUndefined();
  });

  it('reports zero counts for a registered but unindexed repository', () => {
    const repo = registerRepository(fossil.db, { path: '/work/app', name: 'app' });
    expect(getIndexStatus(fossil.db, repo.id)).toEqual({
      repository: {
        id: repo.id,
        name: 'app',
        path: '/work/app',
        defaultBranch: null,
        remoteUrl: null,
        indexedAt: null,
      },
      counts: {
        commits: 0,
        files: 0,
        currentFiles: 0,
        fileChanges: 0,
        evidence: 0,
        symbols: 0,
        currentSymbols: 0,
        symbolVersions: 0,
        relations: { FACT: 0, DERIVED: 0, INFERRED: 0 },
      },
      latestCommit: null,
    });
  });

  it('counts only rows belonging to the repository', () => {
    const repo = registerRepository(fossil.db, { path: '/work/app', name: 'app' });
    const other = registerRepository(fossil.db, { path: '/work/other', name: 'other' });
    const { commitId, fileId } = seedCommitAndFile(fossil, repo.id);
    recordRelation(fossil.db, {
      repositoryId: repo.id,
      source: { type: 'commit', id: commitId },
      relation: 'MODIFIES',
      target: { type: 'file', id: fileId },
      evidenceType: 'FACT',
      confidence: 1,
      provenance: { producer: 'test', method: 'seed', observedAt: '2026-01-01T00:00:00.000Z' },
    });

    const status = getIndexStatus(fossil.db, repo.id);
    expect(status?.counts).toMatchObject({ commits: 1, files: 1, currentFiles: 1 });
    expect(status?.counts.relations.FACT).toBe(1);
    expect(status?.latestCommit?.sha).toBe('a'.repeat(40));
    expect(getIndexStatus(fossil.db, other.id)?.counts.commits).toBe(0);
  });
});
