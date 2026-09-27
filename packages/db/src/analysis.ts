import { and, eq, inArray, like, or } from 'drizzle-orm';
import type { EvidenceLevel } from '@codefossil/shared';
import type { FossilDb } from './client.js';
import {
  commits,
  evidence,
  fileChanges,
  files,
  issues,
  pullRequests,
  relations,
  symbols,
  symbolVersions,
} from './schema.js';

/**
 * Bulk reads for the risk analyzers. Each loads a whole repository's worth of
 * one kind of row in a single query, so an analysis costs a handful of
 * queries however large the history is.
 */

/** Ids per `IN (…)` list, well below SQLite's bound-parameter limit. */
const ID_CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += ID_CHUNK) result.push(items.slice(i, i + ID_CHUNK));
  return result;
}

export interface AnalysisFile {
  readonly id: number;
  readonly path: string;
  readonly deletedAt: string | null;
}

export function analysisFiles(db: FossilDb, repositoryId: number): AnalysisFile[] {
  return db
    .select({ id: files.id, path: files.path, deletedAt: files.deletedAt })
    .from(files)
    .where(eq(files.repositoryId, repositoryId))
    .all();
}

export interface AnalysisChange {
  readonly fileId: number;
  readonly commitId: number;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly previousPath: string | null;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly committedAt: string;
}

export function analysisChanges(db: FossilDb, repositoryId: number): AnalysisChange[] {
  return db
    .select({
      fileId: fileChanges.fileId,
      commitId: fileChanges.commitId,
      status: fileChanges.status,
      previousPath: fileChanges.previousPath,
      additions: fileChanges.additions,
      deletions: fileChanges.deletions,
      committedAt: commits.committedAt,
    })
    .from(fileChanges)
    .innerJoin(commits, eq(fileChanges.commitId, commits.id))
    .where(eq(commits.repositoryId, repositoryId))
    .all();
}

export interface AnalysisCommit {
  readonly id: number;
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly committedAt: string;
}

export function analysisCommits(db: FossilDb, repositoryId: number): AnalysisCommit[] {
  return db
    .select({
      id: commits.id,
      sha: commits.sha,
      subject: commits.subject,
      body: commits.body,
      committedAt: commits.committedAt,
    })
    .from(commits)
    .where(eq(commits.repositoryId, repositoryId))
    .all();
}

/** `file IMPORTS file` edges of the graph snapshot at HEAD. */
export function fileImportEdges(
  db: FossilDb,
  repositoryId: number,
): { readonly source: number; readonly target: number }[] {
  return db
    .select({ source: relations.sourceId, target: relations.targetId })
    .from(relations)
    .where(
      and(
        eq(relations.repositoryId, repositoryId),
        eq(relations.relation, 'IMPORTS'),
        eq(relations.sourceType, 'file'),
        eq(relations.targetType, 'file'),
      ),
    )
    .all();
}

/** An issue or pull request linked to a commit, with the link's own certainty. */
export interface CommitDiscussion {
  readonly commitId: number;
  readonly type: 'issue' | 'pull_request';
  readonly number: string;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly relation: 'RESOLVED_BY' | 'IMPLEMENTED_BY' | 'REFERENCES';
  readonly level: EvidenceLevel;
  readonly confidence: number;
  readonly evidenceIds: readonly number[];
}

