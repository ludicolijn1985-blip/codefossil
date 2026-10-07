import {
  foreignReference,
  listCommitMessages,
  listPullRequests,
  pendingClosingRefs,
  pendingPullRequestDetails,
  recentForeignLookups,
  recordForeignLookup,
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
  GitHubApiError,
  GitHubRateLimitError,
  issueItemSchema,
  labelNames,
  parseReferences,
  pullCommitSchema,
  pullDetailSchema,
  RequestBudgetExhaustedError,
  reviewSchema,
  type GitHubClient,
  type IssueItem,
  type Page,
} from '@codefossil/providers';
import { z } from 'zod';

/** GitHub caps the commit list of a pull request at 250. */
const MAX_PULL_COMMIT_PAGES = 3;

/** Pull requests asked for their closing issues in one GraphQL query. */
const CLOSING_REFS_BATCH = 50;
/** Closing issues read per pull request; more than this is very rare. */
const MAX_CLOSING_REFS = 50;

/** Issues of other repositories looked up per sync, so a busy history cannot spend the budget. */
const MAX_FOREIGN_LOOKUPS = 50;
/** How long a looked-up issue of another repository is left alone before it is read again. */
const FOREIGN_LOOKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Statuses meaning "this reference cannot be read": not found, gone, or no access. */
const UNREADABLE_STATUSES = new Set([403, 404, 410, 451]);

export interface GitHubSyncResult {
  readonly issues: number;
  readonly pullRequests: number;
  readonly detailsFetched: number;
  /** Pull requests still waiting for commits, reviews and merge details. */
  readonly detailsPending: number;
  /** Merged pull requests whose closing issues GitHub reported (needs a token). */
  readonly closingRefsFetched: number;
  /**
   * Why GitHub's closing issue references could not be read (e.g. GraphQL is
   * unavailable); pull requests then keep their keyword-based links.
   */
  readonly closingRefsError: string | null;
  /** Issues of other repositories that commits or pull requests reference, newly read. */
  readonly foreignIssues: number;
  readonly requests: number;
  /** Why the sync stopped early (rate limit, request budget); null when it completed. */
  readonly stoppedEarly: string | null;
}

interface Counters {
  issues: number;
  pullRequests: number;
  detailsFetched: number;
  closingRefsFetched: number;
  foreignIssues: number;
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
  const counters: Counters = {
    issues: 0,
    pullRequests: 0,
    detailsFetched: 0,
    closingRefsFetched: 0,
    foreignIssues: 0,
  };
  const repoPath = `/repos/${encodeURIComponent(connection.owner)}/${encodeURIComponent(connection.name)}`;
  let stoppedEarly: string | null = null;
  let closingRefsError: string | null = null;

