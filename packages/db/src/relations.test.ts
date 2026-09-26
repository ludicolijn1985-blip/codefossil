import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { FossilDatabase } from './client.js';
import { recordEvidence } from './evidence.js';
import {
  incomingRelations,
  outgoingRelations,
  recordRelation,
  RelationIntegrityError,
} from './relations.js';
import { registerRepository } from './repositories.js';
import { openTestDatabase, seedCommitAndFile } from './test-helpers.js';

const provenance = {
  producer: 'git-indexer@0.1.0',
  method: 'commit-diff',
  observedAt: '2026-09-26T12:00:00.000Z',
};

describe('relations', () => {
  let fossil: FossilDatabase;
  let repositoryId: number;
  let commitId: number;
  let fileId: number;

  beforeEach(() => {
    fossil = openTestDatabase();
    repositoryId = registerRepository(fossil.db, { path: '/work/app', name: 'app' }).id;
    ({ commitId, fileId } = seedCommitAndFile(fossil, repositoryId));
  });

  afterEach(() => {
    fossil.close();
  });

  const modifies = () => ({
    repositoryId,
    source: { type: 'commit', id: commitId },
    relation: 'MODIFIES',
    target: { type: 'file', id: fileId },
    evidenceType: 'FACT',
    confidence: 1,
    provenance,
  });

  it('stores a relation together with its provenance', () => {
    const row = recordRelation(fossil.db, modifies());
    expect(row).toMatchObject({
      sourceType: 'commit',
      sourceId: commitId,
      relation: 'MODIFIES',
      targetType: 'file',
      targetId: fileId,
      evidenceType: 'FACT',
      confidence: 1,
    });
    expect(row.provenanceJson).toEqual({ ...provenance, evidenceIds: [] });
    expect(row.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('is idempotent: recording the same edge again updates it in place', () => {
    const first = recordRelation(fossil.db, {
      ...modifies(),
      evidenceType: 'DERIVED',
      confidence: 0.5,
    });
    const second = recordRelation(fossil.db, {
      ...modifies(),
      evidenceType: 'DERIVED',
      confidence: 0.8,
    });
    expect(second.id).toBe(first.id);
    expect(second.confidence).toBe(0.8);
    expect(
      outgoingRelations(fossil.db, repositoryId, { type: 'commit', id: commitId }),
    ).toHaveLength(1);
  });

  it('rejects input that breaks the evidence rules before touching the database', () => {
    expect(() => recordRelation(fossil.db, { ...modifies(), confidence: 0.4 })).toThrow(ZodError);
  });

  it('rejects an INFERRED relation without evidence', () => {
    expect(() =>
      recordRelation(fossil.db, { ...modifies(), evidenceType: 'INFERRED', confidence: 0.4 }),
    ).toThrow(ZodError);
  });

  it('enforces the FACT-is-certain rule in SQL as well', () => {
    expect(() =>
      fossil.sqlite
        .prepare(
          `INSERT INTO relations (repository_id, source_type, source_id, relation, target_type, target_id, confidence, evidence_type, provenance_json)
           VALUES (?, 'commit', ?, 'MODIFIES', 'file', ?, 0.5, 'FACT', '{}')`,
        )
        .run(repositoryId, commitId, fileId),
    ).toThrow(/CHECK constraint failed: relations_fact_is_certain/);
  });

  it('rejects an unknown evidence level in SQL', () => {
    expect(() =>
      fossil.sqlite
        .prepare(
          `INSERT INTO relations (repository_id, source_type, source_id, relation, target_type, target_id, confidence, evidence_type, provenance_json)
           VALUES (?, 'commit', ?, 'MODIFIES', 'file', ?, 0.5, 'GUESS', '{}')`,
        )
        .run(repositoryId, commitId, fileId),
    ).toThrow(/CHECK constraint failed: relations_evidence_type_valid/);
  });

  it('finds outgoing and incoming relations', () => {
    recordRelation(fossil.db, modifies());
    const outgoing = outgoingRelations(fossil.db, repositoryId, { type: 'commit', id: commitId });
    const incoming = incomingRelations(fossil.db, repositoryId, { type: 'file', id: fileId });
    expect(outgoing).toHaveLength(1);
    expect(incoming).toHaveLength(1);
    expect(outgoing[0]?.id).toBe(incoming[0]?.id);
    expect(incomingRelations(fossil.db, repositoryId, { type: 'commit', id: commitId })).toEqual(
      [],
    );
  });

  it('scopes relation lookups to a repository', () => {
    recordRelation(fossil.db, modifies());
    const other = registerRepository(fossil.db, { path: '/work/other', name: 'other' });
    expect(outgoingRelations(fossil.db, other.id, { type: 'commit', id: commitId })).toEqual([]);
  });

  describe('referential integrity', () => {
    const inferred = (evidenceIds: number[]) => ({
      ...modifies(),
      evidenceType: 'INFERRED',
      confidence: 0.6,
      provenance: { ...provenance, evidenceIds },
    });

    it('rejects a source entity that does not exist', () => {
      expect(() =>
        recordRelation(fossil.db, { ...modifies(), source: { type: 'commit', id: 999 } }),
      ).toThrow(`source commit #999 does not exist in repository #${repositoryId}`);
    });

    it('rejects entities that belong to another repository', () => {
      const other = registerRepository(fossil.db, { path: '/work/other', name: 'other' });
      expect(() => recordRelation(fossil.db, { ...modifies(), repositoryId: other.id })).toThrow(
        RelationIntegrityError,
      );
    });

    it('rejects an INFERRED relation that cites evidence which does not exist', () => {
      expect(() => recordRelation(fossil.db, inferred([999_999]))).toThrow(
        /cited evidence does not exist .*: 999999/,
      );
    });

    it('rejects evidence recorded for a different repository', () => {
      const other = registerRepository(fossil.db, { path: '/work/other', name: 'other' });
      const foreign = recordEvidence(fossil.db, {
        repositoryId: other.id,
        type: 'commit',
        locator: 'b'.repeat(40),
      });
      expect(() => recordRelation(fossil.db, inferred([foreign.id]))).toThrow(
        RelationIntegrityError,
      );
    });

    it('accepts an INFERRED relation that cites real evidence', () => {
      const cited = recordEvidence(fossil.db, {
        repositoryId,
        type: 'commit',
        locator: 'a'.repeat(40),
        excerpt: 'Add VAT calculation',
      });
      const row = recordRelation(fossil.db, inferred([cited.id]));
      expect(row.provenanceJson.evidenceIds).toEqual([cited.id]);
    });

    it('stores nothing when a reference is missing', () => {
      expect(() =>
        recordRelation(fossil.db, { ...modifies(), target: { type: 'file', id: 999 } }),
      ).toThrow(RelationIntegrityError);
      expect(outgoingRelations(fossil.db, repositoryId, { type: 'commit', id: commitId })).toEqual(
        [],
      );
    });
  });
});
