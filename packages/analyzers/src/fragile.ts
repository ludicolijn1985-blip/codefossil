import {
  analysisCommits,
  analysisFiles,
  commitDiscussions,
  commitEvidenceIds,
  currentSymbolOrigins,
  symbolChangeCommits,
  symbolsChangedIn,
  type FossilDb,
} from '@codefossil/db';
import type { EvidenceLevel } from '@codefossil/shared';
import { isTestPath } from '@codefossil/query';
import { classifyDefects } from './defects.js';
import { isCodePath, isDeclarationPath, isGeneratedPath, isIllustrativePath } from './hotspots.js';

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
    readonly repo: string | null;
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

interface Candidate {
  readonly symbolId: number;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly path: string;
  readonly startLine: number;
}

/**
 * The defect fixes in each candidate's history (commits in `exclude` left
 * out), for candidates with at least one: most fixes first.
 */
function fixHistories(
  db: FossilDb,
  repositoryId: number,
  candidates: readonly Candidate[],
  exclude: ReadonlySet<number>,
): FragileSymbol[] {
  if (candidates.length === 0) return [];
  const commits = analysisCommits(db, repositoryId);
  const commitById = new Map(commits.map((c) => [c.id, c]));
  const discussions = commitDiscussions(db, repositoryId);
  const defects = classifyDefects(commits, discussions, commitEvidenceIds(db, repositoryId));
  const discussionsByCommit = new Map<number, FragileFix['discussions'][number][]>();
  for (const d of discussions) {
    const list = discussionsByCommit.get(d.commitId) ?? [];
    if (!list.some((x) => x.type === d.type && x.number === d.number && x.repo === d.repo)) {
      list.push({ type: d.type, number: d.number, repo: d.repo });
    }
    discussionsByCommit.set(d.commitId, list);
  }
  const history = symbolChangeCommits(
    db,
    candidates.map((c) => c.symbolId),
  );

  return candidates
    .flatMap((symbol): FragileSymbol[] => {
      const earlier = (history.get(symbol.symbolId) ?? []).filter((id) => !exclude.has(id));
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
            path: symbol.path,
            startLine: symbol.startLine,
          },
          priorChanges: earlier.length,
          fixes,
          level: weakest(fixes.map((f) => f.level)),
        },
      ];
    })
    .sort(
      (a, b) =>
        b.fixes.length - a.fixes.length ||
        b.priorChanges - a.priorChanges ||
        a.symbol.path.localeCompare(b.symbol.path) ||
        a.symbol.qualifiedName.localeCompare(b.symbol.qualifiedName),
    );
}

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
  const idBySha = new Map(analysisCommits(db, repositoryId).map((c) => [c.sha, c.id]));
  const rangeIds = rangeShas.flatMap((sha) => {
    const id = idBySha.get(sha);
    return id === undefined ? [] : [id];
  });
  const pathById = new Map(analysisFiles(db, repositoryId).map((f) => [f.id, f.path]));
  const touched = new Map(
    symbolsChangedIn(db, rangeIds)
      .filter((s) => s.current)
      .map((s) => [s.symbolId, { ...s, path: pathById.get(s.fileId) ?? '' }]),
  );
  const symbols = fixHistories(db, repositoryId, [...touched.values()], new Set(rangeIds));
  return {
    symbols: symbols.slice(0, options.limit ?? Number.MAX_SAFE_INTEGER),
    total: symbols.length,
    symbolsTouched: touched.size,
  };
}

export interface FixedSymbolsReport {
  /** Current symbols with defect fixes in their history, most fixes first. */
  readonly symbols: readonly FragileSymbol[];
  /** Symbols with at least one fix, before the limit. */
  readonly total: number;
  /** Current symbols considered after the path filters. */
  readonly considered: number;
}

/**
 * The functions, methods and classes fixed most often: every current symbol
 * ranked by the defect fixes that changed it. Variables, tests, examples and
 * generated files are left out unless asked.
 */
export function analyzeFixedSymbols(
  db: FossilDb,
  repositoryId: number,
  options: { readonly limit?: number; readonly includeTests?: boolean } = {},
): FixedSymbolsReport {
  const candidates = currentSymbolOrigins(db, repositoryId).filter(
    (s) =>
      s.kind !== 'variable' &&
      s.kind !== 'property' &&
      isCodePath(s.path) &&
      !isGeneratedPath(s.path) &&
      !isDeclarationPath(s.path) &&
      (options.includeTests || (!isTestPath(s.path) && !isIllustrativePath(s.path))),
  );
  const symbols = fixHistories(db, repositoryId, candidates, new Set());
  return {
    symbols: symbols.slice(0, options.limit ?? Number.MAX_SAFE_INTEGER),
    total: symbols.length,
    considered: candidates.length,
  };
}
