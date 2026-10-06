import {
  analysisCommits,
  listFileSymbols,
  type AnalysisCommit,
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
import { classifyDefects, type DefectSignal } from './defects.js';

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
 * What every story of one repository needs, loaded once: commits, which of
 * them read as fixes, and the issues and pull requests linked to them.
 */
export class StoryContext {
  readonly commitById: ReadonlyMap<number, AnalysisCommit>;
  readonly defects: ReadonlyMap<number, DefectSignal>;
  readonly repository: SymbolStory['repository'];
  private readonly discussionsByCommit = new Map<number, StoryEvent['discussions'][number][]>();

  constructor(db: FossilDb, repositoryId: number) {
    const commits = analysisCommits(db, repositoryId);
    this.commitById = new Map(commits.map((c) => [c.id, c]));
    const discussions = commitDiscussions(db, repositoryId);
    this.defects = classifyDefects(commits, discussions, commitEvidenceIds(db, repositoryId));
    for (const d of discussions) {
      const list = this.discussionsByCommit.get(d.commitId) ?? [];
      if (!list.some((x) => x.type === d.type && x.number === d.number)) {
        list.push({ type: d.type, number: d.number, title: d.title });
      }
      this.discussionsByCommit.set(d.commitId, list);
    }
    const status = getIndexStatus(db, repositoryId);
    this.repository = {
      name: status?.repository.name ?? '',
      headSha: status?.latestCommit?.sha ?? null,
    };
  }

  discussionsOf(commitId: number): StoryEvent['discussions'] {
    return this.discussionsByCommit.get(commitId) ?? [];
  }
}

/** The stories of every current symbol of a file, in source order. */
export function buildFileStories(
  db: FossilDb,
  repositoryId: number,
  fileId: number,
): SymbolStory[] {
  const context = new StoryContext(db, repositoryId);
  return listFileSymbols(db, fileId).flatMap((symbol) => {
    const story = buildSymbolStory(db, repositoryId, symbol.id, context);
    return story ? [story] : [];
  });
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
  context: StoryContext = new StoryContext(db, repositoryId),
): SymbolStory | null {
  const ref = { type: 'symbol', id: symbolId } as const;
  const record = loadEntityRecords(db, [ref]).get(`symbol:${String(symbolId)}`);
  if (record?.type !== 'symbol') return null;

  const { commitById, defects } = context;
  const discussionsOf = (commitId: number) => context.discussionsOf(commitId);
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

  return {
    repository: context.repository,
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
