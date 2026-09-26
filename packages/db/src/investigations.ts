import { and, desc, eq, inArray } from 'drizzle-orm';
import type { EvidenceLevel } from '@codefossil/shared';
import type { FossilDb } from './client.js';
import { investigations, symbols, symbolVersions } from './schema.js';

export type InvestigationRow = typeof investigations.$inferSelect;

export interface NewInvestigation {
  readonly repositoryId: number;
  readonly query: string;
  readonly kind: NonNullable<InvestigationRow['kind']>;
  readonly targetKey: string;
  readonly answer: string;
  readonly confidence: number;
  readonly classification: EvidenceLevel;
  readonly evidenceIds: readonly number[];
  readonly result: unknown;
  readonly headSha: string | null;
}

/** Record an investigation and the evidence its answer rests on. */
export function saveInvestigation(db: FossilDb, investigation: NewInvestigation): InvestigationRow {
  const { evidenceIds, result, ...values } = investigation;
  return db
    .insert(investigations)
    .values({ ...values, evidenceIdsJson: [...new Set(evidenceIds)], resultJson: result })
    .returning()
    .get();
}

/** Past investigations, newest first. */
export function listInvestigations(
  db: FossilDb,
  repositoryId: number,
  limit = 20,
): InvestigationRow[] {
  return db
    .select()
    .from(investigations)
    .where(eq(investigations.repositoryId, repositoryId))
    .orderBy(desc(investigations.createdAt), desc(investigations.id))
    .limit(limit)
    .all();
}

export function getInvestigation(
  db: FossilDb,
  repositoryId: number,
  id: number,
): InvestigationRow | undefined {
  return db
    .select()
    .from(investigations)
    .where(and(eq(investigations.repositoryId, repositoryId), eq(investigations.id, id)))
    .get();
}

/** Qualified names of symbols in `fileIds` that got a new version in `commitId`. */
export function symbolsChangedInCommit(
  db: FossilDb,
  commitId: number,
  fileIds: readonly number[],
): string[] {
  if (fileIds.length === 0) return [];
  return db
    .select({ name: symbols.qualifiedName })
    .from(symbolVersions)
    .innerJoin(symbols, eq(symbolVersions.symbolId, symbols.id))
    .where(and(eq(symbolVersions.commitId, commitId), inArray(symbols.fileId, [...fileIds])))
    .orderBy(symbols.startLine)
    .all()
    .map((row) => row.name);
}
