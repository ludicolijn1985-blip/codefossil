import { GitError, runGit, streamGit } from './exec.js';

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** Paths committed at HEAD (the tree, not the working copy or index). */
export async function listHeadFiles(root: string): Promise<Set<string>> {
  return new Set(splitNul(await runGit(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'])));
}

/**
 * Paths that differ between two commits; a rename lists both sides. Returns
 * null when `from` is unknown (e.g. rewritten or garbage-collected history),
 * so callers can fall back to a full rebuild.
 */
export async function changedPaths(
  root: string,
  from: string,
  to: string,
): Promise<Set<string> | null> {
  try {
    return new Set(
      splitNul(await runGit(root, ['diff', '--name-only', '-z', '--no-renames', from, to, '--'])),
    );
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

/**
 * Shas of the commits reachable from `to` but not from `from` (`git rev-list
 * from..to`), newest first. Null when either revision is unknown.
 */
export async function commitsBetween(
  root: string,
  from: string,
  to: string,
): Promise<string[] | null> {
  try {
    return (await runGit(root, ['rev-list', '--end-of-options', `${from}..${to}`]))
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  } catch (error) {
    if (error instanceof GitError) return null;
    throw error;
  }
}

/** Whether git tracks anything at or below `path` (relative to the root). */
export async function isPathTracked(root: string, path: string): Promise<boolean> {
  return splitNul(await runGit(root, ['ls-files', '-z', '--', path])).length > 0;
}

/** Shas of every commit reachable from HEAD (`git rev-list HEAD`), streamed so large histories fit. */
export async function listReachableShas(root: string): Promise<Set<string>> {
  const shas = new Set<string>();
  let rest = '';
  for await (const chunk of streamGit(root, ['rev-list', '--end-of-options', 'HEAD'])) {
    const lines = (rest + chunk).split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) if (line !== '') shas.add(line.trim());
  }
  if (rest.trim() !== '') shas.add(rest.trim());
  return shas;
}

/**
 * Whether `ancestor` is in the history of `descendant` (`git merge-base
 * --is-ancestor`). Null when either commit is unknown to this clone.
 */
export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean | null> {
  try {
    await runGit(root, ['merge-base', '--is-ancestor', '--end-of-options', ancestor, descendant]);
    return true;
  } catch (error) {
    if (error instanceof GitError) return error.exitCode === 1 ? false : null;
    throw error;
  }
}

/** Whether the clone is shallow (fetched with a depth), so older history is missing. */
export async function isShallowRepository(root: string): Promise<boolean> {
  return (await runGit(root, ['rev-parse', '--is-shallow-repository'])).trim() === 'true';
}
