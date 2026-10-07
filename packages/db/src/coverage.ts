import { and, eq, inArray, sql } from 'drizzle-orm';
import type { FossilDb } from './client.js';
import { recordEvidence } from './evidence.js';
import { commits, evidence, files, lineCoverage } from './schema.js';

export interface CoverageReport {
  /** `path@generatedAt` of the report: unchanged when the report is. */
  readonly locator: string;
  /** The report's path relative to the repository root. */
  readonly path: string;
  /** When the report was written (its modification time). */
  readonly generatedAt: string;
  readonly files: readonly {
    readonly fileId: number;
    readonly found: readonly number[];
    readonly hit: readonly number[];
  }[];
}

/** Whether the coverage stored for the repository came from this exact report. */
export function hasCoverageReport(db: FossilDb, repositoryId: number, locator: string): boolean {
  return (
    db
      .select({ id: evidence.id })
      .from(evidence)
      .where(
        and(
          eq(evidence.repositoryId, repositoryId),
          eq(evidence.type, 'coverage'),
          eq(evidence.locator, locator),
        ),
      )
      .get() !== undefined
  );
}

/** Coverage evidence rows nothing cites any more (relations, investigations, coverage rows). */
function deleteUncitedCoverageEvidence(db: FossilDb, repositoryId: number): void {
  db.run(
    sql`DELETE FROM evidence WHERE repository_id = ${repositoryId} AND type = 'coverage'
          AND id NOT IN (SELECT evidence_id FROM line_coverage)
          AND id NOT IN (SELECT e.value FROM relations, json_each(relations.provenance_json, '$.evidenceIds') AS e
                         WHERE relations.repository_id = ${repositoryId})
          AND id NOT IN (SELECT e.value FROM investigations, json_each(investigations.evidence_ids_json) AS e
                         WHERE investigations.repository_id = ${repositoryId})`,
  );
}

function deleteRepositoryCoverage(db: FossilDb, repositoryId: number): void {
  const fileIds = db
    .select({ id: files.id })
    .from(files)
    .where(eq(files.repositoryId, repositoryId))
    .all()
    .map((row) => row.id);
  if (fileIds.length > 0)
    db.delete(lineCoverage).where(inArray(lineCoverage.fileId, fileIds)).run();
}

/** Replace the repository's line coverage with a report's, citing one evidence row for it. */
export function replaceCoverage(
  db: FossilDb,
  repositoryId: number,
  report: CoverageReport,
): number {
  deleteRepositoryCoverage(db, repositoryId);
  const { id: evidenceId } = recordEvidence(db, {
    repositoryId,
    type: 'coverage',
    locator: report.locator,
    excerpt: `lcov report ${report.path}: ${String(report.files.length)} files`,
    metadata: { path: report.path, generatedAt: report.generatedAt, format: 'lcov' },
  });
  for (const file of report.files) {
    db.insert(lineCoverage)
      .values({
        fileId: file.fileId,
        foundJson: [...file.found],
        hitJson: [...file.hit],
        evidenceId,
      })
      .run();
  }
  deleteUncitedCoverageEvidence(db, repositoryId);
  return evidenceId;
}

/** Forget the repository's line coverage (its report is gone). */
export function clearCoverage(db: FossilDb, repositoryId: number): void {
  deleteRepositoryCoverage(db, repositoryId);
  deleteUncitedCoverageEvidence(db, repositoryId);
}

export interface FileCoverage {
  readonly found: readonly number[];
  readonly hit: readonly number[];
  readonly evidenceId: number;
  /** The report's path relative to the repository root. */
  readonly report: string;
  /** When the report was written. */
  readonly generatedAt: string;
}

/** Line coverage per file of the repository, from the last report read. */
export function fileCoverage(db: FossilDb, repositoryId: number): Map<number, FileCoverage> {
  const rows = db
    .select({
      fileId: lineCoverage.fileId,
      found: lineCoverage.foundJson,
      hit: lineCoverage.hitJson,
      evidenceId: lineCoverage.evidenceId,
      metadata: evidence.metadataJson,
    })
    .from(lineCoverage)
    .innerJoin(files, eq(lineCoverage.fileId, files.id))
    .innerJoin(evidence, eq(lineCoverage.evidenceId, evidence.id))
    .where(eq(files.repositoryId, repositoryId))
    .all();
  return new Map(
    rows.map((row) => {
      const meta = (row.metadata ?? {}) as { path?: unknown; generatedAt?: unknown };
      return [
        row.fileId,
        {
          found: row.found,
          hit: row.hit,
          evidenceId: row.evidenceId,
          report: typeof meta.path === 'string' ? meta.path : '',
          generatedAt: typeof meta.generatedAt === 'string' ? meta.generatedAt : '',
        },
      ];
    }),
  );
}

/**
 * One file's line coverage, when the report is about its current content:
 * written no earlier than the file's last indexed commit. Undefined otherwise.
 */
export function currentFileCoverage(db: FossilDb, fileId: number): FileCoverage | undefined {
  const row = db
    .select({
      found: lineCoverage.foundJson,
      hit: lineCoverage.hitJson,
      evidenceId: lineCoverage.evidenceId,
      metadata: evidence.metadataJson,
      lastChangedAt: commits.committedAt,
    })
    .from(lineCoverage)
    .innerJoin(files, eq(lineCoverage.fileId, files.id))
    .innerJoin(evidence, eq(lineCoverage.evidenceId, evidence.id))
    .leftJoin(commits, eq(files.lastSeenCommitId, commits.id))
    .where(eq(lineCoverage.fileId, fileId))
    .get();
  if (!row || row.found.length === 0) return undefined;
  const meta = (row.metadata ?? {}) as { path?: unknown; generatedAt?: unknown };
  const generatedAt = typeof meta.generatedAt === 'string' ? meta.generatedAt : '';
  const written = Date.parse(generatedAt);
  const changed = row.lastChangedAt === null ? Number.NaN : Date.parse(row.lastChangedAt);
  if (!Number.isFinite(written) || !Number.isFinite(changed) || written < changed) return undefined;
  return {
    found: row.found,
    hit: row.hit,
    evidenceId: row.evidenceId,
    report: typeof meta.path === 'string' ? meta.path : '',
    generatedAt,
  };
}
