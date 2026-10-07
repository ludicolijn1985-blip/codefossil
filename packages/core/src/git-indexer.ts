import { basename } from 'node:path';
import {
  findCommitBySha,
  insertCommit,
  insertFileChange,
  listCommitShas,
  markRepositoryIndexed,
  pruneUnreachableCommits,
  reconcileFilesWithHead,
  recordEvidence,
  recordFileTouch,
  recordRelation,
  registerRepository,
  type FossilDb,
} from '@codefossil/db';
import {
  isShallowRepository,
  listHeadFiles,
  listPresentCommits,
  listReachableShas,
  openGitRepository,
  readCommits,
  type GitCommit,
  type GitFileChange,
} from '@codefossil/git';
import { detectLanguage, type ProvenanceInput } from '@codefossil/shared';

export const GIT_INDEXER_PRODUCER = 'git-indexer@0.1.0';

/** Commits written per database transaction. */
const DEFAULT_BATCH_SIZE = 250;

export interface IndexOptions {
  /** Only index commits committed at or after this moment. */
  readonly since?: Date;
  /** Clock used for `indexed_at` and provenance timestamps. */
  readonly now?: () => Date;
  readonly batchSize?: number;
  /** Called after each batch with the running number of commits written. */
  readonly onProgress?: (commitsIndexed: number) => void;
}

export interface IndexResult {
  readonly repositoryId: number;
  readonly root: string;
  /** HEAD at the time of indexing, or null for a repository without commits. */
  readonly headSha: string | null;
  readonly commitsIndexed: number;
  readonly commitsSkipped: number;
  /** Indexed commits removed because HEAD's history no longer contains them. */
  readonly commitsPruned: number;
  readonly fileChanges: number;
  readonly relations: number;
}

interface BatchTotals {
  commitsIndexed: number;
  commitsSkipped: number;
  fileChanges: number;
  relations: number;
}

/**
 * Index the Git history of the repository containing `path`.
 *
 * Everything written here is a FACT read directly from git. After the
 * history pass, each file's current/deleted state is reconciled with the tree
 * at HEAD, because change order alone cannot decide it across branches.
 * Re-running is
 * incremental: commits already stored are skipped, so only new history is
 * written; commits no longer reachable from HEAD are pruned first. Each batch is one transaction, so an interrupted run never leaves
 * a half-written commit behind.
 */
export async function indexRepository(
  db: FossilDb,
  path: string,
  options: IndexOptions = {},
): Promise<IndexResult> {
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const git = await openGitRepository(path);
  const repository = registerRepository(db, {
    path: git.root,
    name: basename(git.root),
    remoteUrl: git.remoteUrl,
    // The checked-out branch is the best local signal; the remote default may differ.
    defaultBranch: git.currentBranch,
  });

  let commitsPruned = 0;
  const totals: BatchTotals = {
    commitsIndexed: 0,
    commitsSkipped: 0,
    fileChanges: 0,
    relations: 0,
  };
  if (git.headSha) {
    // Only history reachable from HEAD may be cited: drop commits a reset, rebase,
    // deleted branch or checkout left behind before adding new ones.
    const headPaths = await listHeadFiles(git.root);
    commitsPruned = pruneUnreachableCommits(
      db,
      repository.id,
      await historyToKeep(git.root, listCommitShas(db, repository.id)),
      headPaths,
    ).commitsPruned;
    const known = listCommitShas(db, repository.id);
    const observedAt = now().toISOString();
    let batch: GitCommit[] = [];
    const flush = () => {
      db.transaction((tx) => {
        for (const commit of batch) {
          writeCommit(tx, repository.id, commit, known, observedAt, totals);
        }
      });
      batch = [];
      options.onProgress?.(totals.commitsIndexed);
    };

    const readOptions = options.since ? { since: options.since } : {};
    for await (const commit of readCommits(git.root, readOptions)) {
      batch.push(commit);
      if (batch.length >= batchSize) flush();
    }
    if (batch.length > 0) flush();

    const headCommittedAt =
      findCommitBySha(db, repository.id, git.headSha)?.committedAt ?? observedAt;
    db.transaction((tx) => {
      reconcileFilesWithHead(tx, repository.id, headPaths, headCommittedAt);
    });
  }

  markRepositoryIndexed(db, repository.id, now());
  return {
    repositoryId: repository.id,
    root: git.root,
    headSha: git.headSha,
    commitsPruned,
    ...totals,
  };
}

