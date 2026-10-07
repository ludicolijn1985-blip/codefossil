import {
  commitEvidenceIds,
  deleteRelationsByProducer,
  externalIdsByNumber,
  findCommitBySha,
  findEvidenceId,
  listCommitMessages,
  listPullRequests,
  pendingClosingRefs,
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
  CLOSING_WINDOW,
  MAX_REFERENCE_TEXT,
  TrackerApiError,
  TrackerLimitError,
  type GitLabClient,
  type GitLabIssue,
  type GitLabMergeRequest,
} from '@codefossil/providers';
import { GITLAB_CLOSING_METHOD, type EntityRef, type RelationInput } from '@codefossil/shared';
import { revertedShas } from './reference-linker.js';

export const GITLAB_LINKER_PRODUCER = 'gitlab-linker@0.1.0';

/** A closing keyword closes the issue only once the change reaches the default branch. */
const CLOSING_KEYWORD_CONFIDENCE = 0.9;

export interface GitLabSyncResult {
  readonly issues: number;
  readonly mergeRequests: number;
  readonly detailsFetched: number;
  readonly requests: number;
  /** Why the sync stopped early (rate limit, budget, an API error); null when it completed. */
  readonly stoppedEarly: string | null;
}

/** Where each list was read up to: the `updated_at` of its newest item synced. */
interface Cursor {
  readonly issues?: string | undefined;
  readonly mergeRequests?: string | undefined;
}

function readCursor(connection: ProviderConnectionRow): Cursor {
  try {
    const parsed: unknown = JSON.parse(connection.cursor ?? '{}');
    if (typeof parsed !== 'object' || parsed === null) return {};
    const { issues, mergeRequests } = parsed as Record<string, unknown>;
    return {
      ...(typeof issues === 'string' ? { issues } : {}),
      ...(typeof mergeRequests === 'string' ? { mergeRequests } : {}),
    };
  } catch {
    return {};
  }
}

const common = (connection: ProviderConnectionRow, item: GitLabIssue | GitLabMergeRequest) => ({
  repositoryId: connection.repositoryId,
  provider: 'gitlab',
  number: item.iid,
  title: item.title,
  body: item.description ?? '',
  state: item.state === 'opened' ? 'open' : item.state,
  url: item.web_url,
  author: item.author?.username ?? null,
  labels: item.labels,
  createdAt: item.created_at,
  updatedAt: item.updated_at,
  closedAt: item.closed_at ?? null,
});

/**
 * Pull a GitLab project's issues and merge requests into the index: merge
 * request commits, merge commits and the issues GitLab records as closed by
 * each merged request. Incremental (a cursor per list) and resumable; a rate
 * limit, the request budget or an API error stops the sync cleanly and is
 * reported, never failing the index.
 */
