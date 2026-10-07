import {
  commitEvidenceIds,
  deleteRelationsByProducer,
  externalIdsByNumber,
  findCommitBySha,
  findCommitByShaPrefix,
  findEvidenceId,
  issueStates,
  listCommitMessages,
  listPullRequests,
  pendingPullRequestDetails,
  pullRequestCommitShas,
  recordRelation,
  saveClosingRefs,
  savePullRequestDetails,
  updateSyncProgress,
  upsertIssue,
  upsertPullRequest,
  type FossilDb,
  type ProviderConnectionRow,
  type PullRequestRow,
} from '@codefossil/db';
import {
  TrackerApiError,
  TrackerLimitError,
  type HostedPullRequest,
  type HostedWorkItem,
  type PullRequestHost,
  type PullRequestHostClient,
} from '@codefossil/providers';
import { AZURE_WORK_ITEM_METHOD, type EntityRef, type RelationInput } from '@codefossil/shared';
import { parseGitLabReferences } from './gitlab-sync.js';
import { revertedShas } from './reference-linker.js';

export const HOSTED_LINKER_PRODUCER = 'hosted-linker@0.1.0';

/** A closing keyword closes the work item only once the change reaches the default branch. */
const CLOSING_KEYWORD_CONFIDENCE = 0.9;
/** A work item linked to a completed pull request and closed: most were the work it did. */
const LINKED_WORK_ITEM_CONFIDENCE = 0.8;

export interface HostedSyncResult {
  readonly pullRequests: number;
  readonly workItems: number;
  readonly detailsFetched: number;
  readonly requests: number;
  /** Why the sync stopped early (rate limit, budget, an API error); null when it completed. */
  readonly stoppedEarly: string | null;
}

/** The merge commit as stored locally: abbreviated hashes are expanded when unambiguous. */
function localMerge(db: FossilDb, repositoryId: number, pr: HostedPullRequest) {
  if (!pr.mergeCommitSha) return undefined;
  return (
    findCommitBySha(db, repositoryId, pr.mergeCommitSha) ??
    findCommitByShaPrefix(db, repositoryId, pr.mergeCommitSha)
  );
}

/**
 * When a pull request was merged: the host's own record, else (Bitbucket keeps
 * none) the merge commit's date; null while neither is known, though its state
 * says it was merged.
 */
function mergedAt(db: FossilDb, repositoryId: number, pr: HostedPullRequest): string | null {
  if (pr.state !== 'merged') return null;
  return pr.mergedAt ?? localMerge(db, repositoryId, pr)?.committedAt ?? null;
}

const stored = (connection: ProviderConnectionRow, item: HostedPullRequest | HostedWorkItem) => ({
  repositoryId: connection.repositoryId,
  provider: connection.provider,
  number: item.number,
  title: item.title,
  body: item.body,
  state: item.state,
  url: item.url,
  author: item.author,
  labels: item.labels,
  createdAt: item.createdAt,
  updatedAt: item.updatedAt,
  closedAt: item.closedAt,
});

/**
 * Pull a Bitbucket or Azure Repos repository's pull requests into the index:
 * their commits, merge commits and (Azure) linked work items. Incremental and
 * resumable; a rate limit, the request budget or an API error stops the sync
 * cleanly and is reported, never failing the index.
 */
