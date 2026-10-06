import {
  analysisCommits,
  currentSymbolOrigins,
  symbolChangeCommits,
  type FossilDb,
} from '@codefossil/db';
import { isTestPath } from '@codefossil/query';
import type { EvidenceLevel } from '@codefossil/shared';
import { isCodePath, isGeneratedPath, isIllustrativePath } from './hotspots.js';

export type FossilOrder = 'introduced' | 'untouched';

export interface FossilCommit {
  readonly sha: string;
  readonly subject: string;
  readonly committedAt: string;
  readonly authorName: string;
}

/** A symbol that still exists, with the commit that introduced it and what happened since. */
export interface Fossil {
  readonly symbol: {
    readonly id: number;
    readonly qualifiedName: string;
    readonly kind: string;
    readonly path: string;
    readonly startLine: number;
    readonly endLine: number;
  };
  /** The introducing commit; `level` and `evidenceIds` are those of the `INTRODUCED_BY` relation. */
  readonly introduced: FossilCommit & {
    readonly level: EvidenceLevel;
    readonly confidence: number;
    readonly evidenceIds: readonly number[];
  };
  /** Commits that changed the symbol after it was introduced. */
  readonly changesSince: number;
  /** The latest change after the introduction; null when it is unchanged since. */
  readonly lastChange: FossilCommit | null;
}

export interface FossilReport {
  readonly order: FossilOrder;
  readonly fossils: readonly Fossil[];
  /** Current symbols considered (after path filters) whose introduction the evidence establishes. */
  readonly withOrigin: number;
  /** Current symbols considered whose origin lies before the indexed history: no claim is made. */
  readonly withoutOrigin: number;
  /** Of `withOrigin`, how many are unchanged since they were introduced. */
  readonly unchanged: number;
}

export interface FossilOptions {
  /** `introduced`: oldest introduction first; `untouched`: longest without a change first. */
  readonly order?: FossilOrder;
  readonly limit?: number;
  /** Include tests, examples, docs, fixtures and benchmarks. */
  readonly includeTests?: boolean;
}

export const DEFAULT_FOSSIL_LIMIT = 20;

/**
 * The oldest code still present: current symbols ordered by when they were
 * introduced, or by how long they have gone unchanged. Only symbols whose
 * introduction the index establishes (an `INTRODUCED_BY` relation) are
 * listed; code older than the indexed history is counted, never dated.
 */
export function analyzeFossils(
  db: FossilDb,
  repositoryId: number,
  options: FossilOptions = {},
): FossilReport {
  const order = options.order ?? 'introduced';
  const commitById = new Map(analysisCommits(db, repositoryId).map((c) => [c.id, c]));
  const considered = currentSymbolOrigins(db, repositoryId).filter(
    (origin) =>
      // Variables and properties are mostly import bindings and constants, not code with a story.
      origin.kind !== 'variable' &&
      origin.kind !== 'property' &&
      isCodePath(origin.path) &&
      !isGeneratedPath(origin.path) &&
      (options.includeTests || (!isTestPath(origin.path) && !isIllustrativePath(origin.path))),
  );
  const dated = considered.filter((origin) => origin.introduced !== null);
  const history = symbolChangeCommits(
    db,
    dated.map((origin) => origin.symbolId),
  );
  const commitOf = (id: number): FossilCommit | null => {
    const commit = commitById.get(id);
    return commit
      ? {
          sha: commit.sha,
          subject: commit.subject,
          committedAt: commit.committedAt,
          authorName: commit.authorName,
        }
      : null;
  };

  const fossils = dated.flatMap((origin): Fossil[] => {
    const introduction = origin.introduced;
    const born = introduction ? commitOf(introduction.commitId) : null;
    if (!introduction || !born) return [];
    const later = (history.get(origin.symbolId) ?? [])
      .filter((id) => id !== introduction.commitId)
      .map(commitOf)
      .filter((commit): commit is FossilCommit => commit !== null)
      .sort((a, b) => b.committedAt.localeCompare(a.committedAt));
    return [
      {
        symbol: {
          id: origin.symbolId,
          qualifiedName: origin.qualifiedName,
          kind: origin.kind,
          path: origin.path,
          startLine: origin.startLine,
          endLine: origin.endLine,
        },
        introduced: {
          ...born,
          level: introduction.level,
          confidence: introduction.confidence,
          evidenceIds: introduction.evidenceIds,
        },
        changesSince: later.length,
        lastChange: later[0] ?? null,
      },
    ];
  });

  const lastTouched = (fossil: Fossil) => (fossil.lastChange ?? fossil.introduced).committedAt;
  const sorted = [...fossils].sort((a, b) =>
    order === 'introduced'
      ? a.introduced.committedAt.localeCompare(b.introduced.committedAt) ||
        a.symbol.path.localeCompare(b.symbol.path) ||
        a.symbol.startLine - b.symbol.startLine
      : lastTouched(a).localeCompare(lastTouched(b)) ||
        a.symbol.path.localeCompare(b.symbol.path) ||
        a.symbol.startLine - b.symbol.startLine,
  );

  return {
    order,
    fossils: sorted.slice(0, options.limit ?? DEFAULT_FOSSIL_LIMIT),
    withOrigin: fossils.length,
    withoutOrigin: considered.length - dated.length,
    unchanged: fossils.filter((fossil) => fossil.changesSince === 0).length,
  };
}
