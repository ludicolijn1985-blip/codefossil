import { getGraphIndexedSha, type FossilDb } from '@codefossil/db';
import { isAncestor, openGitRepository } from '@codefossil/git';

/**
 * How the indexed history relates to HEAD:
 * - `current`: indexed at HEAD.
 * - `behind`: HEAD has commits the index does not cover yet; what it holds is HEAD's history.
 * - `diverged`: the index was built at a commit outside HEAD's history (after a reset,
 *   rebase or checkout), so it may cite commits HEAD does not contain.
 * - `unknown`: the indexed commit is not in this clone, so the same may be true.
 * - `unindexed`: nothing indexed yet.
 */
export type IndexFreshness = 'current' | 'behind' | 'diverged' | 'unknown' | 'unindexed';

export interface IndexHeadState {
  readonly freshness: IndexFreshness;
  /** HEAD the index was last completed at. */
  readonly indexedSha: string | null;
  readonly headSha: string | null;
}

/** Compare the commit the index was built at with HEAD of the repository at `root`. */
export async function indexHeadState(
  db: FossilDb,
  repositoryId: number,
  root: string,
): Promise<IndexHeadState> {
  const { headSha } = await openGitRepository(root);
  const indexedSha = getGraphIndexedSha(db, repositoryId);
  return { freshness: await compare(root, indexedSha, headSha), indexedSha, headSha };
}

async function compare(
  root: string,
  indexedSha: string | null,
  headSha: string | null,
): Promise<IndexFreshness> {
  if (indexedSha === headSha) return 'current';
  if (indexedSha === null) return 'unindexed';
  if (headSha === null) return 'diverged';
  const ancestor = await isAncestor(root, indexedSha, headSha);
  if (ancestor === null) return 'unknown';
  return ancestor ? 'behind' : 'diverged';
}

const short = (sha: string | null) => sha?.slice(0, 7) ?? 'none';

/**
 * A one-sentence warning when answers may rest on the wrong history, or null
 * when the index covers exactly HEAD's history (or part of it, for `behind`
 * only when `includeBehind` is set).
 */
export function describeIndexHeadState(
  state: IndexHeadState,
  { includeBehind = false }: { readonly includeBehind?: boolean } = {},
): string | null {
  const indexed = short(state.indexedSha);
  const head = short(state.headSha);
  switch (state.freshness) {
    case 'current':
      return null;
    case 'unindexed':
      return 'The repository has not been indexed yet; run `codefossil index`.';
    case 'behind':
      return includeBehind
        ? `The index was built at ${indexed}; HEAD (${head}) has newer commits it does not cover yet.`
        : null;
    case 'diverged':
      return (
        `The index was built at ${indexed}, which is not in the history of HEAD (${head}); ` +
        'answers may cite commits HEAD does not contain. Run `codefossil index` to update it.'
      );
    case 'unknown':
      return (
        `The index was built at ${indexed}, a commit this clone does not have; answers may cite ` +
        "commits outside HEAD's history. Run `codefossil index` to update it."
      );
  }
}
