import {
  getProviderConnection,
  listProviderConnections,
  type FossilDb,
  type ProviderConnectionRow,
} from '@codefossil/db';
import type { GitHubClient, GitLabClient, TrackerClient } from '@codefossil/providers';
import { indexCoverage, type CoverageIndexResult } from './coverage.js';
import { indexDependencies, type DependencyIndexResult } from './dependency-indexer.js';
import { indexRepository, type IndexOptions, type IndexResult } from './git-indexer.js';
import { syncGitHub, type GitHubSyncResult } from './github-sync.js';
import { linkGitLabReferences, syncGitLab, type GitLabSyncResult } from './gitlab-sync.js';
import { linkGitHubReferences, type LinkResult } from './reference-linker.js';
import { indexSymbols, type SymbolIndexResult } from './symbol-indexer.js';
import {
  linkTrackerReferences,
  syncTracker,
  type TrackerLinkResult,
  type TrackerProvider,
  type TrackerSyncResult,
} from './tracker-sync.js';

export interface RunIndexOptions extends IndexOptions {
  /**
   * Creates a GitHub client for a connected repository. Omit it (or return
   * null) to stay offline: stored GitHub data is still linked to new commits.
   */
  readonly github?: (connection: ProviderConnectionRow) => GitHubClient | null;
  /**
   * Resolve TypeScript calls with the type checker when the dependency graph
   * is rebuilt. Slow on large programs, and it may load the repository's own
   * compiler from node_modules, so it is never on by default.
   */
  readonly typescript?: boolean;
  /**
   * Also allow the TypeScript compiler the repository installed when none is
   * installed next to codefossil. That runs the repository's code: only on an
   * explicit request, never from the environment.
   */
  readonly typescriptFromRepository?: boolean;
  /**
   * Creates a client for a connected Jira or Linear tracker; omit it (or
   * return null) to stay offline: stored issues are still linked.
   */
  readonly trackers?: (connection: ProviderConnectionRow) => TrackerClient | null;
  /** Creates a client for a connected GitLab project; omit it to stay offline. */
  readonly gitlab?: (connection: ProviderConnectionRow) => GitLabClient | null;
}

export interface GitLabIndexResult {
  /** The project path, `group/sub/name`. */
  readonly project: string;
  /** Null when the run was offline. */
  readonly sync: GitLabSyncResult | null;
  readonly links: {
    readonly pullRequestCommits: number;
    readonly resolutions: number;
    readonly references: number;
  };
}

export interface TrackerIndexResult {
  readonly provider: TrackerProvider;
  /** Null when the run was offline for this tracker. */
  readonly sync: TrackerSyncResult | null;
  readonly links: TrackerLinkResult;
}

export interface GitHubIndexResult {
  readonly owner: string;
  readonly name: string;
  /** Null when the run was offline. */
  readonly sync: GitHubSyncResult | null;
  readonly links: LinkResult;
}

export interface RunIndexResult extends IndexResult {
  readonly symbols: SymbolIndexResult;
  readonly dependencies: DependencyIndexResult;
  /** Line coverage read from an lcov report in the working tree. */
  readonly coverage: CoverageIndexResult;
  /** Null when the repository is not connected to GitHub. */
  readonly github: GitHubIndexResult | null;
  /** Connected Jira and Linear trackers. */
  readonly trackers: readonly TrackerIndexResult[];
  /** Null when the repository is not connected to GitLab. */
  readonly gitlab: GitLabIndexResult | null;
}

/**
 * Index git history, symbols of new file versions and the dependency graph at
 * HEAD; then, for a connected repository, sync GitHub and link its records to
 * the history.
 */
export async function runIndex(
  db: FossilDb,
  path: string,
  options: RunIndexOptions = {},
): Promise<RunIndexResult> {
  const history = await indexRepository(db, path, options);
  const clock = options.now ? { now: options.now } : {};
  const symbols = await indexSymbols(
    db,
    history.repositoryId,
    history.root,
    history.headSha,
    clock,
  );
  const dependencies = await indexDependencies(
    db,
    history.repositoryId,
    history.root,
    history.headSha,
    {
      ...clock,
      ...(options.typescript ? { typescript: true } : {}),
      ...(options.typescriptFromRepository ? { typescriptFromRepository: true } : {}),
    },
  );

  const coverage = await indexCoverage(db, history.repositoryId, history.root);

  const connection = getProviderConnection(db, history.repositoryId, 'github');
  let github: GitHubIndexResult | null = null;
  if (connection) {
    const client = options.github?.(connection) ?? null;
    const sync = client ? await syncGitHub(db, connection, client, clock) : null;
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const links = linkGitHubReferences(db, history.repositoryId, connection, observedAt);
    github = { owner: connection.owner, name: connection.name, sync, links };
  }
  const gitlabConnection = getProviderConnection(db, history.repositoryId, 'gitlab');
  let gitlab: GitLabIndexResult | null = null;
  if (gitlabConnection) {
    const client = options.gitlab?.(gitlabConnection) ?? null;
    const sync = client ? await syncGitLab(db, gitlabConnection, client, clock) : null;
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const links = linkGitLabReferences(db, history.repositoryId, gitlabConnection.name, observedAt);
    gitlab = { project: gitlabConnection.name, sync, links };
  }

  const trackers: TrackerIndexResult[] = [];
  for (const tracker of listProviderConnections(db, history.repositoryId)) {
    if (tracker.provider !== 'jira' && tracker.provider !== 'linear') continue;
    const client = options.trackers?.(tracker) ?? null;
    const sync = client ? await syncTracker(db, tracker, client, clock) : null;
    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const links = linkTrackerReferences(db, history.repositoryId, tracker.provider, observedAt);
    trackers.push({ provider: tracker.provider, sync, links });
  }
  return { ...history, symbols, dependencies, coverage, github, gitlab, trackers };
}
