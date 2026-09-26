import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FossilDatabase } from './client.js';
import { missingEvidenceIds, recordEvidence } from './evidence.js';
import { registerRepository } from './repositories.js';
import { openTestDatabase } from './test-helpers.js';

describe('evidence', () => {
  let fossil: FossilDatabase;
  let repositoryId: number;

  beforeEach(() => {
    fossil = openTestDatabase();
    repositoryId = registerRepository(fossil.db, { path: '/work/app', name: 'app' }).id;
  });

  afterEach(() => {
    fossil.close();
  });

  it('records evidence with metadata', () => {
    const row = recordEvidence(fossil.db, {
      repositoryId,
      type: 'ast_node',
      locator: 'src/payment/vat.ts#L10-L20',
      metadata: { kind: 'function' },
    });
    expect(row).toMatchObject({
      type: 'ast_node',
      locator: 'src/payment/vat.ts#L10-L20',
      excerpt: null,
      metadataJson: { kind: 'function' },
    });
  });

  it('rejects an unknown evidence kind', () => {
    expect(() =>
      recordEvidence(fossil.db, { repositoryId, type: 'rumour' as 'commit', locator: 'x' }),
    ).toThrow();
  });

  it('rejects an empty locator', () => {
    expect(() =>
      recordEvidence(fossil.db, { repositoryId, type: 'commit', locator: '' }),
    ).toThrow();
  });

  it('reports which cited ids are missing, without duplicates', () => {
    const found = recordEvidence(fossil.db, { repositoryId, type: 'commit', locator: 'abc' });
    expect(missingEvidenceIds(fossil.db, repositoryId, [found.id, 404, 404, 405])).toEqual([
      404, 405,
    ]);
    expect(missingEvidenceIds(fossil.db, repositoryId, [found.id])).toEqual([]);
    expect(missingEvidenceIds(fossil.db, repositoryId, [])).toEqual([]);
  });
});
