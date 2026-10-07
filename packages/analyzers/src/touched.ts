import {
  analysisCommits,
  analysisFiles,
  currentFileCoverage,
  currentSymbolOrigins,
  incomingRelations,
  symbolChangeCommits,
  symbolsChangedIn,
  type FossilDb,
} from '@codefossil/db';
import { isTestPath } from '@codefossil/query';
import { isCodePath, isGeneratedPath } from './hotspots.js';

/** How a change affects a symbol: born in it, edited, or continuing an earlier symbol. */
export type TouchKind = 'new' | 'changed' | 'renamed' | 'moved' | 'copied';

/** A function, method or class a range of commits (a pull request) touches. */
export interface TouchedSymbol {
  readonly symbol: {
    readonly id: number;
    readonly qualifiedName: string;
    readonly kind: string;
    readonly path: string;
    readonly startLine: number;
  };
  readonly change: TouchKind;
  /** For a rename, move or copy made in the range: the symbol it continues. */
  readonly from: { readonly qualifiedName: string; readonly path: string } | null;
  /**
   * Lines of the symbol that ran in the tests, from a coverage report written
   * after the file's last indexed commit; null without one.
   */
  readonly coverage: { readonly hit: number; readonly found: number } | null;
  /**
   * Functions whose calls to it were resolved at HEAD (DERIVED, or INFERRED
   * by name), itself left out: what the change can break directly.
   */
  readonly callers: number;
}

export interface TouchedReport {
  /** New, renamed and moved symbols first, then the least covered. */
  readonly symbols: readonly TouchedSymbol[];
  readonly total: number;
  /** Whether a current coverage report covered any of them. */
  readonly withCoverage: number;
}

const ORDER: Readonly<Record<TouchKind, number>> = {
  new: 0,
  renamed: 1,
  moved: 2,
  copied: 3,
  changed: 4,
};

const coveredShare = (s: TouchedSymbol) =>
  s.coverage && s.coverage.found > 0 ? s.coverage.hit / s.coverage.found : 2;

/** The distinct symbols with a resolved call to a symbol, recursion left out. */
function callerCount(db: FossilDb, repositoryId: number, symbolId: number): number {
  const callers = new Set<number>();
  for (const row of incomingRelations(db, repositoryId, { type: 'symbol', id: symbolId })) {
    if (row.relation === 'CALLS' && row.sourceType === 'symbol' && row.sourceId !== symbolId) {
      callers.add(row.sourceId);
    }
  }
  return callers.size;
}

/**
 * The current functions, methods and classes a range of commits changes:
 * whether the range created, renamed or moved them (by their lineage, DERIVED
 * or INFERRED as recorded) and, when a coverage report is current for their
 * file, how many of their lines ran in the tests.
 */
export function analyzeTouchedSymbols(
  db: FossilDb,
  repositoryId: number,
  rangeShas: readonly string[],
  options: { readonly limit?: number } = {},
): TouchedReport {
  const idBySha = new Map(analysisCommits(db, repositoryId).map((c) => [c.sha, c.id]));
  const rangeIds = new Set(
    rangeShas.flatMap((sha) => {
      const id = idBySha.get(sha);
      return id === undefined ? [] : [id];
    }),
  );
  const pathById = new Map(analysisFiles(db, repositoryId).map((f) => [f.id, f.path]));
  const touched = new Map(
    symbolsChangedIn(db, [...rangeIds])
      .filter((s) => s.current && s.kind !== 'variable' && s.kind !== 'property')
      .map((s) => [s.symbolId, { ...s, path: pathById.get(s.fileId) ?? '' }]),
  );
  const candidates = [...touched.values()].filter(
    (s) => isCodePath(s.path) && !isGeneratedPath(s.path) && !isTestPath(s.path),
  );
  const history = symbolChangeCommits(
    db,
    candidates.map((c) => c.symbolId),
  );
  const origins = new Map(
    currentSymbolOrigins(db, repositoryId)
      .filter((o) => touched.has(o.symbolId))
      .map((o) => [o.symbolId, o]),
  );
  const coverageByFile = new Map<number, ReturnType<typeof currentFileCoverage>>();

  const symbols = candidates.map((s): TouchedSymbol => {
    // Born in the range when every recorded version of it comes from the range.
    const bornHere = (history.get(s.symbolId) ?? []).every((id) => rangeIds.has(id));
    const copied = origins.get(s.symbolId)?.copiedFrom ?? null;
    const change: TouchKind = !bornHere ? 'changed' : copied ? copied.kind : 'new';
    if (!coverageByFile.has(s.fileId)) {
      coverageByFile.set(s.fileId, currentFileCoverage(db, s.fileId));
    }
    const lines = coverageByFile.get(s.fileId);
    const inSymbol = (line: number) => line >= s.startLine && line <= s.endLine;
    const found = lines ? lines.found.filter(inSymbol).length : 0;
    return {
      symbol: {
        id: s.symbolId,
        qualifiedName: s.qualifiedName,
        kind: s.kind,
        path: s.path,
        startLine: s.startLine,
      },
      change,
      from: bornHere && copied ? { qualifiedName: copied.qualifiedName, path: copied.path } : null,
      coverage: lines && found > 0 ? { hit: lines.hit.filter(inSymbol).length, found } : null,
      callers: callerCount(db, repositoryId, s.symbolId),
    };
  });
  symbols.sort(
    (a, b) =>
      ORDER[a.change] - ORDER[b.change] ||
      coveredShare(a) - coveredShare(b) ||
      a.symbol.path.localeCompare(b.symbol.path) ||
      a.symbol.startLine - b.symbol.startLine,
  );
  return {
    symbols: symbols.slice(0, options.limit ?? Number.MAX_SAFE_INTEGER),
    total: symbols.length,
    withCoverage: symbols.filter((s) => s.coverage !== null).length,
  };
}