/**
 * The commits the index may keep: those reachable from HEAD. A shallow clone
 * lacks older history, and an indexed commit it does not have cannot be told
 * apart from such history, so those are kept too rather than deleted.
 */
async function historyToKeep(root: string, indexed: ReadonlySet<string>): Promise<Set<string>> {
  const reachable = await listReachableShas(root);
  if (!(await isShallowRepository(root))) return reachable;
  const candidates = [...indexed].filter((sha) => !reachable.has(sha));
  const present = await listPresentCommits(root, candidates);
  for (const sha of candidates) if (!present.has(sha)) reachable.add(sha);
  return reachable;
}

function writeCommit(
  db: FossilDb,
  repositoryId: number,
  commit: GitCommit,
  known: Set<string>,
  observedAt: string,
  totals: BatchTotals,
): void {
  if (known.has(commit.sha)) {
    totals.commitsSkipped++;
    return;
  }

  const row = insertCommit(db, { repositoryId, ...commit });
  const evidence = recordEvidence(db, {
    repositoryId,
    type: 'commit',
    locator: commit.sha,
    excerpt: commit.subject,
  });
  const provenance = (method: string): ProvenanceInput => ({
    producer: GIT_INDEXER_PRODUCER,
    method,
    evidenceIds: [evidence.id],
    observedAt,
  });

  for (const parentSha of commit.parents) {
    // A parent outside the indexed range (e.g. before --since) has no row; the
    // link is still kept in commit_parents but no relation can point at it.
    const parent = findCommitBySha(db, repositoryId, parentSha);
    if (!parent) continue;
    recordRelation(db, {
      repositoryId,
      source: { type: 'commit', id: parent.id },
      relation: 'PARENT_OF',
      target: { type: 'commit', id: row.id },
      evidenceType: 'FACT',
      confidence: 1,
      provenance: provenance('git-log-parents'),
    });
    totals.relations++;
  }

  for (const change of commit.changes) {
    const fileId = writeFileChange(db, repositoryId, row.id, commit.committedAt, change);
    recordRelation(db, {
      repositoryId,
      source: { type: 'commit', id: row.id },
      relation: 'MODIFIES',
      target: { type: 'file', id: fileId },
      evidenceType: 'FACT',
      confidence: 1,
      provenance: provenance('git-log-raw'),
    });
    totals.fileChanges++;
    totals.relations++;
  }

  known.add(commit.sha);
  totals.commitsIndexed++;
}

/** Update the file rows a change affects and store the change. Returns the resulting file's id. */
function writeFileChange(
  db: FossilDb,
  repositoryId: number,
  commitId: number,
  committedAt: string,
  change: GitFileChange,
): number {
  if (change.previousPath) {
    recordFileTouch(db, {
      repositoryId,
      path: change.previousPath,
      language: detectLanguage(change.previousPath),
      commitId,
      deletedAt: committedAt,
    });
  }
  const file = recordFileTouch(db, {
    repositoryId,
    path: change.path,
    language: detectLanguage(change.path),
    commitId,
    deletedAt: change.status === 'deleted' ? committedAt : null,
  });
  insertFileChange(db, {
    commitId,
    fileId: file.id,
    status: change.status,
    previousPath: change.previousPath,
    additions: change.additions,
    deletions: change.deletions,
  });
  return file.id;
}
