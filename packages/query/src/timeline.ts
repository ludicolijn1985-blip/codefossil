import { entityKey, symbolsChangedInCommit, type FossilDb } from '@codefossil/db';
import { linked, recordOf } from './context.js';
import { labelOf } from './describe.js';
import { fileLineage } from './lineage.js';

export interface TimelineEntry {
  readonly sha: string;
  readonly committedAt: string;
  readonly author: string;
  readonly subject: string;
  readonly path: string;
  readonly change: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly previousPath: string | null;
  /** Null for binary files, whose line counts git cannot report. */
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly pullRequests: readonly string[];
  readonly issues: readonly {
    readonly label: string;
    readonly relation: 'resolves' | 'mentions';
  }[];
  /** Symbols of the file that got a new version in this commit. */
  readonly symbols: readonly string[];
}

export interface Timeline {
  readonly kind: 'timeline';
  readonly target: { readonly key: string; readonly label: string };
  /** The paths the file had, newest first. */
  readonly paths: readonly string[];
  readonly entries: readonly TimelineEntry[];
}

/** Every recorded change to a file, across renames, with the context of each commit. */
export function buildTimeline(db: FossilDb, repositoryId: number, fileId: number): Timeline {
  const file = recordOf(db, { type: 'file', id: fileId });
  const lineage = fileLineage(db, repositoryId, fileId);
  const fileIds = lineage.files.map((f) => f.id);

  const entries = lineage.entries.map((entry): TimelineEntry => {
    const commit = { type: 'commit', id: entry.commitId } as const;
    const pullRequests = linked(db, repositoryId, commit, 'IMPLEMENTED_BY', 'in');
    const issues = [
      ...linked(db, repositoryId, commit, 'RESOLVED_BY', 'in').map((l) => ({
        label: labelOf(l.record),
        relation: 'resolves' as const,
      })),
      ...pullRequests.flatMap((pr) =>
        linked(
          db,
          repositoryId,
          { type: 'pull_request', id: pr.record.id },
          'RESOLVED_BY',
          'in',
        ).map((l) => ({ label: labelOf(l.record), relation: 'resolves' as const })),
      ),
      ...linked(db, repositoryId, commit, 'REFERENCES', 'out').map((l) => ({
        label: labelOf(l.record),
        relation: 'mentions' as const,
      })),
    ];
    return {
      sha: entry.sha,
      committedAt: entry.committedAt,
      author: entry.authorName,
      subject: entry.subject,
      path: entry.path,
      change: entry.status,
      previousPath: entry.previousPath,
      additions: entry.additions,
      deletions: entry.deletions,
      pullRequests: pullRequests.map((pr) => labelOf(pr.record)),
      issues: [...new Map(issues.map((i) => [i.label, i])).values()],
      // Symbols move to the new file on a rename, so versions recorded under an
      // older path now belong to a later file of the lineage: query all of them.
      symbols: symbolsChangedInCommit(db, entry.commitId, fileIds),
    };
  });

  return {
    kind: 'timeline',
    target: {
      key: entityKey({ type: 'file', id: fileId }),
      label: file ? labelOf(file) : `file:${fileId}`,
    },
    paths: lineage.files.map((f) => f.path),
    entries,
  };
}
