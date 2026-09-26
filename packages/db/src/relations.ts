import { and, eq } from 'drizzle-orm';
import { relationInputSchema, type EntityRef, type RelationInput } from '@codefossil/shared';
import type { FossilDb } from './client.js';
import { entityExists } from './entities.js';
import { missingEvidenceIds } from './evidence.js';
import { relations } from './schema.js';

export type RelationRow = typeof relations.$inferSelect;

/** A relation referenced something that does not exist in its repository. */
export class RelationIntegrityError extends Error {
  override readonly name = 'RelationIntegrityError';
}

/**
 * Validate and store a relation. Re-recording an existing edge replaces its
 * confidence, evidence level and provenance, so re-indexing is idempotent.
 *
 * Throws a ZodError when the input breaks the evidence rules, and a
 * RelationIntegrityError when the source, target or any cited evidence does
 * not exist in the relation's repository — evidence is never invented.
 */
export function recordRelation(db: FossilDb, input: unknown): RelationRow {
  const value: RelationInput = relationInputSchema.parse(input);
  return db.transaction((tx) => {
    assertReferencesExist(tx, value);
    return upsertRelation(tx, value);
  });
}

function assertReferencesExist(db: FossilDb, value: RelationInput): void {
  for (const [role, ref] of [
    ['source', value.source],
    ['target', value.target],
  ] as const) {
    if (!entityExists(db, value.repositoryId, ref)) {
      throw new RelationIntegrityError(
        `${role} ${ref.type} #${ref.id} does not exist in repository #${value.repositoryId}`,
      );
    }
  }
  const missing = missingEvidenceIds(db, value.repositoryId, value.provenance.evidenceIds);
  if (missing.length > 0) {
    throw new RelationIntegrityError(
      `cited evidence does not exist in repository #${value.repositoryId}: ${missing.join(', ')}`,
    );
  }
}

function upsertRelation(db: FossilDb, value: RelationInput): RelationRow {
  const row = {
    repositoryId: value.repositoryId,
    sourceType: value.source.type,
    sourceId: value.source.id,
    relation: value.relation,
    targetType: value.target.type,
    targetId: value.target.id,
    confidence: value.confidence,
    evidenceType: value.evidenceType,
    provenanceJson: value.provenance,
  };
  return db
    .insert(relations)
    .values(row)
    .onConflictDoUpdate({
      target: [
        relations.repositoryId,
        relations.sourceType,
        relations.sourceId,
        relations.relation,
        relations.targetType,
        relations.targetId,
      ],
      set: {
        confidence: row.confidence,
        evidenceType: row.evidenceType,
        provenanceJson: row.provenanceJson,
      },
    })
    .returning()
    .get();
}

/** All relations leaving an entity. */
export function outgoingRelations(
  db: FossilDb,
  repositoryId: number,
  source: EntityRef,
): RelationRow[] {
  return db
    .select()
    .from(relations)
    .where(
      and(
        eq(relations.repositoryId, repositoryId),
        eq(relations.sourceType, source.type),
        eq(relations.sourceId, source.id),
      ),
    )
    .all();
}

/** All relations pointing at an entity. */
export function incomingRelations(
  db: FossilDb,
  repositoryId: number,
  target: EntityRef,
): RelationRow[] {
  return db
    .select()
    .from(relations)
    .where(
      and(
        eq(relations.repositoryId, repositoryId),
        eq(relations.targetType, target.type),
        eq(relations.targetId, target.id),
      ),
    )
    .all();
}
