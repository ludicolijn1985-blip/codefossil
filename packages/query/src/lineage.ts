import {
  fileHistory,
  findFileById,
  findFileByPath,
  type FileHistoryEntry,
  type FossilDb,
} from '@codefossil/db';

export interface LineageEntry extends FileHistoryEntry {
  readonly fileId: number;
  readonly path: string;
}

export interface FileLineage {
  /** The file and every path it was renamed from, newest first. */
  readonly files: readonly { readonly id: number; readonly path: string }[];
  /** Every recorded change across the lineage, oldest first. */
  readonly entries: readonly LineageEntry[];
}

/**
 * A file's history across renames: follow each rename back to the previous
 * path and include that path's changes up to the rename.
 */
export function fileLineage(db: FossilDb, repositoryId: number, fileId: number): FileLineage {
  const files: { id: number; path: string }[] = [];
  const entries: LineageEntry[] = [];
  const visited = new Set<number>();
  const queue: { id: number; until: string | null }[] = [{ id: fileId, until: null }];

  for (let item = queue.shift(); item; item = queue.shift()) {
    if (visited.has(item.id)) continue;
    visited.add(item.id);
    const file = findFileById(db, item.id);
    if (!file) continue;
    files.push({ id: file.id, path: file.path });
    const until = item.until;
    // A path reused after the rename belongs to another file; stop at the rename.
    const history = fileHistory(db, file.id).filter(
      (e) => until === null || e.committedAt <= until,
    );
    for (const entry of history) {
      entries.push({ ...entry, fileId: file.id, path: file.path });
      if (entry.status === 'renamed' && entry.previousPath) {
        const previous = findFileByPath(db, repositoryId, entry.previousPath);
        if (previous) queue.push({ id: previous.id, until: entry.committedAt });
      }
    }
  }
  entries.sort((a, b) => a.committedAt.localeCompare(b.committedAt) || a.commitId - b.commitId);
  return { files, entries };
}