export async function syncHostedPullRequests(
  db: FossilDb,
  connection: ProviderConnectionRow,
  client: PullRequestHostClient,
  options: { readonly now?: () => Date } = {},
): Promise<HostedSyncResult> {
  const now = options.now ?? (() => new Date());
  const repositoryId = connection.repositoryId;
  const provider = client.provider;
  const counts = { pullRequests: 0, workItems: 0, detailsFetched: 0 };
  let stoppedEarly: string | null = null;
  try {
    const listed = await client.pullRequests(connection.cursor);
    const byNumber = new Map(listed.items.map((pr) => [pr.number, pr]));
    if (!client.listsAllUpdates) {
      // Listed by creation: re-read the ones still open here, which may have changed since.
      for (const open of listPullRequests(db, repositoryId, provider)) {
        const number = Number(open.externalId);
        if (open.state !== 'open' || byNumber.has(number)) continue;
        byNumber.set(number, await client.pullRequest(number));
      }
    }
    const items = [...byNumber.values()];
    db.transaction((tx) => {
      for (const pr of items) {
        upsertPullRequest(tx, {
          ...stored(connection, pr),
          mergedAt: mergedAt(tx, repositoryId, pr),
        });
      }
      updateSyncProgress(tx, connection.id, {
        cursor: listed.cursor ?? connection.cursor ?? '',
        lastSyncedAt: now().toISOString(),
      });
    });
    counts.pullRequests = items.length;

    for (const pending of pendingPullRequestDetails(db, repositoryId, provider)) {
      // One left pending by an earlier, interrupted run is read again by number.
      const number = Number(pending.externalId);
      const pr = byNumber.get(number) ?? (await client.pullRequest(number));
      const commitShas = await client.commits(number);
      const workItems = await client.workItems(number);
      db.transaction((tx) => {
        for (const item of workItems) upsertIssue(tx, stored(connection, item));
        savePullRequestDetails(
          tx,
          pending,
          {
            mergeCommitSha: localMerge(tx, repositoryId, pr)?.sha ?? pr.mergeCommitSha,
            mergedAt: mergedAt(tx, repositoryId, pr),
            baseBranch: pr.baseBranch,
            headBranch: pr.headBranch,
            commitShas,
            reviews: [],
          },
          now().toISOString(),
        );
        // The linked work items, kept with the pull request (in its closing-reference slot).
        saveClosingRefs(
          tx,
          pending,
          workItems.map((item) => ({ repo: '', number: item.number })),
          now().toISOString(),
        );
      });
      counts.detailsFetched++;
      counts.workItems += workItems.length;
    }
  } catch (error) {
    if (!(error instanceof TrackerApiError || error instanceof TrackerLimitError)) throw error;
    stoppedEarly = error.message;
  }
  return { ...counts, requests: client.requestsMade, stoppedEarly };
}

type Draft = Omit<RelationInput, 'repositoryId' | 'provenance'> & {
  readonly method: string;
  readonly evidenceId: number | undefined;
};

/**
 * Rebuild the links between a host's pull requests and history:
 * - `pull_request IMPLEMENTED_BY commit` (FACT): its commits and its merge
 *   commit, when they exist locally;
 * - Azure: a linked work item `RESOLVED_BY` a completed pull request when the
 *   item is closed (DERIVED 0.8), else the pull request `REFERENCES` it (FACT);
 * - Azure: `#12` in commit messages and pull request text names a stored work
 *   item (`REFERENCES`, DERIVED 1, or `RESOLVED_BY` DERIVED 0.9 after a closing
 *   keyword in a change that landed) and `!12` a pull request.
 */
export function linkHostedReferences(
  db: FossilDb,
  repositoryId: number,
  provider: PullRequestHost,
  observedAt: string,
): {
  readonly pullRequestCommits: number;
  readonly resolutions: number;
  readonly references: number;
} {
  const producer = `${provider}-${HOSTED_LINKER_PRODUCER}`;
  return db.transaction((tx) => {
    deleteRelationsByProducer(tx, repositoryId, producer);
    const lookups = externalIdsByNumber(tx, repositoryId, provider);
    const states = issueStates(tx, repositoryId, provider);
    const commits = listCommitMessages(tx, repositoryId);
    const reverted = revertedShas(commits);
    const drafts: Draft[] = [];

    const textDrafts = (source: EntityRef, text: string, landed: boolean, evidenceId?: number) => {
      if (provider !== 'azure') return;
      for (const ref of parseGitLabReferences(text)) {
        const issueId = ref.kind === 'issue' ? lookups.issues.get(ref.number) : undefined;
        const prId =
          ref.kind === 'merge_request' ? lookups.pullRequests.get(ref.number) : undefined;
        if (issueId !== undefined && ref.closing && landed) {
          drafts.push({
            source: { type: 'issue', id: issueId },
            relation: 'RESOLVED_BY',
            target: source,
            evidenceType: 'DERIVED',
            confidence: CLOSING_KEYWORD_CONFIDENCE,
            method: 'closing-keyword',
            evidenceId,
          });
          continue;
        }
        const target: EntityRef | null =
          issueId !== undefined
            ? { type: 'issue', id: issueId }
            : prId !== undefined
              ? { type: 'pull_request', id: prId }
              : null;
        if (!target || (target.type === source.type && target.id === source.id)) continue;
        drafts.push({
          source,
          relation: 'REFERENCES',
          target,
          evidenceType: 'DERIVED',
          confidence: 1,
          method: 'text-mention',
          evidenceId,
        });
      }
    };

    for (const pr of listPullRequests(tx, repositoryId, provider)) {
      const landed = pullRequestDrafts(
        tx,
        repositoryId,
        pr,
        lookups.issues,
        states,
        reverted,
        drafts,
      );
      textDrafts(
        { type: 'pull_request', id: pr.id },
        `${pr.title}\n${pr.body}`,
        landed,
        pr.url ? findEvidenceId(tx, repositoryId, 'pull_request', pr.url) : undefined,
      );
    }
    const commitEvidence = commitEvidenceIds(tx, repositoryId);
    for (const commit of commits) {
      const text = `${commit.subject}\n${commit.body}`;
      const undone = /This reverts commit/i.test(text) || reverted.has(commit.sha);
      textDrafts({ type: 'commit', id: commit.id }, text, !undone, commitEvidence.get(commit.sha));
    }

    const result = { pullRequestCommits: 0, resolutions: 0, references: 0 };
    for (const { method, evidenceId, ...relation } of drafts) {
      recordRelation(tx, {
        ...relation,
        repositoryId,
        provenance: {
          producer,
          method,
          evidenceIds: evidenceId === undefined ? [] : [evidenceId],
          observedAt,
        },
      });
      if (relation.relation === 'IMPLEMENTED_BY') result.pullRequestCommits++;
      else if (relation.relation === 'RESOLVED_BY') result.resolutions++;
      else result.references++;
    }
    return result;
  });
}

