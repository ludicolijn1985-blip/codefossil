import { and, asc, eq, max, or, sql } from 'drizzle-orm';
import type { FossilDb } from './client.js';
import { preparedFor } from './prepared.js';
import { commitParents, commits, fileChanges, files } from './schema.js';

export type CommitRow = typeof commits.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type FileChangeRow = typeof fileChanges.$inferSelect;

export interface NewCommit {
  readonly repositoryId: number;
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  readonly authoredAt: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly body: string;
}

/** Insert a commit and its ordered parent links. */
export function insertCommit(db: FossilDb, commit: NewCommit): CommitRow {
  const { parents, ...values } = commit;
  const { insertCommit, insertParent } = statements(db);
  const row = insertCommit.get(values);
  parents.forEach((parentSha, ordinal) => {
    insertParent.run({ commitId: row.id, parentSha, ordinal });
  });
  return row;
}

export function findCommitBySha(
  db: FossilDb,
  repositoryId: number,
  sha: string,
): CommitRow | undefined {
  return statements(db).findCommitBySha.get({ repositoryId, sha });
}

/** SHAs of every commit already stored for a repository. */
export function listCommitShas(db: FossilDb, repositoryId: number): Set<string> {
  return new Set(
    db
      .select({ sha: commits.sha })
      .from(commits)
      .where(eq(commits.repositoryId, repositoryId))
      .all()
      .map((row) => row.sha),
  );
}

export type FileTouch = {
  readonly repositoryId: number;
  readonly path: string;
  readonly language: string | null;
  readonly commitId: number;
  /** Set when this commit removed the path (deletion, or the old side of a rename). */
  readonly deletedAt: string | null;
};

/**
 * Record that a commit touched a path: creates the file on first sight, moves
 * `last_seen_commit_id` forward, and sets or clears `deleted_at` (a path can
 * be deleted and later re-added).
 */
export function recordFileTouch(db: FossilDb, touch: FileTouch): FileRow {
  const row = statements(db).touchFile.get(touch);
  return row;
}

export interface ReconcileResult {
  /** Files marked deleted because HEAD no longer contains them. */
  readonly markedDeleted: number;
  /** Files marked current because HEAD contains them. */
  readonly markedCurrent: number;
}

/**
 * Make each file's current/deleted state match the tree at HEAD, which is
 * observed directly rather than reconstructed from change order. A file absent
 * from HEAD gets the date of its latest recorded deletion; when none was
 * recorded (e.g. removed in a merge commit, whose diff is not indexed),
 * `fallbackDeletedAt` — the HEAD commit date, an upper bound — is used.
 */
export function reconcileFilesWithHead(
  db: FossilDb,
  repositoryId: number,
  headPaths: ReadonlySet<string>,
  fallbackDeletedAt: string,
): ReconcileResult {
  const { listFiles, setDeletedAt, latestDeletion } = statements(db);
  let markedDeleted = 0;
  let markedCurrent = 0;
  for (const file of listFiles.all({ repositoryId })) {
    const present = headPaths.has(file.path);
    if (present && file.deletedAt !== null) {
      setDeletedAt.run({ id: file.id, deletedAt: null });
      markedCurrent++;
    } else if (!present && file.deletedAt === null) {
      const deletion = latestDeletion.get({ fileId: file.id, path: file.path, repositoryId });
      setDeletedAt.run({ id: file.id, deletedAt: deletion?.at ?? fallbackDeletedAt });
      markedDeleted++;
    }
  }
  return { markedDeleted, markedCurrent };
}

export type NewFileChange = {
  readonly commitId: number;
  readonly fileId: number;
  readonly status: FileChangeRow['status'];
  readonly previousPath: string | null;
  readonly additions: number | null;
  readonly deletions: number | null;
};

export function insertFileChange(db: FossilDb, change: NewFileChange): FileChangeRow {
  const row = statements(db).insertFileChange.get(change);
  return row;
}

export function findFileByPath(
  db: FossilDb,
  repositoryId: number,
  path: string,
): FileRow | undefined {
  return db
    .select()
    .from(files)
    .where(and(eq(files.repositoryId, repositoryId), eq(files.path, path)))
    .get();
}

export interface FileHistoryEntry {
  readonly commitId: number;
  readonly sha: string;
  readonly committedAt: string;
  readonly authorName: string;
  readonly subject: string;
  readonly status: FileChangeRow['status'];
  readonly previousPath: string | null;
  readonly additions: number | null;
  readonly deletions: number | null;
}

