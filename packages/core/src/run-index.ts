import type { FossilDb } from '@codefossil/db';
import { indexDependencies, type DependencyIndexResult } from './dependency-indexer.js';
import { indexRepository, type IndexOptions, type IndexResult } from './git-indexer.js';
import { indexSymbols, type SymbolIndexResult } from './symbol-indexer.js';

export interface RunIndexResult extends IndexResult {
  readonly symbols: SymbolIndexResult;
  readonly dependencies: DependencyIndexResult;
}

/** Index git history, then symbols for new file versions, then the dependency graph at HEAD. */
export async function runIndex(
  db: FossilDb,
  path: string,
  options: IndexOptions = {},
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
  return { ...history, symbols, dependencies };
}
