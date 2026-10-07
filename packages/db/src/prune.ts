import { sql, type SQL } from 'drizzle-orm';
import type { FossilDb } from './client.js';

export interface PruneResult {
  /** Indexed commits that are no longer reachable from HEAD, now removed. */
  readonly commitsPruned: number;
  /** Files whose symbol history is rebuilt from the commits that remain. */
  readonly filesReset: number;
  /** Files known only from pruned commits, now removed. */
  readonly filesRemoved: number;
}

const NOTHING_PRUNED: PruneResult = { commitsPruned: 0, filesReset: 0, filesRemoved: 0 };

/** A JSON array parameter read back with `json_each`, so a list of any size is one bound value. */
const jsonList = (values: Iterable<number | string>): SQL =>
  sql`(SELECT value FROM json_each(${JSON.stringify([...values])}))`;

const ids = (rows: readonly { id: number }[]): number[] => rows.map((row) => row.id);

/**
 * Remove every indexed commit that is not in `reachable` (the history of HEAD)
 * together with what was derived from it, so answers never cite a commit
 * outside HEAD's history (after a reset, a rebase, a deleted branch or a
 * checkout of an older revision).
 *
 * - Relations with a pruned commit as an endpoint are removed.
 * - Files those commits touched (and files linked to them by renames) lose
 *   their symbols, which the symbol indexer rebuilds from the remaining
 *   changes, re-marked as pending here. A file left without history that is
 *   absent from HEAD is removed.
 * - The import and call snapshot is dropped and the graph marked unindexed: unchanged
 *   files would otherwise keep evidence located at the old HEAD.
 * - Evidence that only the removed records cited is removed; evidence a saved
 *   investigation still cites is kept.
 *
 * GitHub records and saved investigations are untouched; links from GitHub to
 * the remaining commits are rebuilt by the linker on every index run.
 */
