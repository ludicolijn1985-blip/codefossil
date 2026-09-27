import { findFileByPath, getIndexStatus, type FossilDb } from '@codefossil/db';
import { analyzeImpact } from '@codefossil/query';
import type { EvidenceLevel } from '@codefossil/shared';
import { analyzeDeadIntent, type DeadIntentCandidate } from './dead-intent.js';
import { analyzeHotspots, isGeneratedPath, type Hotspot } from './hotspots.js';

/** How one file changed by a pull request (or any base..HEAD range) stands in the history. */
export interface ChangedFileReport {
  readonly path: string;
  /** `deleted`: gone at HEAD; `unindexed`: not in the index (e.g. generated, or index is stale). */
  readonly status: 'changed' | 'deleted' | 'unindexed' | 'generated';
  readonly history: {
    /** Rank among the files with history (1 = hottest). */
    readonly rank: number;
    readonly commits: number;
    readonly defectCount: number;
    readonly score: number;
    readonly riskScore: number;
    readonly classification: EvidenceLevel;
  } | null;
  readonly impact: {
    readonly direct: number;
    readonly transitive: number;
    readonly tests: number;
    /** A few direct dependents, by path. */
    readonly examples: readonly string[];
    readonly truncated: boolean;
  } | null;
}

export interface RepositoryReport {
  readonly repository: {
    readonly name: string;
    readonly headSha: string | null;
    readonly indexedAt: string | null;
  };
  readonly counts: {
    readonly commits: number;
    readonly files: number;
    readonly symbols: number;
    readonly relations: Readonly<Record<EvidenceLevel, number>>;
  };
  readonly base: string | null;
  /** Null without a base; the changed files (most-depended-on first) otherwise. */
  readonly changed: readonly ChangedFileReport[] | null;
  readonly changedTotal: number;
  readonly hotspots: readonly Hotspot[];
  readonly deadIntent: readonly DeadIntentCandidate[];
  readonly filesRanked: number;
}

export interface ReportOptions {
  /** A base revision the changed paths were computed against, for display. */
  readonly base?: string;
  /** Paths changed since the base (repository-relative). */
  readonly changedPaths?: readonly string[];
  readonly hotspotLimit?: number;
  readonly deadIntentLimit?: number;
  /** Changed files examined in detail; the rest are counted. */
  readonly changedLimit?: number;
  readonly now?: Date;
}

const DEFAULT_REPORT_HOTSPOTS = 10;
const DEFAULT_REPORT_DEAD_INTENT = 5;
const DEFAULT_CHANGED_LIMIT = 25;
const IMPACT_EXAMPLES = 3;

/**
 * Everything a repository report shows, computed from the index: its size,
 * the files a change touches with their history and dependents, the
 * historical hotspots and dead-intent candidates.
 */
export function buildReport(
  db: FossilDb,
  repositoryId: number,
  options: ReportOptions = {},
): RepositoryReport {
  const status = getIndexStatus(db, repositoryId);
  if (!status) throw new Error(`Repository ${String(repositoryId)} is not indexed.`);

  const ranking = analyzeHotspots(db, repositoryId, {
    includeTests: true,
    limit: Number.MAX_SAFE_INTEGER,
  });
  const rankByPath = new Map(
    ranking.hotspots.map((h, index) => [h.file.path, { hotspot: h, rank: index + 1 }]),
  );

  const changedPaths = options.changedPaths ? [...new Set(options.changedPaths)].sort() : null;
  const changed = changedPaths
    ?.slice(0, options.changedLimit ?? DEFAULT_CHANGED_LIMIT)
    .map((path) => changedFile(db, repositoryId, path, rankByPath.get(path)))
    .sort(
      (a, b) =>
        (b.impact?.transitive ?? -1) +
          (b.impact?.direct ?? 0) -
          ((a.impact?.transitive ?? -1) + (a.impact?.direct ?? 0)) || a.path.localeCompare(b.path),
    );

  return {
    repository: {
      name: status.repository.name,
      headSha: status.latestCommit?.sha ?? null,
      indexedAt: status.repository.indexedAt,
    },
    counts: {
      commits: status.counts.commits,
      files: status.counts.currentFiles,
      symbols: status.counts.currentSymbols,
      relations: status.counts.relations,
    },
    base: options.base ?? null,
    changed: changed ?? null,
    changedTotal: changedPaths?.length ?? 0,
    hotspots: analyzeHotspots(db, repositoryId, {
      limit: options.hotspotLimit ?? DEFAULT_REPORT_HOTSPOTS,
    }).hotspots,
    deadIntent: analyzeDeadIntent(db, repositoryId, {
      limit: options.deadIntentLimit ?? DEFAULT_REPORT_DEAD_INTENT,
      ...(options.now ? { now: options.now } : {}),
    }).candidates,
    filesRanked: ranking.filesConsidered,
  };
}

function changedFile(
  db: FossilDb,
  repositoryId: number,
  path: string,
  ranked: { hotspot: Hotspot; rank: number } | undefined,
): ChangedFileReport {
  const file = findFileByPath(db, repositoryId, path);
  const base = { path, history: null, impact: null };
  if (isGeneratedPath(path)) return { ...base, status: 'generated' };
  if (!file) return { ...base, status: 'unindexed' };
  if (file.deletedAt !== null) return { ...base, status: 'deleted' };
  const impact = analyzeImpact(db, repositoryId, { type: 'file', id: file.id });
  const all = [...impact.direct, ...impact.transitive];
  return {
    path,
    status: 'changed',
    history: ranked
      ? {
          rank: ranked.rank,
          commits: ranked.hotspot.commits,
          defectCount: ranked.hotspot.defectCount,
          score: ranked.hotspot.score,
          riskScore: ranked.hotspot.risk.score,
          classification: ranked.hotspot.classification,
        }
      : null,
    impact: {
      direct: impact.direct.length,
      transitive: impact.transitive.length,
      tests: all.filter((d) => d.isTest).length,
      examples: impact.direct.slice(0, IMPACT_EXAMPLES).map((d) => d.label),
      truncated: impact.truncated.length > 0,
    },
  };
}
