import { and, asc, count, eq, gte, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { FossilDb } from './client.js';
import {
  commits,
  evidence,
  foreignLookups,
  issues,
  providerConnections,
  pullRequestCommits,
  pullRequests,
  reviews,
  type ClosingRef,
} from './schema.js';

export type { ClosingRef } from './schema.js';

export type ProviderConnectionRow = typeof providerConnections.$inferSelect;
export type IssueRow = typeof issues.$inferSelect;
export type PullRequestRow = typeof pullRequests.$inferSelect;

/** Code hosts whose issues and pull (merge) requests are synced. */
export type CodeHost = 'github' | 'gitlab' | 'bitbucket' | 'azure';

export interface NewConnection {
  readonly repositoryId: number;
  readonly provider: ProviderConnectionRow['provider'];
  readonly owner: string;
  readonly name: string;
  readonly apiUrl: string;
}

/** Create or update a provider link; switching to another remote repository restarts the sync. */
export function connectProvider(db: FossilDb, connection: NewConnection): ProviderConnectionRow {
  const existing = getProviderConnection(db, connection.repositoryId, connection.provider);
  const sameRemote =
    existing?.owner === connection.owner &&
    existing.name === connection.name &&
    existing.apiUrl === connection.apiUrl;
  return db
    .insert(providerConnections)
    .values(connection)
    .onConflictDoUpdate({
      target: [providerConnections.repositoryId, providerConnections.provider],
      set: {
        owner: connection.owner,
        name: connection.name,
        apiUrl: connection.apiUrl,
        ...(sameRemote ? {} : { cursor: null, lastSyncedAt: null }),
      },
    })
    .returning()
    .get();
}

export function getProviderConnection(
  db: FossilDb,
  repositoryId: number,
  provider: ProviderConnectionRow['provider'],
): ProviderConnectionRow | undefined {
  return db
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.repositoryId, repositoryId),
        eq(providerConnections.provider, provider),
      ),
    )
    .get();
}

export function updateSyncProgress(
  db: FossilDb,
  connectionId: number,
  progress: { readonly cursor: string | null; readonly lastSyncedAt: string },
): void {
  db.update(providerConnections)
    .set(progress)
    .where(eq(providerConnections.id, connectionId))
    .run();
}

/** Evidence for an external record, created once per locator (its URL). */
function evidenceFor(
  db: FossilDb,
  repositoryId: number,
  type: 'issue' | 'pull_request' | 'review',
  locator: string,
  excerpt: string,
): number {
  const existing = db
    .select({ id: evidence.id })
    .from(evidence)
    .where(
      and(
        eq(evidence.repositoryId, repositoryId),
        eq(evidence.type, type),
        eq(evidence.locator, locator),
      ),
    )
    .get();
  if (existing) {
    db.update(evidence).set({ excerpt }).where(eq(evidence.id, existing.id)).run();
    return existing.id;
  }
  return db
    .insert(evidence)
    .values({ repositoryId, type, locator, excerpt })
    .returning({ id: evidence.id })
    .get().id;
}