/** Every recorded change to a file, oldest first. */
export function fileHistory(db: FossilDb, fileId: number): FileHistoryEntry[] {
  return db
    .select({
      commitId: commits.id,
      sha: commits.sha,
      committedAt: commits.committedAt,
      authorName: commits.authorName,
      subject: commits.subject,
      status: fileChanges.status,
      previousPath: fileChanges.previousPath,
      additions: fileChanges.additions,
      deletions: fileChanges.deletions,
    })
    .from(fileChanges)
    .innerJoin(commits, eq(fileChanges.commitId, commits.id))
    .where(eq(fileChanges.fileId, fileId))
    .orderBy(asc(commits.committedAt), asc(commits.id))
    .all();
}

/** SQL for the commit date of the commit id in `column`; missing commits sort first. */
const commitDate = (column: string) =>
  `COALESCE((SELECT committed_at FROM commits WHERE id = ${column}), '')`;

/** True when the incoming touch is at least as recent as the stored last touch. */
const IS_LATEST_TOUCH = `${commitDate('excluded.last_seen_commit_id')} >= ${commitDate('files.last_seen_commit_id')}`;

const statements = preparedFor((db) => ({
  insertCommit: db
    .insert(commits)
    .values({
      repositoryId: sql.placeholder('repositoryId'),
      sha: sql.placeholder('sha'),
      authorName: sql.placeholder('authorName'),
      authorEmail: sql.placeholder('authorEmail'),
      authoredAt: sql.placeholder('authoredAt'),
      committedAt: sql.placeholder('committedAt'),
      subject: sql.placeholder('subject'),
      body: sql.placeholder('body'),
    })
    .returning()
    .prepare(),
  insertParent: db
    .insert(commitParents)
    .values({
      commitId: sql.placeholder('commitId'),
      parentSha: sql.placeholder('parentSha'),
      ordinal: sql.placeholder('ordinal'),
    })
    .prepare(),
  findCommitBySha: db
    .select()
    .from(commits)
    .where(
      and(
        eq(commits.repositoryId, sql.placeholder('repositoryId')),
        eq(commits.sha, sql.placeholder('sha')),
      ),
    )
    .prepare(),
  // First sight inserts the file. Later touches are ordered by commit date, not
  // by processing order: topological order does not order unrelated branches.
  touchFile: db
    .insert(files)
    .values({
      repositoryId: sql.placeholder('repositoryId'),
      path: sql.placeholder('path'),
      language: sql.placeholder('language'),
      firstSeenCommitId: sql.placeholder('commitId'),
      lastSeenCommitId: sql.placeholder('commitId'),
      deletedAt: sql.placeholder('deletedAt'),
    })
    .onConflictDoUpdate({
      target: [files.repositoryId, files.path],
      set: {
        firstSeenCommitId: sql.raw(
          `CASE WHEN ${commitDate('excluded.first_seen_commit_id')} < ${commitDate('files.first_seen_commit_id')} ` +
            'THEN excluded.first_seen_commit_id ELSE files.first_seen_commit_id END',
        ),
        lastSeenCommitId: sql.raw(
          `CASE WHEN ${IS_LATEST_TOUCH} THEN excluded.last_seen_commit_id ELSE files.last_seen_commit_id END`,
        ),
        deletedAt: sql.raw(
          `CASE WHEN ${IS_LATEST_TOUCH} THEN excluded.deleted_at ELSE files.deleted_at END`,
        ),
      },
    })
    .returning()
    .prepare(),
  listFiles: db
    .select({ id: files.id, path: files.path, deletedAt: files.deletedAt })
    .from(files)
    .where(eq(files.repositoryId, sql.placeholder('repositoryId')))
    .prepare(),
  setDeletedAt: db
    .update(files)
    .set({ deletedAt: sql`${sql.placeholder('deletedAt')}` })
    .where(eq(files.id, sql.placeholder('id')))
    .prepare(),
  latestDeletion: db
    .select({ at: max(commits.committedAt) })
    .from(fileChanges)
    .innerJoin(commits, eq(fileChanges.commitId, commits.id))
    .where(
      or(
        and(eq(fileChanges.fileId, sql.placeholder('fileId')), eq(fileChanges.status, 'deleted')),
        and(
          eq(fileChanges.previousPath, sql.placeholder('path')),
          eq(fileChanges.status, 'renamed'),
          eq(commits.repositoryId, sql.placeholder('repositoryId')),
        ),
      ),
    )
    .prepare(),
  insertFileChange: db
    .insert(fileChanges)
    .values({
      commitId: sql.placeholder('commitId'),
      fileId: sql.placeholder('fileId'),
      status: sql.placeholder('status'),
      previousPath: sql.placeholder('previousPath'),
      additions: sql.placeholder('additions'),
      deletions: sql.placeholder('deletions'),
    })
    .returning()
    .prepare(),
}));

export function findFileById(db: FossilDb, fileId: number): FileRow | undefined {
  return db.select().from(files).where(eq(files.id, fileId)).get();
}
