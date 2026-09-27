/** How many files reach a file through imports, and how many of those are tests. */
export interface Reach {
  readonly dependents: number;
  readonly tests: number;
}

/** Import hops followed; matches the default depth of impact analysis. */
export const REACH_DEPTH = 5;

/**
 * For each file, the files that import it directly or through a chain of at
 * most `maxDepth` imports. Edges point from importer to imported file.
 */
export function importReach(
  fileIds: readonly number[],
  edges: readonly { readonly source: number; readonly target: number }[],
  isTest: (fileId: number) => boolean,
  maxDepth = REACH_DEPTH,
): Map<number, Reach> {
  const importers = new Map<number, number[]>();
  for (const { source, target } of edges) {
    if (source === target) continue;
    const group = importers.get(target);
    if (group) group.push(source);
    else importers.set(target, [source]);
  }
  const result = new Map<number, Reach>();
  for (const fileId of fileIds) {
    const seen = new Set<number>([fileId]);
    let frontier = [fileId];
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: number[] = [];
      for (const current of frontier) {
        for (const importer of importers.get(current) ?? []) {
          if (!seen.has(importer)) {
            seen.add(importer);
            next.push(importer);
          }
        }
      }
      frontier = next;
    }
    seen.delete(fileId);
    const reached = [...seen];
    result.set(fileId, { dependents: reached.length, tests: reached.filter(isTest).length });
  }
  return result;
}