export interface ExternalItem {
  readonly repositoryId: number;
  readonly provider: string;
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly url: string;
  readonly author: string | null;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

/**
 * Store an issue. `sourceRepo` (`owner/name`) marks an issue of another
 * repository that the indexed one references; omit it for the repository's own.
 */
export function upsertIssue(
  db: FossilDb,
  item: ExternalItem & {
    readonly sourceRepo?: string;
    /** A tracker key (`PROJ-123`) identifying the issue instead of `number`. */
    readonly externalKey?: string;
  },
): IssueRow {
  const { number, labels, sourceRepo = '', externalKey, ...fields } = item;
  const values = {
    ...fields,
    sourceRepo: sourceRepo.toLowerCase(),
    externalId: externalKey ?? String(number),
    labelsJson: [...labels],
  };
  const row = db
    .insert(issues)
    .values(values)
    .onConflictDoUpdate({
      target: [issues.repositoryId, issues.provider, issues.sourceRepo, issues.externalId],
      set: values,
    })
    .returning()
    .get();
  evidenceFor(db, item.repositoryId, 'issue', item.url, item.title);
  return row;
}

export function upsertPullRequest(
  db: FossilDb,
  item: ExternalItem & { readonly mergedAt: string | null },
): PullRequestRow {
  const { number, labels, ...fields } = item;
  const values = { ...fields, externalId: String(number), labelsJson: [...labels] };
  const row = db
    .insert(pullRequests)
    .values(values)
    .onConflictDoUpdate({
      target: [pullRequests.repositoryId, pullRequests.provider, pullRequests.externalId],
      set: values,
    })
    .returning()
    .get();
  evidenceFor(db, item.repositoryId, 'pull_request', item.url, item.title);
  return row;
}

/** Pull requests whose commits, reviews and merge details are missing or older than the PR. */
export function pendingPullRequestDetails(
  db: FossilDb,
  repositoryId: number,
  provider: CodeHost = 'github',
): PullRequestRow[] {
  return db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.provider, provider),
        or(
          isNull(pullRequests.detailsSyncedAt),
          lt(pullRequests.detailsSyncedAt, pullRequests.updatedAt),
        ),
      ),
    )
    .orderBy(asc(pullRequests.updatedAt), asc(pullRequests.id))
    .all();
}

export interface PullRequestDetails {
  readonly mergeCommitSha: string | null;
  readonly mergedAt: string | null;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly commitShas: readonly string[];
  readonly reviews: readonly {
    readonly externalId: string;
    readonly author: string;
    readonly state: string;
    readonly body: string;
    readonly submittedAt: string;
    readonly url: string;
  }[];
}

/** Store a pull request's details, replacing its commit list. */
export function savePullRequestDetails(
  db: FossilDb,
  pullRequest: PullRequestRow,
  details: PullRequestDetails,
  syncedAt: string,
): void {
  db.delete(pullRequestCommits).where(eq(pullRequestCommits.pullRequestId, pullRequest.id)).run();
  for (const sha of new Set(details.commitShas)) {
    db.insert(pullRequestCommits).values({ pullRequestId: pullRequest.id, sha }).run();
  }
  for (const review of details.reviews) {
    const { url, ...values } = review;
    db.insert(reviews)
      .values({ ...values, pullRequestId: pullRequest.id })
      .onConflictDoUpdate({
        target: [reviews.pullRequestId, reviews.externalId],
        set: { state: values.state, body: values.body, submittedAt: values.submittedAt },
      })
      .run();
    evidenceFor(db, pullRequest.repositoryId, 'review', url, `${review.state} by ${review.author}`);
  }
  // Stamp with the PR's own updated_at when it is newer than the sync clock, so
  // clock skew between GitHub and this machine cannot keep a PR pending forever.
  const stamp =
    pullRequest.updatedAt && pullRequest.updatedAt > syncedAt ? pullRequest.updatedAt : syncedAt;
  db.update(pullRequests)
    .set({
      mergeCommitSha: details.mergeCommitSha,
      mergedAt: details.mergedAt,
      baseBranch: details.baseBranch,
      headBranch: details.headBranch,
      detailsSyncedAt: stamp,
    })
    .where(eq(pullRequests.id, pullRequest.id))
    .run();
}

export function findIssueByNumber(
  db: FossilDb,
  repositoryId: number,
  number: number,
): IssueRow | undefined {
  return db
    .select()
    .from(issues)
    .where(
      and(
        eq(issues.repositoryId, repositoryId),
        eq(issues.provider, 'github'),
        eq(issues.sourceRepo, ''),
        eq(issues.externalId, String(number)),
      ),
    )
    .get();
}

export function findPullRequestByNumber(
  db: FossilDb,
  repositoryId: number,
  number: number,
): PullRequestRow | undefined {
  return db
    .select()
    .from(pullRequests)
    .where(
      and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.externalId, String(number))),
    )
    .get();
}