export async function syncGitLab(
  db: FossilDb,
  connection: ProviderConnectionRow,
  client: GitLabClient,
  options: { readonly now?: () => Date } = {},
): Promise<GitLabSyncResult> {
  const now = options.now ?? (() => new Date());
  const project = connection.name;
  const counts = { issues: 0, mergeRequests: 0, detailsFetched: 0 };
  let stoppedEarly: string | null = null;
  try {
    const projectId = (await client.project(project)).id;
    let cursor = readCursor(connection);
    const issues = await client.issues(project, cursor.issues ?? null);
    db.transaction((tx) => {
      for (const issue of issues) upsertIssue(tx, common(connection, issue));
      cursor = { ...cursor, issues: issues.at(-1)?.updated_at ?? cursor.issues };
      updateSyncProgress(tx, connection.id, {
        cursor: JSON.stringify(cursor),
        lastSyncedAt: now().toISOString(),
      });
    });
    counts.issues = issues.length;

    const requests = await client.mergeRequests(project, cursor.mergeRequests ?? null);
    const byNumber = new Map(requests.map((mr) => [String(mr.iid), mr]));
    db.transaction((tx) => {
      for (const mr of requests) {
        upsertPullRequest(tx, { ...common(connection, mr), mergedAt: mr.merged_at ?? null });
      }
      cursor = {
        ...cursor,
        mergeRequests: requests.at(-1)?.updated_at ?? cursor.mergeRequests,
      };
      updateSyncProgress(tx, connection.id, {
        cursor: JSON.stringify(cursor),
        lastSyncedAt: now().toISOString(),
      });
    });
    counts.mergeRequests = requests.length;

    for (const pending of pendingPullRequestDetails(db, connection.repositoryId, 'gitlab')) {
      // One left pending by an earlier, interrupted run is not listed again: read it by number.
      const mr =
        byNumber.get(pending.externalId) ??
        (await client.mergeRequest(project, Number(pending.externalId)));

      const commitShas = await client.mergeRequestCommits(project, mr.iid);
      db.transaction((tx) => {
        savePullRequestDetails(
          tx,
          pending,
          {
            mergeCommitSha: mr.merge_commit_sha ?? mr.squash_commit_sha ?? null,
            mergedAt: mr.merged_at ?? null,
            baseBranch: mr.target_branch,
            headBranch: mr.source_branch,
            commitShas,
            reviews: [],
          },
          now().toISOString(),
        );
      });
      counts.detailsFetched++;
    }
    for (const merged of pendingClosingRefs(db, connection.repositoryId, 'gitlab')) {
      const closes = await client.closesIssues(project, Number(merged.externalId));
      db.transaction((tx) => {
        saveClosingRefs(
          tx,
          merged,
          closes
            .filter((issue) => issue.project_id === projectId)
            .map((issue) => ({ repo: project, number: issue.iid })),
          now().toISOString(),
        );
      });
    }
  } catch (error) {
    if (!(error instanceof TrackerApiError || error instanceof TrackerLimitError)) throw error;
    stoppedEarly = error.message;
  }
  return { ...counts, requests: client.requestsMade, stoppedEarly };
}

/** GitLab's default closing pattern (`Closes #12`, `Fixes #12`, `Resolves`, `Implements`). */
const CLOSING =
  /\b(?:clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|implement(?:s|ed|ing)?)[ \t]*:?[ \t]+$/i;
