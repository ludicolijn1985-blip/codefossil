import { runGit } from './exec.js';

function splitNul(output: string): string[] {
  return output.split('\0').filter((entry) => entry !== '');
}

/** Paths committed at HEAD (the tree, not the working copy or index). */
export async function listHeadFiles(root: string): Promise<Set<string>> {
  return new Set(splitNul(await runGit(root, ['ls-tree', '-r', '-z', '--name-only', 'HEAD'])));
}

/** Whether git tracks anything at or below `path` (relative to the root). */
export async function isPathTracked(root: string, path: string): Promise<boolean> {
  return splitNul(await runGit(root, ['ls-files', '-z', '--', path])).length > 0;
}
