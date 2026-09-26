import type { FossilDb } from '@codefossil/db';
import { indexRepository, type IndexOptions, type IndexResult } from './git-indexer.js';
import { indexSymbols, type SymbolIndexResult } from './symbol-indexer.js';

export interface RunIndexResult extends IndexResult {
  readonly symbols: SymbolIndexResult;
}

/** Index git history, then symbols for every newly recorded file version. */
export async function runIndex(
  db: FossilDb,
  path: string,
  options: IndexOptions = {},
): Promise<RunIndexResult> {
  const history = await indexRepository(db, path, options);
  const symbols = await indexSymbols(
    db,
    history.repositoryId,
    history.root,
    history.headSha,
    options.now ? { now: options.now } : {},
  );
  return { ...history, symbols };
}
