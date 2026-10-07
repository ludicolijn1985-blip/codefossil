import { getProviderConnection, type FossilDb, type ProviderConnectionRow } from '@codefossil/db';
import type { GitHubClient } from '@codefossil/providers';
import { indexCoverage, type CoverageIndexResult } from './coverage.js';
import { indexDependencies, type DependencyIndexResult } from './dependency-indexer.js';
import { indexRepository, type IndexOptions, type IndexResult } from './git-indexer.js';
import { syncGitHub, type GitHubSyncResult } from './github-sync.js';
import { linkGitHubReferences, type LinkResult } from './reference-linker.js';
import { indexSymbols, type SymbolIndexResult } from './symbol-indexer.js';

export interface RunIndexOptions extends IndexOptions {
  /**
   * Creates a GitHub client for a connected repository. Omit it (or return
   * null) to stay offline: stored GitHub data is still linked to new commits.
   */
  readonly github?: (connection: ProviderConnectionRow) => GitHubClient | null;
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
    clock,
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
  return { ...history, symbols, dependencies, coverage, github };
}