/** A repository's pull (merge) requests; of one code host when `provider` is given. */
export function listPullRequests(
  db: FossilDb,
  repositoryId: number,
  provider?: CodeHost,
): PullRequestRow[] {
  return db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        provider === undefined ? undefined : eq(pullRequests.provider, provider),
      ),
    )
    .orderBy(asc(pullRequests.id))
    .all();
}

/** Shas GitHub listed for a pull request. */
export function pullRequestCommitShas(db: FossilDb, pullRequestId: number): string[] {
  return db
    .select({ sha: pullRequestCommits.sha })
    .from(pullRequestCommits)
    .where(eq(pullRequestCommits.pullRequestId, pullRequestId))
    .all()
    .map((row) => row.sha);
}

export interface CommitMessage {
  readonly id: number;
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
}

export function listCommitMessages(db: FossilDb, repositoryId: number): CommitMessage[] {
  return db
    .select({ id: commits.id, sha: commits.sha, subject: commits.subject, body: commits.body })
    .from(commits)
    .where(eq(commits.repositoryId, repositoryId))
    .all();
}

/** The evidence row recorded for an external record or a commit, by its locator. */
export function findEvidenceId(
  db: FossilDb,
  repositoryId: number,
  type: 'commit' | 'issue' | 'pull_request',
  locator: string,
): number | undefined {
  return db
    .select({ id: evidence.id })
    .from(evidence)
    .where(
      and(
        eq(evidence.repositoryId, repositoryId),
        eq(evidence.type, type),
        eq(evidence.locator, locator),
      ),
    )
    .get()?.id;
}

/** `owner/name#12`, lower-cased: how issues of other repositories are keyed. */
export function foreignReference(repo: string, number: number): string {
  return `${repo.toLowerCase()}#${String(number)}`;
}

/**
 * Issue and pull request ids by number, for linking many references with one
 * query each; issues of other repositories are keyed by `foreignReference`.
 */
export function externalIdsByNumber(
  db: FossilDb,
  repositoryId: number,
  provider: CodeHost = 'github',
): {
  readonly issues: Map<number, number>;
  readonly pullRequests: Map<number, number>;
  readonly foreignIssues: Map<string, number>;
} {
  const byNumber = (rows: { id: number; externalId: string }[]) =>
    new Map(rows.map((row) => [Number(row.externalId), row.id]));
  const issueRows = db
    .select({ id: issues.id, externalId: issues.externalId, sourceRepo: issues.sourceRepo })
    .from(issues)
    .where(and(eq(issues.repositoryId, repositoryId), eq(issues.provider, provider)))
    .all();
  return {
    issues: byNumber(issueRows.filter((row) => row.sourceRepo === '')),
    foreignIssues: new Map(
      issueRows
        .filter((row) => row.sourceRepo !== '')
        .map((row) => [foreignReference(row.sourceRepo, Number(row.externalId)), row.id]),
    ),
    pullRequests: byNumber(
      db
        .select({ id: pullRequests.id, externalId: pullRequests.externalId })
        .from(pullRequests)
        .where(
          and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.provider, provider)),
        )
        .all(),
    ),
  };
}

/** Evidence ids of all indexed commits, by sha. */
export function commitEvidenceIds(db: FossilDb, repositoryId: number): Map<string, number> {
  return new Map(
    db
      .select({ id: evidence.id, locator: evidence.locator })
      .from(evidence)
      .where(and(eq(evidence.repositoryId, repositoryId), eq(evidence.type, 'commit')))
      .all()
      .map((row) => [row.locator, row.id]),
  );
}

export interface ProviderCounts {
  readonly issues: number;
  readonly pullRequests: number;
  readonly pendingPullRequestDetails: number;
}

export function providerCounts(db: FossilDb, repositoryId: number): ProviderCounts {
  const countOf = (value: number | undefined) => value ?? 0;
  return {
    issues: countOf(
      db
        .select({ value: count() })
        .from(issues)
        .where(
          and(
            eq(issues.repositoryId, repositoryId),
            eq(issues.provider, 'github'),
            eq(issues.sourceRepo, ''),
          ),
        )
        .get()?.value,
    ),
    pullRequests: countOf(
      db
        .select({ value: count() })
        .from(pullRequests)
        .where(eq(pullRequests.repositoryId, repositoryId))
        .get()?.value,
    ),
    pendingPullRequestDetails: pendingPullRequestDetails(db, repositoryId).length,
  };
}

