import {
  pendingPullRequestDetails,
  savePullRequestDetails,
  updateSyncProgress,
  upsertIssue,
  upsertPullRequest,
  type FossilDb,
  type ProviderConnectionRow,
  type PullRequestRow,
} from '@codefossil/db';
import {
  GitHubRateLimitError,
  issueItemSchema,
  labelNames,
  pullCommitSchema,
  pullDetailSchema,
  RequestBudgetExhaustedError,
  reviewSchema,
  type GitHubClient,
  type IssueItem,
  type Page,
} from '@codefossil/providers';
import type { z } from 'zod';

/** GitHub caps the commit list of a pull request at 250. */
const MAX_PULL_COMMIT_PAGES = 3;

export interface GitHubSyncResult {
  readonly issues: number;
  readonly pullRequests: number;
  readonly detailsFetched: number;
  /** Pull requests still waiting for commits, reviews and merge details. */
  readonly detailsPending: number;
  readonly requests: number;
  /** Why the sync stopped early (rate limit, request budget); null when it completed. */
  readonly stoppedEarly: string | null;
}

interface Counters {
  issues: number;
  pullRequests: number;
  detailsFetched: number;
}

/**
 * Pull issues, pull requests and review data from GitHub into the index.
 *
 * The sync is incremental and resumable: issues and pull requests are read
 * oldest-updated first from a cursor saved after every page, and pull request
 * details are a queue worked off within the client's request budget. When
 * GitHub's rate limit or the budget is reached the sync stops cleanly and the
 * next run continues where this one ended. Everything stored is data as
 * GitHub reports it; issue and PR text is never interpreted as instructions.
 */
export async function syncGitHub(
  db: FossilDb,
  connection: ProviderConnectionRow,
  client: GitHubClient,
  options: { readonly now?: () => Date } = {},
): Promise<GitHubSyncResult> {
  const now = options.now ?? (() => new Date());
  const counters: Counters = { issues: 0, pullRequests: 0, detailsFetched: 0 };
  const repoPath = `/repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.name)}`;
  let stoppedEarly: string | null = null;

  try {
    await syncItems(db, connection, client, repoPath, counters, now);
    await syncPullRequestDetails(db, connection.repositoryId, client, repoPath, counters, now);
  } catch (error) {
    if (!(error instanceof GitHubRateLimitError || error instanceof RequestBudgetExhaustedError)) {
      throw error;
    }
    stoppedEarly = error.message;
  }

  return {
    ...counters,
    detailsPending: pendingPullRequestDetails(db, connection.repositoryId).length,
    requests: client.requestsMade,
    stoppedEarly,
  };
}

async function syncItems(
  db: FossilDb,
  connection: ProviderConnectionRow,
  client: GitHubClient,
  repoPath: string,
  counters: Counters,
  now: () => Date,
): Promise<void> {
  const query: Record<string, string> = { state: 'all', sort: 'updated', direction: 'asc' };
  if (connection.cursor) query.since = connection.cursor;

  let cursor = connection.cursor;
  let page: Page<IssueItem[]> | null = await client.getList(
    `${repoPath}/issues`,
    issueItemSchema,
    query,
  );
  while (page) {
    const items = page.items;
    db.transaction((tx) => {
      for (const item of items) writeItem(tx, connection, item, counters);
      cursor = items.at(-1)?.updated_at ?? cursor;
      updateSyncProgress(tx, connection.id, { cursor, lastSyncedAt: now().toISOString() });
    });
    page = page.nextUrl ? await client.getNext(page.nextUrl, issueItemSchema) : null;
  }
}

function writeItem(
  db: FossilDb,
  connection: ProviderConnectionRow,
  item: IssueItem,
  counters: Counters,
): void {
  const common = {
    repositoryId: connection.repositoryId,
    provider: 'github',
    number: item.number,
    title: item.title,
    body: item.body ?? '',
    state: item.state,
    url: item.html_url,
    author: item.user?.login ?? null,
    labels: labelNames(item.labels),
    createdAt: item.created_at,
    updatedAt: item.updated_at,
    closedAt: item.closed_at,
  };
  if (item.pull_request) {
    upsertPullRequest(db, { ...common, mergedAt: item.pull_request.merged_at ?? null });
    counters.pullRequests++;
  } else {
    upsertIssue(db, common);
    counters.issues++;
  }
}

async function collect<T>(
  client: GitHubClient,
  path: string,
  item: z.ZodType<T>,
  maxPages = Number.POSITIVE_INFINITY,
): Promise<T[]> {
  const out: T[] = [];
  let page: Page<T[]> | null = await client.getList(path, item);
  for (let pages = 1; page; pages++) {
    out.push(...page.items);
    page = page.nextUrl && pages < maxPages ? await client.getNext(page.nextUrl, item) : null;
  }
  return out;
}

async function syncPullRequestDetails(
  db: FossilDb,
  repositoryId: number,
  client: GitHubClient,
  repoPath: string,
  counters: Counters,
  now: () => Date,
): Promise<void> {
  for (const pullRequest of pendingPullRequestDetails(db, repositoryId)) {
    await syncOnePullRequest(db, pullRequest, client, repoPath, now);
    counters.detailsFetched++;
  }
}

async function syncOnePullRequest(
  db: FossilDb,
  pullRequest: PullRequestRow,
  client: GitHubClient,
  repoPath: string,
  now: () => Date,
): Promise<void> {
  const base = `${repoPath}/pulls/${pullRequest.externalId}`;
  // Fetch everything first; store only complete details, in one transaction.
  const detail = (await client.get(base, pullDetailSchema)).items;
  const commitShas = (
    await collect(client, `${base}/commits`, pullCommitSchema, MAX_PULL_COMMIT_PAGES)
  ).map((c) => c.sha);
  const reviews = (await collect(client, `${base}/reviews`, reviewSchema)).flatMap((review) =>
    review.submitted_at
      ? [
          {
            externalId: String(review.id),
            author: review.user?.login ?? 'ghost',
            state: review.state,
            body: review.body ?? '',
            submittedAt: review.submitted_at,
            url: `${pullRequest.url ?? base}#pullrequestreview-${review.id}`,
          },
        ]
      : [],
  );
  db.transaction((tx) => {
    savePullRequestDetails(
      tx,
      pullRequest,
      {
        mergeCommitSha: detail.merge_commit_sha,
        mergedAt: detail.merged_at,
        baseBranch: detail.base.ref,
        headBranch: detail.head.ref,
        commitShas,
        reviews,
      },
      now().toISOString(),
    );
  });
}
