import {
  analysisCommits,
  analysisFiles,
  commitDiscussions,
  commitEvidenceIds,
  symbolChangeCommits,
  symbolsChangedIn,
  type FossilDb,
} from '@codefossil/db';
import type { EvidenceLevel } from '@codefossil/shared';
import { classifyDefects } from './defects.js';

/** An earlier commit that changed the symbol and reads as a defect fix. */
export interface FragileFix {
  readonly sha: string;
  readonly subject: string;
  readonly committedAt: string;
  readonly reason: string;
  readonly level: EvidenceLevel;
  readonly confidence: number;
  readonly evidenceIds: readonly number[];
  /** Issues and pull requests linked to the fix commit. */
  readonly discussions: readonly {
    readonly type: 'issue' | 'pull_request';
    readonly number: string;
  }[];
}

/** A symbol a change touches that earlier fixes touched too. */
export interface FragileSymbol {
  readonly symbol: {
    readonly id: number;
    readonly qualifiedName: string;
    readonly kind: string;
    readonly path: string;
    readonly startLine: number;
  };
  /** Earlier commits (before the change) that changed the symbol. */
  readonly priorChanges: number;
  /** Earlier defect fixes, newest first. */
  readonly fixes: readonly FragileFix[];
  /** The weakest level among the fixes: the claim is never surer than its weakest part. */
  readonly level: EvidenceLevel;
}

export interface FragileReport {
  /** Symbols with at least one earlier fix, most fixes first. */
  readonly symbols: readonly FragileSymbol[];
  /** Symbols with earlier fixes before the limit was applied. */
  readonly total: number;
  /** Current symbols the change touched, with or without fixes. */
  readonly symbolsTouched: number;
}

const LEVEL_ORDER: readonly EvidenceLevel[] = ['INFERRED', 'DERIVED', 'FACT'];

const weakest = (levels: readonly EvidenceLevel[]): EvidenceLevel =>
  LEVEL_ORDER.find((level) => levels.includes(level)) ?? 'FACT';

/**
 * The symbols changed by a range of commits (a pull request) whose earlier
 * history holds defect fixes: the code that broke before. Fix detection is
 * the hotspot analyzer's (issue labels, reverts, fix wording), so most fixes
 * are INFERRED. Commits inside the range never count as earlier fixes.
 */
export function analyzeFragileSymbols(
  db: FossilDb,
  repositoryId: number,
  rangeShas: readonly string[],
  options: { readonly limit?: number } = {},
): FragileReport {
  const commits = analysisCommits(db, repositoryId);
  const commitBySha = new Map(commits.map((c) => [c.sha, c]));
  const commitById = new Map(commits.map((c) => [c.id, c]));
  const rangeIds = rangeShas.flatMap((sha) => {
    const commit = commitBySha.get(sha);
    return commit ? [commit.id] : [];
  });
  const inRange = new Set(rangeIds);

  const touched = new Map(
    symbolsChangedIn(db, rangeIds)
      .filter((s) => s.current)
      .map((s) => [s.symbolId, s]),
  );
  if (touched.size === 0) return { symbols: [], total: 0, symbolsTouched: 0 };

  const discussions = commitDiscussions(db, repositoryId);
  const defects = classifyDefects(commits, discussions, commitEvidenceIds(db, repositoryId));
  const discussionsByCommit = new Map<number, FragileFix['discussions'][number][]>();
  for (const d of discussions) {
    const list = discussionsByCommit.get(d.commitId) ?? [];
    if (!list.some((x) => x.type === d.type && x.number === d.number)) {
      list.push({ type: d.type, number: d.number });
    }
    discussionsByCommit.set(d.commitId, list);
  }
  const pathById = new Map(analysisFiles(db, repositoryId).map((f) => [f.id, f.path]));
  const history = symbolChangeCommits(db, [...touched.keys()]);

  const symbols = [...touched.values()].flatMap((symbol): FragileSymbol[] => {
    const earlier = (history.get(symbol.symbolId) ?? []).filter((id) => !inRange.has(id));
    const fixes = earlier
      .flatMap((id): FragileFix[] => {
        const signal = defects.get(id);
        const commit = commitById.get(id);
        if (!signal || !commit) return [];
        return [
          {
            sha: commit.sha,
            subject: commit.subject,
            committedAt: commit.committedAt,
            reason: signal.reason,
            level: signal.level,
            confidence: signal.confidence,
            evidenceIds: signal.evidenceIds,
            discussions: discussionsByCommit.get(id) ?? [],
          },
        ];
      })
      .sort((a, b) => b.committedAt.localeCompare(a.committedAt));
    if (fixes.length === 0) return [];
    return [
      {
        symbol: {
          id: symbol.symbolId,
          qualifiedName: symbol.qualifiedName,
          kind: symbol.kind,
          path: pathById.get(symbol.fileId) ?? '',
          startLine: symbol.startLine,
        },
        priorChanges: earlier.length,
        fixes,
        level: weakest(fixes.map((f) => f.level)),
      },
    ];
  });

  return {
    symbols: symbols
      .sort(
        (a, b) =>
          b.fixes.length - a.fixes.length ||
          b.priorChanges - a.priorChanges ||
          a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName),
      )
      .slice(0, options.limit ?? Number.MAX_SAFE_INTEGER),
    total: symbols.length,
    symbolsTouched: touched.size,
  };
}
