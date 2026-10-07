import {
  commitEvidenceIds,
  deleteRelationsByProducer,
  findEvidenceId,
  listCommitMessages,
  listPullRequests,
  recentForeignLookups,
  recordForeignLookup,
  recordRelation,
  trackerIssueIds,
  upsertIssue,
  type FossilDb,
  type ProviderConnectionRow,
} from '@codefossil/db';
import {
  TrackerApiError,
  TrackerLimitError,
  trackerKeys,
  type TrackerClient,
} from '@codefossil/providers';
import type { EntityRef } from '@codefossil/shared';

export const TRACKER_LINKER_PRODUCER = 'tracker-linker@0.1.0';

/** Keys read per sync, so a long history cannot spend the request budget at once. */
const MAX_LOOKUPS = 500;
/** How long a looked-up key is left alone before it is read again. */
const LOOKUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Keys read and stored per transaction. */
const STORE_BATCH = 50;

export type TrackerProvider = 'jira' | 'linear';

export interface TrackerSyncResult {
  readonly provider: TrackerProvider;
  /** Project (team) keys the credentials can see. */
  readonly projects: number;
  /** Issues newly read or refreshed. */
  readonly issues: number;
  readonly requests: number;
  /** Why the sync stopped early or failed; null when it completed. */
  readonly stoppedEarly: string | null;
}

/** The project keys a connection is limited to (`--projects`); empty for all visible ones. */
export function connectionProjects(connection: ProviderConnectionRow): Set<string> {
  return new Set(
    connection.name
      .split(',')
      .map((key) => key.trim())
      .filter((key) => /^[A-Z][A-Z0-9]{1,9}$/.test(key)),
  );
}

/** Texts that may name tracker keys: commit messages and pull request titles and bodies. */
function referenceTexts(db: FossilDb, repositoryId: number): string[] {
  return [
    ...listCommitMessages(db, repositoryId).map((c) => `${c.subject}\n${c.body}`),
    ...listPullRequests(db, repositoryId).map((pr) => `${pr.title}\n${pr.body}`),
  ];
}

/**
 * Read the Jira or Linear issues that commit messages and pull requests name
 * by key (`PROJ-123`). Only keys of projects the tracker knows (and, when the
 * connection lists some, only those) count, so `UTF-8` or `SHA-256` are never
 * looked up. Each key is read at most once a week; failures stop this sync,
 * are reported, and never stop indexing.
 */
export async function syncTracker(
  db: FossilDb,
  connection: ProviderConnectionRow,
  client: TrackerClient,
  options: { readonly now?: () => Date } = {},
): Promise<TrackerSyncResult> {
  const now = options.now ?? (() => new Date());
  const provider = connection.provider as TrackerProvider;
  let projects = 0;
  let issues = 0;
  try {
    const visible = new Set(await client.projectKeys());
    const limited = connectionProjects(connection);
    const wanted = new Set([...visible].filter((key) => limited.size === 0 || limited.has(key)));
    projects = wanted.size;
    const since = new Date(now().getTime() - LOOKUP_TTL_MS).toISOString();
    const recent = recentForeignLookups(db, connection.repositoryId, since);
    const keys = [
      ...new Set(
        referenceTexts(db, connection.repositoryId).flatMap((t) => trackerKeys(t, wanted)),
      ),
    ]
      .filter((key) => !recent.has(`${provider}:${key}`.toLowerCase()))
      .slice(0, MAX_LOOKUPS);
    // Read and store in batches: a failure later on keeps what earlier batches read.
    for (let start = 0; start < keys.length; start += STORE_BATCH) {
      issues += await readBatch(keys.slice(start, start + STORE_BATCH));
    }
    return { provider, projects, issues, requests: client.requestsMade, stoppedEarly: null };
  } catch (error) {
    if (!(error instanceof TrackerApiError || error instanceof TrackerLimitError)) throw error;
    return {
      provider,
      projects,
      issues,
      requests: client.requestsMade,
      stoppedEarly: error.message,
    };
  }

  async function readBatch(keys: readonly string[]): Promise<number> {
    const found = await client.issues(keys);
    const checkedAt = now().toISOString();
    db.transaction((tx) => {
      for (const issue of found) {
        upsertIssue(tx, {
          repositoryId: connection.repositoryId,
          provider,
          number: 0,
          title: issue.title,
          body: issue.body,
          state: issue.state,
          url: issue.url,
          author: null,
          labels: issue.labels,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          closedAt: issue.closedAt,
          externalKey: issue.key,
        });
      }
      const seen = new Set(found.map((issue) => issue.key));
      for (const key of keys) {
        recordForeignLookup(
          tx,
          connection.repositoryId,
          `${provider}:${key}`,
          seen.has(key),
          checkedAt,
        );
      }
    });
    return found.length;
  }
}

export interface TrackerLinkResult {
  readonly references: number;
}

/**
 * Link commits and pull requests to the tracker issues their text names by
 * key: `REFERENCES` (DERIVED, 1), citing the commit or pull request. Keys of
 * issues that were not read produce no link.
 */
export function linkTrackerReferences(
  db: FossilDb,
  repositoryId: number,
  provider: TrackerProvider,
  observedAt: string,
): TrackerLinkResult {
  return db.transaction((tx) => {
    deleteRelationsByProducer(tx, repositoryId, `${TRACKER_LINKER_PRODUCER}:${provider}`);
    const issueIds = trackerIssueIds(tx, repositoryId, provider);
    if (issueIds.size === 0) return { references: 0 };
    const projects = new Set([...issueIds.keys()].map((key) => key.split('-')[0] ?? ''));
    const commitEvidence = commitEvidenceIds(tx, repositoryId);
    let references = 0;
    const link = (source: EntityRef, text: string, evidenceId: number | undefined) => {
      for (const key of trackerKeys(text, projects)) {
        const issueId = issueIds.get(key);
        if (issueId === undefined) continue;
        recordRelation(tx, {
          repositoryId,
          source,
          relation: 'REFERENCES',
          target: { type: 'issue', id: issueId },
          evidenceType: 'DERIVED',
          confidence: 1,
          provenance: {
            producer: `${TRACKER_LINKER_PRODUCER}:${provider}`,
            method: `${provider}-key`,
            evidenceIds: evidenceId === undefined ? [] : [evidenceId],
            observedAt,
          },
        });
        references++;
      }
    };
    for (const commit of listCommitMessages(tx, repositoryId)) {
      link(
        { type: 'commit', id: commit.id },
        `${commit.subject}\n${commit.body}`,
        commitEvidence.get(commit.sha),
      );
    }
    for (const pr of listPullRequests(tx, repositoryId)) {
      const evidenceId = pr.url
        ? findEvidenceId(tx, repositoryId, 'pull_request', pr.url)
        : undefined;
      link({ type: 'pull_request', id: pr.id }, `${pr.title}\n${pr.body}`, evidenceId);
    }
    return { references };
  });
}