/** A pull request's commit links and linked work items; returns whether it landed. */
function pullRequestDrafts(
  db: FossilDb,
  repositoryId: number,
  pr: PullRequestRow,
  issues: ReadonlyMap<number, number>,
  states: ReadonlyMap<number, { readonly state: string; readonly closedAt: string | null }>,
  reverted: ReadonlySet<string>,
  drafts: Draft[],
): boolean {
  const source = { type: 'pull_request', id: pr.id } as const;
  const evidenceId = pr.url ? findEvidenceId(db, repositoryId, 'pull_request', pr.url) : undefined;
  const merged = pr.mergedAt !== null || pr.state === 'merged';
  // Bitbucket names merge commits by an abbreviated hash: expanded when it is unambiguous.
  const mergeCommit =
    merged && pr.mergeCommitSha
      ? (findCommitBySha(db, repositoryId, pr.mergeCommitSha) ??
        findCommitByShaPrefix(db, repositoryId, pr.mergeCommitSha))
      : undefined;
  const linked = new Map<number, string>();
  for (const sha of pullRequestCommitShas(db, pr.id)) {
    const commit = findCommitBySha(db, repositoryId, sha);
    if (commit) linked.set(commit.id, 'pull-request-commits');
  }
  if (mergeCommit) linked.set(mergeCommit.id, 'merge-commit');
  for (const [commitId, method] of linked) {
    drafts.push({
      source,
      relation: 'IMPLEMENTED_BY',
      target: { type: 'commit', id: commitId },
      evidenceType: 'FACT',
      confidence: 1,
      method,
      evidenceId,
    });
  }
  const landed = merged && !(mergeCommit && reverted.has(mergeCommit.sha));
  for (const ref of pr.closingRefsJson ?? []) {
    const issueId = issues.get(ref.number);
    if (issueId === undefined) continue;
    const issue = { type: 'issue', id: issueId } as const;
    const item = states.get(issueId);
    // Closed, and not before the pull request was opened: likely the work it did.
    const closedByIt =
      item?.state === 'closed' && (item.closedAt === null || item.closedAt >= pr.createdAt);
    drafts.push(
      landed && closedByIt
        ? {
            source: issue,
            relation: 'RESOLVED_BY',
            target: source,
            evidenceType: 'DERIVED',
            confidence: LINKED_WORK_ITEM_CONFIDENCE,
            method: AZURE_WORK_ITEM_METHOD,
            evidenceId,
          }
        : {
            source,
            relation: 'REFERENCES',
            target: issue,
            evidenceType: 'FACT',
            confidence: 1,
            method: AZURE_WORK_ITEM_METHOD,
            evidenceId,
          },
    );
  }
  return landed;
}