  try {
    await syncItems(db, connection, client, repoPath, counters, now);
    await syncPullRequestDetails(db, connection.repositoryId, client, repoPath, counters, now);
    closingRefsError = await syncClosingRefs(db, connection, client, counters, now);
    await syncForeignIssues(db, connection, client, counters, now);
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
    closingRefsError,
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

const closingRefsSchema = z.object({
  closingIssuesReferences: z
    .object({
      nodes: z
        .array(
          z
            .object({
              number: z.number().int().positive(),
              repository: z.object({ nameWithOwner: z.string() }),
            })
            .nullable(),
        )
        .nullable(),
    })
    .nullable(),
});

const closingRefsResponse = z.object({
  repository: z.record(z.string(), closingRefsSchema.nullable()).nullable(),
});

/**
 * Ask GitHub which issues each merged pull request closes
 * (`closingIssuesReferences`): what GitHub itself records, including issues
 * linked by hand rather than with a keyword. GraphQL needs a token, so
 * without one the links stay keyword-based. Returns why the references could
 * not be read, if they could not.
 */
async function syncClosingRefs(
  db: FossilDb,
  connection: ProviderConnectionRow,
  client: GitHubClient,
  counters: Counters,
  now: () => Date,
): Promise<string | null> {
  if (!client.authenticated) return null;
  try {
    await fetchClosingRefs(db, connection, client, counters, now);
    return null;
  } catch (error) {
    if (!(error instanceof GitHubApiError)) throw error;
    return error.message;
  }
}

async function fetchClosingRefs(
  db: FossilDb,
  connection: ProviderConnectionRow,
  client: GitHubClient,
  counters: Counters,
  now: () => Date,
): Promise<void> {
  const pending = pendingClosingRefs(db, connection.repositoryId).filter((pr) =>
    /^[1-9]\d{0,9}$/.test(pr.externalId),
  );
  for (let start = 0; start < pending.length; start += CLOSING_REFS_BATCH) {
    const batch = pending.slice(start, start + CLOSING_REFS_BATCH);
    // The numbers are checked digits, so they can be written into the query.
    const fields = batch
      .map(
        (pr) =>
          `pr${pr.externalId}: pullRequest(number: ${pr.externalId}) { ` +
          `closingIssuesReferences(first: ${String(MAX_CLOSING_REFS)}) { nodes { number repository { nameWithOwner } } } }`,
      )
      .join('\n');
    const data = await client.graphql(
      `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`,
      { owner: connection.owner, name: connection.name },
      closingRefsResponse,
    );
    db.transaction((tx) => {
      for (const pr of batch) {
        const nodes = data.repository?.[`pr${pr.externalId}`]?.closingIssuesReferences?.nodes ?? [];
        const refs = nodes.flatMap((node) =>
          node ? [{ repo: node.repository.nameWithOwner, number: node.number }] : [],
        );
        saveClosingRefs(tx, pr, refs, now().toISOString());
        counters.closingRefsFetched++;
      }
    });
  }
}

/** `owner/name` made of GitHub's name characters, neither part `.` or `..`. */
const REPO_NAME = /^(?!\.{1,2}\/)[\w.-]+\/(?!\.{1,2}$)[\w.-]+$/;

interface ForeignRef {
  readonly repo: string;
  readonly number: number;
}

/** References to issues of other repositories, from commits, pull requests and closing links. */
function foreignReferences(
  db: FossilDb,
  connection: ProviderConnectionRow,
): Map<string, ForeignRef> {
  const self = `${connection.owner}/${connection.name}`.toLowerCase();
  const found = new Map<string, ForeignRef>();
  const add = (repo: string | null, number: number) => {
    const name = repo?.toLowerCase();
    if (!name || name === self || !REPO_NAME.test(name)) return;
    found.set(foreignReference(name, number), { repo: name, number });
  };
  const texts = listCommitMessages(db, connection.repositoryId).map(
    (commit) => `${commit.subject}\n${commit.body}`,
  );
  for (const pr of listPullRequests(db, connection.repositoryId)) {
    for (const ref of pr.closingRefsJson ?? []) add(ref.repo, ref.number);
    texts.push(`${pr.title}\n${pr.body}`);
  }
  for (const text of texts) {
    for (const ref of parseReferences(text, connection.owner, connection.name)) {
      add(ref.repo, ref.number);
    }
  }
  return found;
}

/**
 * Read the issues of other repositories that history references
 * (`other/repo#12`), so they can be linked like the repository's own. Each
 * reference is read at most once a week; one that cannot be read (private,
 * deleted, a pull request) is remembered as such.
 */
async function syncForeignIssues(
  db: FossilDb,
  connection: ProviderConnectionRow,
  client: GitHubClient,
  counters: Counters,
  now: () => Date,
): Promise<void> {
  const since = new Date(now().getTime() - FOREIGN_LOOKUP_TTL_MS).toISOString();
  const recent = recentForeignLookups(db, connection.repositoryId, since);
  const due = [...foreignReferences(db, connection)]
    .filter(([key]) => !recent.has(key))
    .slice(0, MAX_FOREIGN_LOOKUPS);
  for (const [key, { repo, number }] of due) {
    const [owner = '', name = ''] = repo.split('/');
    const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/issues/${String(number)}`;
    let item: IssueItem | null = null;
    try {
      item = (await client.get(path, issueItemSchema)).items;
    } catch (error) {
      if (!(error instanceof GitHubApiError && UNREADABLE_STATUSES.has(error.status ?? 0))) {
        throw error;
      }
    }
    // Pull requests of other repositories are not stored: only their issues are linked.
    const issue = item && !item.pull_request ? item : null;
    db.transaction((tx) => {
      if (issue) {
        upsertIssue(tx, {
          repositoryId: connection.repositoryId,
          provider: 'github',
          sourceRepo: repo,
          number: issue.number,
          title: issue.title,
          body: issue.body ?? '',
          state: issue.state,
          url: issue.html_url,
          author: issue.user?.login ?? null,
          labels: labelNames(issue.labels),
          createdAt: issue.created_at,
          updatedAt: issue.updated_at,
          closedAt: issue.closed_at,
        });
        counters.foreignIssues++;
      }
      recordForeignLookup(tx, connection.repositoryId, key, issue !== null, now().toISOString());
    });
  }
}
