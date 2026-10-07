/** Code hosts whose pull requests are synced through `PullRequestHostClient`. */
export type PullRequestHost = 'bitbucket' | 'azure';

/** A pull request as a host reports it, in the shape the index stores. */
export interface HostedPullRequest {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'merged' | 'closed';
  readonly url: string;
  readonly author: string | null;
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
  /**
   * When it was merged; null when it was not, or when the host does not
   * record it (Bitbucket), in which case the sync takes the merge commit's date.
   */
  readonly mergedAt: string | null;
  /** The merge (or squash) commit; Bitbucket gives an abbreviated hash. */
  readonly mergeCommitSha: string | null;
  readonly baseBranch: string;
  readonly headBranch: string;
}

/** A work item linked to a pull request (Azure Boards), stored as an issue. */
export interface HostedWorkItem {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly state: 'open' | 'closed';
  readonly url: string;
  readonly author: string | null;
  /** Its tags plus `type:<work item type>`. */
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

/** What a pull-request host offers the sync. */
export interface PullRequestHostClient {
  readonly provider: PullRequestHost;
  readonly requestsMade: number;
  /**
   * Whether `pullRequests` returns every pull request changed since the
   * cursor. When not (Azure lists by creation), the sync also re-reads the
   * pull requests it still has as open.
   */
  readonly listsAllUpdates: boolean;
  /** Fails when the repository is not reachable with the credentials. */
  verify(): Promise<void>;
  /** Pull requests changed since `cursor` (all when null), oldest first, and the next cursor. */
  pullRequests(
    cursor: string | null,
  ): Promise<{ readonly items: HostedPullRequest[]; readonly cursor: string | null }>;
  pullRequest(number: number): Promise<HostedPullRequest>;
  /** Shas of a pull request's commits. */
  commits(number: number): Promise<string[]>;
  /** Work items linked to a pull request; empty on hosts without them. */
  workItems(number: number): Promise<HostedWorkItem[]>;
}

/** Split a remote into host and path, for `https://…`, `ssh://…` and `git@host:path` forms. */
export function remoteParts(remote: string): { host: string; path: string } | null {
  const scp = /^[\w.-]+@([\w.-]+):(.+)$/.exec(remote);
  if (scp) {
    const [, host = '', path = ''] = scp;
    return { host: host.toLowerCase(), path: path.replace(/^\/+/, '') };
  }
  try {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return null;
    return { host: url.hostname.toLowerCase(), path: url.pathname.replace(/^\/+/, '') };
  } catch {
    return null;
  }
}
