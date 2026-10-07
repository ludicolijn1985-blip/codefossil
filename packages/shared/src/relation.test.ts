import { describe, expect, it } from 'vitest';
import { provenanceSchema, relationInputSchema } from './relation.js';

const baseProvenance = {
  producer: 'git-indexer@0.1.0',
  method: 'commit-diff',
  observedAt: '2026-09-26T12:00:00.000Z',
};

const baseRelation = {
  repositoryId: 1,
  source: { type: 'commit', id: 10 },
  relation: 'MODIFIES',
  target: { type: 'file', id: 20 },
  evidenceType: 'FACT',
  confidence: 1,
  provenance: baseProvenance,
};

describe('provenanceSchema', () => {
  it('defaults evidenceIds to an empty array', () => {
    const parsed = provenanceSchema.parse(baseProvenance);
    expect(parsed.evidenceIds).toEqual([]);
  });

  it('rejects a non-ISO observedAt timestamp', () => {
    const result = provenanceSchema.safeParse({ ...baseProvenance, observedAt: 'yesterday' });
    expect(result.success).toBe(false);
  });

  it('rejects an empty producer', () => {
    const result = provenanceSchema.safeParse({ ...baseProvenance, producer: '' });
    expect(result.success).toBe(false);
  });
});

describe('relationInputSchema', () => {
  it('accepts a FACT relation with confidence 1', () => {
    expect(relationInputSchema.safeParse(baseRelation).success).toBe(true);
  });

  it('rejects a FACT relation with confidence below 1', () => {
    const result = relationInputSchema.safeParse({ ...baseRelation, confidence: 0.9 });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['confidence']);
  });

  it('rejects an INFERRED relation without evidence', () => {
    const result = relationInputSchema.safeParse({
      ...baseRelation,
      evidenceType: 'INFERRED',
      confidence: 0.6,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['provenance', 'evidenceIds']);
  });

  it('accepts an INFERRED relation that cites evidence', () => {
    const result = relationInputSchema.safeParse({
      ...baseRelation,
      relation: 'RESOLVED_BY',
      evidenceType: 'INFERRED',
      confidence: 0.6,
      provenance: { ...baseProvenance, evidenceIds: [3] },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a DERIVED relation with confidence below 1', () => {
    const result = relationInputSchema.safeParse({
      ...baseRelation,
      evidenceType: 'DERIVED',
      confidence: 0.8,
    });
    expect(result.success).toBe(true);
  });

  it.each([-0.1, 1.1])('rejects confidence %s outside [0, 1]', (confidence) => {
    const result = relationInputSchema.safeParse({
      ...baseRelation,
      evidenceType: 'DERIVED',
      confidence,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown relation type', () => {
    const result = relationInputSchema.safeParse({ ...baseRelation, relation: 'LIKES' });
    expect(result.success).toBe(false);
  });

  it('rejects non-positive entity ids', () => {
    const result = relationInputSchema.safeParse({
      ...baseRelation,
      source: { type: 'commit', id: 0 },
    });
    expect(result.success).toBe(false);
  });
});

describe('lineageKind', () => {
  it('names the lineage by its provenance method, copied by default', async () => {
    const { lineageKind } = await import('./entities.js');
    expect(lineageKind('renamed')).toBe('renamed');
    expect(lineageKind('moved-with-edits')).toBe('moved');
    expect(lineageKind('identical-content')).toBe('copied');
    expect(lineageKind('anything-else')).toBe('copied');
  });
});