export function pruneUnreachableCommits(
  db: FossilDb,
  repositoryId: number,
  reachable: ReadonlySet<string>,
  headPaths: ReadonlySet<string>,
): PruneResult {
  return db.transaction((tx) => {
    const pruned = tx
      .all<{ id: number; sha: string }>(
        sql`SELECT id, sha FROM commits WHERE repository_id = ${repositoryId}`,
      )
      .filter((row) => !reachable.has(row.sha));
    if (pruned.length === 0) return NOTHING_PRUNED;
    const prunedCommits = jsonList(ids(pruned));

    const affected = affectedFiles(tx, repositoryId, prunedCommits);
    const spans = remainingSpans(tx, repositoryId, affected, prunedCommits);
    const removed = new Set(
      affected
        .filter((file) => !headPaths.has(file.path) && !spans.has(file.id))
        .map((file) => file.id),
    );
    const kept = affected.filter((file) => !removed.has(file.id));
    const removedFiles = jsonList(removed);
    const symbols = jsonList(
      ids(
        tx.all<{ id: number }>(
          sql`SELECT id FROM symbols WHERE file_id IN ${jsonList(affected.map((f) => f.id))}`,
        ),
      ),
    );
    const importEvidence = tx
      .all<{ id: number }>(
        sql`SELECT i.evidence_id AS id FROM imports i JOIN files f ON f.id = i.file_id
            WHERE f.repository_id = ${repositoryId} AND i.evidence_id IS NOT NULL`,
      )
      .map((row) => row.id);

    const doomed = sql`relations.repository_id = ${repositoryId} AND (
      (relations.source_type = 'commit' AND relations.source_id IN ${prunedCommits}) OR
      (relations.target_type = 'commit' AND relations.target_id IN ${prunedCommits}) OR
      (relations.source_type = 'symbol' AND relations.source_id IN ${symbols}) OR
      (relations.target_type = 'symbol' AND relations.target_id IN ${symbols}) OR
      (relations.source_type = 'file' AND relations.source_id IN ${removedFiles}) OR
      (relations.target_type = 'file' AND relations.target_id IN ${removedFiles}) OR
      relations.id IN (SELECT r.id FROM relations r, json_each(r.provenance_json, '$.evidenceIds') AS cited
                       WHERE r.repository_id = ${repositoryId} AND cited.value IN ${jsonList(importEvidence)}))`;
    const candidates = new Set([
      ...importEvidence,
      ...tx
        .all<{ id: number }>(
          sql`SELECT DISTINCT cited.value AS id FROM relations,
                json_each(relations.provenance_json, '$.evidenceIds') AS cited WHERE ${doomed}`,
        )
        .map((row) => row.id),
      ...ids(
        tx.all<{ id: number }>(
          sql`SELECT id FROM evidence WHERE repository_id = ${repositoryId} AND type = 'commit'
                AND locator IN ${jsonList(pruned.map((c) => c.sha))}`,
        ),
      ),
    ]);

    tx.run(sql`DELETE FROM relations WHERE ${doomed}`);
    tx.run(sql`DELETE FROM symbols WHERE id IN ${symbols}`);
    const repositoryFiles = sql`(SELECT id FROM files WHERE repository_id = ${repositoryId})`;
    tx.run(sql`DELETE FROM imports WHERE file_id IN ${repositoryFiles}`);
    tx.run(sql`DELETE FROM calls WHERE file_id IN ${repositoryFiles}`);
    tx.run(sql`UPDATE repositories SET graph_indexed_sha = NULL WHERE id = ${repositoryId}`);
    for (const file of kept) {
      const span = spans.get(file.id);
      tx.run(
        sql`UPDATE files SET first_seen_commit_id = ${span?.first.id ?? null},
              last_seen_commit_id = ${span?.last.id ?? null}, deleted_at = NULL
            WHERE id = ${file.id}`,
      );
    }
    tx.run(
      sql`UPDATE file_changes SET symbols_indexed_at = NULL
            WHERE file_id IN ${jsonList(kept.map((f) => f.id))} AND commit_id NOT IN ${prunedCommits}`,
    );
    tx.run(sql`DELETE FROM files WHERE id IN ${removedFiles}`);
    tx.run(sql`DELETE FROM commits WHERE id IN ${prunedCommits}`);
    deleteUncitedEvidence(tx, repositoryId, candidates);

    return { commitsPruned: pruned.length, filesReset: kept.length, filesRemoved: removed.size };
  });
}

interface AffectedFile {
  readonly id: number;
  readonly path: string;
}

/**
 * Files the pruned commits touched, closed over renames (symbols move along a
 * rename, so both sides are rebuilt together) and over copies (a symbol
 * `COPIED_FROM` a rebuilt symbol is re-derived with it, since its source may
 * no longer exist).
 */
function affectedFiles(db: FossilDb, repositoryId: number, pruned: SQL): AffectedFile[] {
  const found = new Map<number, AffectedFile>();
  const add = (rows: AffectedFile[]) => {
    let grew = false;
    for (const row of rows) {
      if (!found.has(row.id)) {
        found.set(row.id, row);
        grew = true;
      }
    }
    return grew;
  };
  add(
    db.all<AffectedFile>(
      sql`SELECT id, path FROM files WHERE repository_id = ${repositoryId} AND (
            id IN (SELECT file_id FROM file_changes WHERE commit_id IN ${pruned}) OR
            path IN (SELECT previous_path FROM file_changes
                     WHERE commit_id IN ${pruned} AND previous_path IS NOT NULL) OR
            first_seen_commit_id IN ${pruned} OR last_seen_commit_id IN ${pruned})`,
    ),
  );
  for (;;) {
    const current = [...found.values()];
    const linked = db.all<AffectedFile>(
      sql`SELECT id, path FROM files WHERE repository_id = ${repositoryId} AND (
            path IN (SELECT previous_path FROM file_changes
                     WHERE file_id IN ${jsonList(current.map((f) => f.id))} AND status = 'renamed') OR
            id IN (SELECT fc.file_id FROM file_changes fc JOIN files f ON f.id = fc.file_id
                   WHERE f.repository_id = ${repositoryId} AND fc.status = 'renamed'
                     AND fc.previous_path IN ${jsonList(current.map((f) => f.path))}) OR
            id IN (SELECT copy.file_id FROM relations r
                   JOIN symbols copy ON copy.id = r.source_id
                   JOIN symbols origin ON origin.id = r.target_id
                   WHERE r.repository_id = ${repositoryId} AND r.relation = 'COPIED_FROM'
                     AND r.source_type = 'symbol' AND r.target_type = 'symbol'
                     AND origin.file_id IN ${jsonList(current.map((f) => f.id))}))`,
    );
    if (!add(linked)) return [...found.values()];
  }
}

