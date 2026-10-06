import {
  analysisCommits,
  commitDiscussions,
  commitEvidenceIds,
  getIndexStatus,
  incomingRelations,
  loadEntityRecords,
  outgoingRelations,
  symbolChangeCommits,
  type FossilDb,
} from '@codefossil/db';
import { copyChain } from '@codefossil/query';
import type { EvidenceLevel } from '@codefossil/shared';
import { classifyDefects } from './defects.js';

/** One commit in a symbol's life. */
export interface StoryEvent {
  readonly sha: string;
  readonly subject: string;
  readonly committedAt: string;
  readonly authorName: string;
  /** `introduced`, `copied` (arrived in its current file) or a later `changed`. */
  readonly kind: 'introduced' | 'copied' | 'changed';
  /** Set when the commit reads as a defect fix (most are INFERRED). */
  readonly fix: { readonly reason: string; readonly level: EvidenceLevel } | null;
  /** Issues and pull requests linked to the commit. */
  readonly discussions: readonly {
    readonly type: 'issue' | 'pull_request';
    readonly number: string;
    readonly title: string;
  }[];
}

/** Everything a one-page history of a symbol shows, from the index alone. */
export interface SymbolStory {
  readonly repository: { readonly name: string; readonly headSha: string | null };
  readonly symbol: {
    readonly qualifiedName: string;
    readonly kind: string;
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
    readonly current: boolean;
  };
  /** The introduction (of the original, for copied code); null when the history does not show it. */
  readonly introduction: { readonly level: EvidenceLevel; readonly confidence: number } | null;
  /** Where the code lived before it was copied here, nearest first. */
  readonly copiedFrom: readonly { readonly path: string; readonly qualifiedName: string }[];
  /** Oldest first: the introduction, any copies, then every change. */
  readonly events: readonly StoryEvent[];
  readonly authors: number;
  readonly fixes: number;
  /** Symbols and files that call it (statically resolved). */
  readonly callers: number;
}

/**
 * The life of one symbol: where it was introduced (following copies back),
 * every commit that changed it, which of those read as fixes, the issues and
 * pull requests behind them, and how many places call it. Returns null when
 * the symbol is not in the index.
 */
export function buildSymbolStory(
  db: FossilDb,
  repositoryId: number,
  symbolId: number,
): SymbolStory | null {
  const ref = { type: 'symbol', id: symbolId } as const;
  const record = loadEntityRecords(db, [ref]).get(`symbol:${String(symbolId)}`);
  if (record?.type !== 'symbol') return null;

  const commits = analysisCommits(db, repositoryId);
  const commitById = new Map(commits.map((c) => [c.id, c]));
  const discussions = commitDiscussions(db, repositoryId);
  const defects = classifyDefects(commits, discussions, commitEvidenceIds(db, repositoryId));
  const discussionsOf = (commitId: number) => {
    const seen = new Set<string>();
    return discussions.flatMap((d) => {
      const key = `${d.type}:${d.number}`;
      if (d.commitId !== commitId || seen.has(key)) return [];
      seen.add(key);
      return [{ type: d.type, number: d.number, title: d.title }];
    });
  };
  const event = (commitId: number, kind: StoryEvent['kind']): StoryEvent | null => {
    const commit = commitById.get(commitId);
    if (!commit) return null;
    const signal = defects.get(commitId);
    return {
      sha: commit.sha,
      subject: commit.subject,
      committedAt: commit.committedAt,
      authorName: commit.authorName,
      kind,
      fix: signal ? { reason: signal.reason, level: signal.level } : null,
      discussions: discussionsOf(commitId),
    };
  };

  const { hops, origin } = copyChain(db, repositoryId, ref);
  const introduced = outgoingRelations(db, repositoryId, origin).find(
    (row) => row.relation === 'INTRODUCED_BY' && row.targetType === 'commit',
  );
  const ownVersions = (symbolChangeCommits(db, [symbolId]).get(symbolId) ?? [])
    .map((id) => commitById.get(id))
    .filter((c) => c !== undefined)
    .sort((a, b) => a.committedAt.localeCompare(b.committedAt));
  const arrival = hops.length > 0 ? ownVersions[0] : undefined;

  const events = [
    ...(introduced ? [event(introduced.targetId, 'introduced')] : []),
    ...(arrival ? [event(arrival.id, 'copied')] : []),
    ...ownVersions
      .filter((c) => c.id !== arrival?.id && c.id !== introduced?.targetId)
      .map((c) => event(c.id, 'changed')),
  ]
    .filter((e): e is StoryEvent => e !== null)
    .sort((a, b) => a.committedAt.localeCompare(b.committedAt));

  const status = getIndexStatus(db, repositoryId);
  return {
    repository: {
      name: status?.repository.name ?? '',
      headSha: status?.latestCommit?.sha ?? null,
    },
    symbol: {
      qualifiedName: record.qualifiedName,
      kind: record.kind,
      path: record.path,
      startLine: record.startLine,
      endLine: record.endLine,
      current: record.current,
    },
    introduction: introduced
      ? {
          level: introduced.evidenceType,
          confidence: Math.min(introduced.confidence, ...hops.map((h) => h.row.confidence)),
        }
      : null,
    copiedFrom: hops.map((hop) => ({
      path: hop.source.path,
      qualifiedName: hop.source.qualifiedName,
    })),
    events,
    authors: new Set(events.map((e) => e.authorName)).size,
    fixes: events.filter((e) => e.fix !== null).length,
    callers: incomingRelations(db, repositoryId, ref).filter((row) => row.relation === 'CALLS')
      .length,
  };
}