/**
 * Merged pull requests whose closing issue links are missing or older than
 * their details (a PR edited after the last fetch).
 */
export function pendingClosingRefs(
  db: FossilDb,
  repositoryId: number,
  provider: CodeHost = 'github',
): PullRequestRow[] {
  return db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.repositoryId, repositoryId),
        eq(pullRequests.provider, provider),
        isNotNull(pullRequests.mergedAt),
        isNotNull(pullRequests.detailsSyncedAt),
        or(
          isNull(pullRequests.closingRefsSyncedAt),
          lt(pullRequests.closingRefsSyncedAt, pullRequests.detailsSyncedAt),
        ),
      ),
    )
    .orderBy(asc(pullRequests.id))
    .all();
}

/** Store the issues GitHub links to a pull request as closed by it. */
export function saveClosingRefs(
  db: FossilDb,
  pullRequest: PullRequestRow,
  refs: readonly ClosingRef[],
  syncedAt: string,
): void {
  // Never stamp earlier than the details, or the PR would stay pending.
  const stamp =
    pullRequest.detailsSyncedAt && pullRequest.detailsSyncedAt > syncedAt
      ? pullRequest.detailsSyncedAt
      : syncedAt;
  db.update(pullRequests)
    .set({
      closingRefsJson: refs.map((ref) => ({ repo: ref.repo.toLowerCase(), number: ref.number })),
      closingRefsSyncedAt: stamp,
    })
    .where(eq(pullRequests.id, pullRequest.id))
    .run();
}

/** Lower-cased `owner/name#12` references looked up at or after `since`. */
export function recentForeignLookups(
  db: FossilDb,
  repositoryId: number,
  since: string,
): Set<string> {
  return new Set(
    db
      .select({ reference: foreignLookups.reference })
      .from(foreignLookups)
      .where(
        and(eq(foreignLookups.repositoryId, repositoryId), gte(foreignLookups.checkedAt, since)),
      )
      .all()
      .map((row) => row.reference),
  );
}

/** Remember that an `owner/name#12` reference was looked up, and whether it was found. */
export function recordForeignLookup(
  db: FossilDb,
  repositoryId: number,
  reference: string,
  found: boolean,
  checkedAt: string,
): void {
  const values = { repositoryId, reference: reference.toLowerCase(), found, checkedAt };
  db.insert(foreignLookups)
    .values(values)
    .onConflictDoUpdate({
      target: [foreignLookups.repositoryId, foreignLookups.reference],
      set: { found, checkedAt },
    })
    .run();
}

/** Tracker issues (Jira, Linear) by key, for linking keys found in text. */
export function trackerIssueIds(
  db: FossilDb,
  repositoryId: number,
  provider: 'jira' | 'linear',
): Map<string, number> {
  return new Map(
    db
      .select({ id: issues.id, key: issues.externalId })
      .from(issues)
      .where(and(eq(issues.repositoryId, repositoryId), eq(issues.provider, provider)))
      .all()
      .map((row) => [row.key, row.id]),
  );
}

/** The state (`open`, `closed`) and closing time of each issue of a provider, by issue id. */
export function issueStates(
  db: FossilDb,
  repositoryId: number,
  provider: CodeHost,
): Map<number, { state: string; closedAt: string | null }> {
  return new Map(
    db
      .select({ id: issues.id, state: issues.state, closedAt: issues.closedAt })
      .from(issues)
      .where(and(eq(issues.repositoryId, repositoryId), eq(issues.provider, provider)))
      .all()
      .map((row) => [row.id, { state: row.state, closedAt: row.closedAt }]),
  );
}

/** Every provider link of a repository. */
export function listProviderConnections(
  db: FossilDb,
  repositoryId: number,
): ProviderConnectionRow[] {
  return db
    .select()
    .from(providerConnections)
    .where(eq(providerConnections.repositoryId, repositoryId))
    .all();
}