interface Touch {
  readonly id: number;
  readonly committedAt: string;
}

interface Span {
  readonly first: Touch;
  readonly last: Touch;
}

const earlier = (a: Touch, b: Touch) =>
  a.committedAt < b.committedAt || (a.committedAt === b.committedAt && a.id < b.id);

/**
 * First and last remaining commit that touched each affected file, directly
 * or as the old side of a rename (as `recordFileTouch` counts them). A file
 * missing from the map has no remaining history. Two set-based queries, so the
 * cost does not grow with one scan per file.
 */
function remainingSpans(
  db: FossilDb,
  repositoryId: number,
  affected: readonly AffectedFile[],
  pruned: SQL,
): Map<number, Span> {
  const touches = [
    ...db.all<Touch & { fileId: number }>(
      sql`SELECT fc.file_id AS fileId, c.id, c.committed_at AS committedAt
          FROM file_changes fc JOIN commits c ON c.id = fc.commit_id
          WHERE fc.file_id IN ${jsonList(affected.map((f) => f.id))} AND c.id NOT IN ${pruned}`,
    ),
    ...renameSourceTouches(db, repositoryId, affected, pruned),
  ];
  const spans = new Map<number, Span>();
  for (const { fileId, id, committedAt } of touches) {
    const touch = { id, committedAt };
    const span = spans.get(fileId);
    spans.set(
      fileId,
      span
        ? {
            first: earlier(touch, span.first) ? touch : span.first,
            last: earlier(span.last, touch) ? touch : span.last,
          }
        : { first: touch, last: touch },
    );
  }
  return spans;
}

function renameSourceTouches(
  db: FossilDb,
  repositoryId: number,
  affected: readonly AffectedFile[],
  pruned: SQL,
): (Touch & { fileId: number })[] {
  const idByPath = new Map(affected.map((file) => [file.path, file.id]));
  return db
    .all<Touch & { path: string }>(
      sql`SELECT fc.previous_path AS path, c.id, c.committed_at AS committedAt
          FROM file_changes fc JOIN commits c ON c.id = fc.commit_id
          WHERE c.repository_id = ${repositoryId} AND fc.status = 'renamed'
            AND fc.previous_path IN ${jsonList(idByPath.keys())} AND c.id NOT IN ${pruned}`,
    )
    .flatMap(({ path, id, committedAt }) => {
      const fileId = idByPath.get(path);
      return fileId === undefined ? [] : [{ fileId, id, committedAt }];
    });
}

/** Delete the candidate evidence rows that no remaining relation, investigation or import cites. */
function deleteUncitedEvidence(db: FossilDb, repositoryId: number, candidates: Set<number>): void {
  if (candidates.size === 0) return;
  db.run(
    sql`DELETE FROM evidence WHERE repository_id = ${repositoryId} AND id IN ${jsonList(candidates)}
          AND id NOT IN (SELECT e.value FROM relations, json_each(relations.provenance_json, '$.evidenceIds') AS e
                         WHERE relations.repository_id = ${repositoryId})
          AND id NOT IN (SELECT e.value FROM investigations, json_each(investigations.evidence_ids_json) AS e
                         WHERE investigations.repository_id = ${repositoryId})
          AND id NOT IN (SELECT evidence_id FROM imports WHERE evidence_id IS NOT NULL)`,
  );
}