/** Issues and pull requests linked to commits (resolved, implemented or referenced). */
export function commitDiscussions(db: FossilDb, repositoryId: number): CommitDiscussion[] {
  const links = db
    .select({
      sourceType: relations.sourceType,
      sourceId: relations.sourceId,
      relation: relations.relation,
      targetType: relations.targetType,
      targetId: relations.targetId,
      level: relations.evidenceType,
      confidence: relations.confidence,
      provenance: relations.provenanceJson,
    })
    .from(relations)
    .where(
      and(
        eq(relations.repositoryId, repositoryId),
        inArray(relations.relation, ['RESOLVED_BY', 'IMPLEMENTED_BY', 'REFERENCES']),
        or(eq(relations.sourceType, 'commit'), eq(relations.targetType, 'commit')),
      ),
    )
    .all();

  const issueRows = new Map(
    db
      .select({
        id: issues.id,
        number: issues.externalId,
        title: issues.title,
        body: issues.body,
        labels: issues.labelsJson,
      })
      .from(issues)
      .where(eq(issues.repositoryId, repositoryId))
      .all()
      .map((row) => [row.id, row]),
  );
  const pullRows = new Map(
    db
      .select({
        id: pullRequests.id,
        number: pullRequests.externalId,
        title: pullRequests.title,
        body: pullRequests.body,
        labels: pullRequests.labelsJson,
      })
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, repositoryId))
      .all()
      .map((row) => [row.id, row]),
  );

  return links.flatMap((link): CommitDiscussion[] => {
    const commitSide = link.sourceType === 'commit' ? 'source' : 'target';
    const otherType = commitSide === 'source' ? link.targetType : link.sourceType;
    const otherId = commitSide === 'source' ? link.targetId : link.sourceId;
    const commitId = commitSide === 'source' ? link.sourceId : link.targetId;
    if (otherType !== 'issue' && otherType !== 'pull_request') return [];
    const row = (otherType === 'issue' ? issueRows : pullRows).get(otherId);
    if (!row) return [];
    return [
      {
        commitId,
        type: otherType,
        number: row.number,
        title: row.title,
        body: row.body,
        labels: row.labels ?? [],
        relation: link.relation as CommitDiscussion['relation'],
        level: link.level,
        confidence: link.confidence,
        evidenceIds: link.provenance.evidenceIds,
      },
    ];
  });
}

export interface ChangedSymbol {
  readonly commitId: number;
  readonly symbolId: number;
  readonly fileId: number;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly current: boolean;
}

/** Symbols that got a new version in any of the given commits. */
export function symbolsChangedIn(db: FossilDb, commitIds: readonly number[]): ChangedSymbol[] {
  return chunks(commitIds).flatMap((chunk) =>
    db
      .select({
        commitId: symbolVersions.commitId,
        symbolId: symbols.id,
        fileId: symbols.fileId,
        qualifiedName: symbols.qualifiedName,
        kind: symbols.kind,
        startLine: symbols.startLine,
        endLine: symbols.endLine,
        current: symbols.current,
      })
      .from(symbolVersions)
      .innerJoin(symbols, eq(symbolVersions.symbolId, symbols.id))
      .where(inArray(symbolVersions.commitId, chunk))
      .all(),
  );
}

/** Every commit that changed each of the given symbols. */
export function symbolChangeCommits(
  db: FossilDb,
  symbolIds: readonly number[],
): Map<number, number[]> {
  const result = new Map<number, number[]>();
  for (const chunk of chunks(symbolIds)) {
    const rows = db
      .select({ symbolId: symbolVersions.symbolId, commitId: symbolVersions.commitId })
      .from(symbolVersions)
      .where(inArray(symbolVersions.symbolId, chunk))
      .all();
    for (const row of rows) {
      const group = result.get(row.symbolId);
      if (group) group.push(row.commitId);
      else result.set(row.symbolId, [row.commitId]);
    }
  }
  return result;
}

export interface RuntimeEvidence {
  readonly evidenceId: number;
  readonly locator: string;
  readonly excerpt: string | null;
  readonly metadata: Record<string, unknown> | null;
}

/** Declared runtime support recorded from manifests at HEAD (`…#runtime:node`). */
export function runtimeEvidence(db: FossilDb, repositoryId: number): RuntimeEvidence[] {
  return db
    .select({
      evidenceId: evidence.id,
      locator: evidence.locator,
      excerpt: evidence.excerpt,
      metadata: evidence.metadataJson,
    })
    .from(evidence)
    .where(
      and(
        eq(evidence.repositoryId, repositoryId),
        eq(evidence.type, 'manifest'),
        like(evidence.locator, '%#runtime:%'),
      ),
    )
    .all();
}