/** `#12` (an issue) or `!12` (a merge request), not part of a longer word, path or URL. */
const REFERENCE = /(^|[^\w/&#!.-])([#!])(\d+)\b/g;

interface GitLabReference {
  readonly number: number;
  readonly kind: 'issue' | 'merge_request';
  readonly closing: boolean;
}

/** References to the project's own issues (`#12`) and merge requests (`!12`) in text. */
export function parseGitLabReferences(text: string): GitLabReference[] {
  const found = new Map<string, GitLabReference>();
  for (const match of text.slice(0, MAX_REFERENCE_TEXT).matchAll(REFERENCE)) {
    const [, prefix = '', sigil = '', digits = ''] = match;
    const number = Number.parseInt(digits, 10);
    if (!Number.isSafeInteger(number) || number <= 0) continue;
    const kind = sigil === '!' ? 'merge_request' : 'issue';
    const key = `${kind}${String(number)}`;
    const end = match.index + prefix.length;
    const closing =
      kind === 'issue' && CLOSING.test(text.slice(Math.max(0, end - CLOSING_WINDOW), end));
    found.set(key, { number, kind, closing: (found.get(key)?.closing ?? false) || closing });
  }
  return [...found.values()];
}

type Draft = Omit<RelationInput, 'repositoryId' | 'provenance'> & {
  readonly method: string;
  readonly evidenceId: number | undefined;
};

/**
 * Rebuild the links between GitLab records and history:
 * - `pull_request IMPLEMENTED_BY commit` (FACT): the merge request's commits
 *   and its merge (or squash) commit, when they exist locally;
 * - `issue RESOLVED_BY pull_request` (FACT): GitLab records the merged request
 *   as closing the issue, unless it was reverted;
 * - `issue RESOLVED_BY commit` (DERIVED 0.9): a closing keyword in a commit
 *   message, unless reverted or a revert; in a merge request's text only when
 *   GitLab's own closing record is not known;
 * - `REFERENCES` (DERIVED 1) for other mentions of `#12` and `!12`.
 */
export function linkGitLabReferences(
  db: FossilDb,
  repositoryId: number,
  project: string,
  observedAt: string,
): {
  readonly pullRequestCommits: number;
  readonly resolutions: number;
  readonly references: number;
} {
  return db.transaction((tx) => {
    deleteRelationsByProducer(tx, repositoryId, GITLAB_LINKER_PRODUCER);
    const lookups = externalIdsByNumber(tx, repositoryId, 'gitlab');
    const commits = listCommitMessages(tx, repositoryId);
    const reverted = revertedShas(commits);
    const commitEvidence = commitEvidenceIds(tx, repositoryId);
    const drafts: Draft[] = [];

    const textDrafts = (
      source: EntityRef,
      text: string,
      landed: boolean,
      keywordsCount: boolean,
      evidenceId: number | undefined,
    ) => {
      for (const ref of parseGitLabReferences(text)) {
        const issueId = ref.kind === 'issue' ? lookups.issues.get(ref.number) : undefined;
        const mrId =
          ref.kind === 'merge_request' ? lookups.pullRequests.get(ref.number) : undefined;
        if (issueId !== undefined && ref.closing && landed && keywordsCount) {
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
            : mrId !== undefined
              ? { type: 'pull_request', id: mrId }
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

    for (const mr of listPullRequests(tx, repositoryId, 'gitlab')) {
      mergeRequestDrafts(
        tx,
        repositoryId,
        project,
        mr,
        lookups.issues,
        reverted,
        drafts,
        textDrafts,
      );
    }
    for (const commit of commits) {
      const text = `${commit.subject}\n${commit.body}`;
      const undone = /This reverts commit/i.test(text) || reverted.has(commit.sha);
      textDrafts(
        { type: 'commit', id: commit.id },
        text,
        !undone,
        true,
        commitEvidence.get(commit.sha),
      );
    }

    const result = { pullRequestCommits: 0, resolutions: 0, references: 0 };
    for (const { method, evidenceId, ...relation } of drafts) {
      recordRelation(tx, {
        ...relation,
        repositoryId,
        provenance: {
          producer: GITLAB_LINKER_PRODUCER,
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

function mergeRequestDrafts(
  db: FossilDb,
  repositoryId: number,
  project: string,
  mr: PullRequestRow,
  issues: ReadonlyMap<number, number>,
  reverted: ReadonlySet<string>,
  drafts: Draft[],
  textDrafts: (
    source: EntityRef,
    text: string,
    landed: boolean,
    keywordsCount: boolean,
    evidenceId: number | undefined,
  ) => void,
): void {
  const source = { type: 'pull_request', id: mr.id } as const;
  const evidenceId = mr.url ? findEvidenceId(db, repositoryId, 'pull_request', mr.url) : undefined;
  const shas = new Set(pullRequestCommitShas(db, mr.id));
  if (mr.mergedAt && mr.mergeCommitSha) shas.add(mr.mergeCommitSha);
  for (const sha of shas) {
    const commit = findCommitBySha(db, repositoryId, sha);
    if (!commit) continue;
    drafts.push({
      source,
      relation: 'IMPLEMENTED_BY',
      target: { type: 'commit', id: commit.id },
      evidenceType: 'FACT',
      confidence: 1,
      method: sha === mr.mergeCommitSha ? 'merge-commit' : 'merge-request-commits',
      evidenceId,
    });
  }
  const landed =
    mr.mergedAt !== null && !(mr.mergeCommitSha !== null && reverted.has(mr.mergeCommitSha));
  const self = project.toLowerCase();
  for (const ref of mr.closingRefsJson ?? []) {
    const issueId = ref.repo.toLowerCase() === self ? issues.get(ref.number) : undefined;
    if (issueId === undefined) continue;
    const issue = { type: 'issue', id: issueId } as const;
    drafts.push(
      landed
        ? {
            source: issue,
            relation: 'RESOLVED_BY',
            target: source,
            evidenceType: 'FACT',
            confidence: 1,
            method: GITLAB_CLOSING_METHOD,
            evidenceId,
          }
        : {
            source,
            relation: 'REFERENCES',
            target: issue,
            evidenceType: 'FACT',
            confidence: 1,
            method: GITLAB_CLOSING_METHOD,
            evidenceId,
          },
    );
  }
  // GitLab's own closing record, when known, decides what the request closes.
  textDrafts(source, `${mr.title}\n${mr.body}`, landed, mr.closingRefsJson === null, evidenceId);
}
