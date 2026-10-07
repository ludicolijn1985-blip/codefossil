import { and, eq, sql } from 'drizzle-orm';
import { relationInputSchema, type EntityRef, type RelationInput } from '@codefossil/shared';
import type { FossilDb } from './client.js';
import { entityExists } from './entities.js';
import { missingEvidenceIds } from './evidence.js';
import { preparedFor } from './prepared.js';
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
  assertReferencesExist(db, value);
  const row = statements(db).upsert.get({
    repositoryId: value.repositoryId,
    sourceType: value.source.type,
    sourceId: value.source.id,
    relation: value.relation,
    targetType: value.target.type,
    targetId: value.target.id,
    confidence: value.confidence,
    evidenceType: value.evidenceType,
    provenance: value.provenance,
  });
  return row;
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

const neighbourQuery = (db: FossilDb, side: 'source' | 'target') => {
  const [typeColumn, idColumn] =
    side === 'source'
      ? [relations.sourceType, relations.sourceId]
      : [relations.targetType, relations.targetId];
  return db
    .select()
    .from(relations)
    .where(
      and(
        eq(relations.repositoryId, sql.placeholder('repositoryId')),
        eq(typeColumn, sql.placeholder('type')),
        eq(idColumn, sql.placeholder('id')),
      ),
    )
    .orderBy(relations.id)
    .prepare();
};

const statements = preparedFor((db) => ({
  bySource: neighbourQuery(db, 'source'),
  byTarget: neighbourQuery(db, 'target'),
  upsert: db
    .insert(relations)
    .values({
      repositoryId: sql.placeholder('repositoryId'),
      sourceType: sql.placeholder('sourceType'),
      sourceId: sql.placeholder('sourceId'),
      relation: sql.placeholder('relation'),
      targetType: sql.placeholder('targetType'),
      targetId: sql.placeholder('targetId'),
      confidence: sql.placeholder('confidence'),
      evidenceType: sql.placeholder('evidenceType'),
      provenanceJson: sql.placeholder('provenance'),
    })
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
        confidence: sql`excluded.confidence`,
        evidenceType: sql`excluded.evidence_type`,
        provenanceJson: sql`excluded.provenance_json`,
      },
    })
    .returning()
    .prepare(),
}));

/** All relations leaving an entity. */
export function outgoingRelations(
  db: FossilDb,
  repositoryId: number,
  source: EntityRef,
): RelationRow[] {
  return statements(db).bySource.all({ repositoryId, type: source.type, id: source.id });
}

/** All relations pointing at an entity. */
export function incomingRelations(
  db: FossilDb,
  repositoryId: number,
  target: EntityRef,
): RelationRow[] {
  return statements(db).byTarget.all({ repositoryId, type: target.type, id: target.id });
}

/** Every relation of a repository, for exporting the whole graph. */
export function allRelations(db: FossilDb, repositoryId: number): RelationRow[] {
  return db.select().from(relations).where(eq(relations.repositoryId, repositoryId)).all();
}

/** Remove one edge, e.g. a claim that later evidence in the same run replaces. */
export function deleteRelation(
  db: FossilDb,
  repositoryId: number,
  edge: {
    readonly source: EntityRef;
    readonly relation: RelationInput['relation'];
    readonly target: EntityRef;
  },
): void {
  db.delete(relations)
    .where(
      and(
        eq(relations.repositoryId, repositoryId),
        eq(relations.sourceType, edge.source.type),
        eq(relations.sourceId, edge.source.id),
        eq(relations.relation, edge.relation),
        eq(relations.targetType, edge.target.type),
        eq(relations.targetId, edge.target.id),
      ),
    )
    .run();
}
