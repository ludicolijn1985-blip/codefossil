import type { AnalysisChange, AnalysisFile } from '@codefossil/db';

/** What the indexed history says about one file at HEAD, across its renames. */
export interface FileActivity {
  readonly fileId: number;
  readonly path: string;
  /** Commits that changed the content (a pure rename is not a change). */
  readonly commitIds: ReadonlySet<number>;
  /** Lines added plus lines deleted. */
  readonly churn: number;
  /** Changes git could not count lines for (binary files). */
  readonly binaryChanges: number;
  readonly lastChangedAt: string | null;
}

const isPureRename = (change: AnalysisChange) =>
  change.status === 'renamed' && (change.additions ?? 0) + (change.deletions ?? 0) === 0;

/**
 * Aggregate the changes of every file that exists at HEAD, following each
 * rename back to the previous path up to the moment of the rename (a path
 * reused later belongs to another file). Changes before `since` are skipped
 * but renames are still followed through them.
 */
export function fileActivity(
  files: readonly AnalysisFile[],
  changes: readonly AnalysisChange[],
  since?: string,
): FileActivity[] {
  const byFile = new Map<number, AnalysisChange[]>();
  for (const change of changes) {
    const group = byFile.get(change.fileId);
    if (group) group.push(change);
    else byFile.set(change.fileId, [change]);
  }
  const idByPath = new Map(files.map((file) => [file.path, file.id]));

  return files
    .filter((file) => file.deletedAt === null)
    .map((file) => {
      const commitIds = new Set<number>();
      let churn = 0;
      let binaryChanges = 0;
      let lastChangedAt: string | null = null;
      const visited = new Set<number>();
      const queue: { id: number; until: string | null }[] = [{ id: file.id, until: null }];
      for (let item = queue.shift(); item; item = queue.shift()) {
        if (visited.has(item.id)) continue;
        visited.add(item.id);
        for (const change of byFile.get(item.id) ?? []) {
          if (item.until !== null && change.committedAt > item.until) continue;
          if (change.status === 'renamed' && change.previousPath) {
            const previous = idByPath.get(change.previousPath);
            if (previous !== undefined) queue.push({ id: previous, until: change.committedAt });
          }
          if ((since && change.committedAt < since) || isPureRename(change)) continue;
          commitIds.add(change.commitId);
          if (change.additions === null) binaryChanges++;
          else churn += change.additions + (change.deletions ?? 0);
          if (!lastChangedAt || change.committedAt > lastChangedAt)
            lastChangedAt = change.committedAt;
        }
      }
      return { fileId: file.id, path: file.path, commitIds, churn, binaryChanges, lastChangedAt };
    });
}
