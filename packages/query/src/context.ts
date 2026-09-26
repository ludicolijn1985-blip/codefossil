import {
  entityKey,
  findEvidenceId,
  incomingRelations,
  loadEntityRecords,
  outgoingRelations,
  type EntityRecord,
  type FossilDb,
  type RelationRow,
} from '@codefossil/db';
import type { EntityRef } from '@codefossil/shared';
import { labelOf } from './describe.js';
import { day, firstParagraph, type RelatedEntity, type Statement } from './statements.js';

export type CommitRecord = Extract<EntityRecord, { type: 'commit' }>;

export function recordOf(db: FossilDb, ref: EntityRef): EntityRecord | undefined {
  return loadEntityRecords(db, [ref]).get(entityKey(ref));
}

const endpoint = (row: RelationRow, side: 'source' | 'target'): EntityRef =>
  side === 'source'
    ? { type: row.sourceType, id: row.sourceId }
    : { type: row.targetType, id: row.targetId };

/** Neighbours along one relation, with their records. */
export function linked(
  db: FossilDb,
  repositoryId: number,
  ref: EntityRef,
  relation: RelationRow['relation'],
  direction: 'out' | 'in',
): { row: RelationRow; record: EntityRecord }[] {
  const rows = (
    direction === 'out'
      ? outgoingRelations(db, repositoryId, ref)
      : incomingRelations(db, repositoryId, ref)
  ).filter((row) => row.relation === relation);
  const other = rows.map((row) => endpoint(row, direction === 'out' ? 'target' : 'source'));
  const records = loadEntityRecords(db, other);
  return rows.flatMap((row, i) => {
    const target = other[i];
    const record = target ? records.get(entityKey(target)) : undefined;
    return record ? [{ row, record }] : [];
  });
}

export const commitEvidence = (db: FossilDb, repositoryId: number, commit: CommitRecord) =>
  findEvidenceId(db, repositoryId, 'commit', commit.sha);

export function describeCommit(commit: CommitRecord): string {
  return `commit ${commit.sha.slice(0, 7)} "${commit.subject}" by ${commit.authorName} on ${day(commit.committedAt)}`;
}

export interface CommitContext {
  readonly statements: Statement[];
  readonly related: RelatedEntity[];
}

/**
 * Why a commit was made, as far as the evidence shows: its own message, the
 * pull request that carried it, and the issues those resolve. `base` is the
 * confidence of the chain that led to this commit; every statement here
 * depends on it.
 */
export function commitContext(
  db: FossilDb,
  repositoryId: number,
  commit: CommitRecord,
  base: { readonly confidence: number },
): CommitContext {
  const statements: Statement[] = [];
  const related: RelatedEntity[] = [];
  const ref = { type: 'commit', id: commit.id } as const;
  const evidenceId = commitEvidence(db, repositoryId, commit);

  const message = firstParagraph(commit.body);
  if (message) {
    statements.push({
      text: `Its commit message explains: "${message}"`,
      role: 'commit message',
      level: 'FACT',
      confidence: base.confidence,
      evidenceIds: evidenceId === undefined ? [] : [evidenceId],
    });
  }

  for (const { row, record } of linked(db, repositoryId, ref, 'IMPLEMENTED_BY', 'in')) {
    if (record.type !== 'pull_request') continue;
    const merged = record.mergedAt ? `, merged on ${day(record.mergedAt)}` : '';
    const prConfidence = base.confidence * row.confidence;
    statements.push({
      text: `It is part of pull request #${record.number} "${record.title}"${merged}.`,
      role: 'pull request carrying the change',
      level: row.evidenceType,
      confidence: prConfidence,
      evidenceIds: row.provenanceJson.evidenceIds,
    });
    const prRef = { type: 'pull_request', id: record.id } as const;
    for (const resolution of linked(db, repositoryId, prRef, 'RESOLVED_BY', 'in')) {
      statements.push(
        resolutionStatement(resolution, `pull request #${record.number}`, prConfidence),
      );
    }
    for (const mention of linked(db, repositoryId, prRef, 'REFERENCES', 'out')) {
      related.push({
        key: entityKey(mention.record),
        label: labelOf(mention.record),
        relation: `mentioned by pull request #${record.number}`,
      });
    }
  }

  for (const resolution of linked(db, repositoryId, ref, 'RESOLVED_BY', 'in')) {
    statements.push(resolutionStatement(resolution, 'the commit itself', base.confidence));
  }
  for (const mention of linked(db, repositoryId, ref, 'REFERENCES', 'out')) {
    related.push({
      key: entityKey(mention.record),
      label: labelOf(mention.record),
      relation: 'mentioned in the commit message',
    });
  }
  return { statements, related };
}

function resolutionStatement(
  { row, record }: { row: RelationRow; record: EntityRecord },
  resolver: string,
  base: number,
): Statement {
  const issue =
    record.type === 'issue' ? `issue #${record.number} "${record.title}"` : labelOf(record);
  return {
    text:
      `${resolver[0]?.toUpperCase() ?? ''}${resolver.slice(1)} resolves ${issue} ` +
      `(closing keyword; confidence ${row.confidence.toFixed(2)}).`,
    role: 'resolved issue',
    level: row.evidenceType,
    confidence: base * row.confidence,
    evidenceIds: row.provenanceJson.evidenceIds,
  };
}
