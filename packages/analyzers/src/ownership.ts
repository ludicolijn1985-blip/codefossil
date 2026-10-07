import { analysisChanges, analysisCommits, analysisFiles, type FossilDb } from '@codefossil/db';
import { isTestPath } from '@codefossil/query';
import { People, type EvidenceLevel } from '@codefossil/shared';
import { fileActivity } from './file-history.js';
import { isCodePath, isGeneratedPath } from './hotspots.js';

/** An author's part in a file's history. */
export interface AuthorShare {
  readonly author: string;
  readonly commits: number;
  /** Lines added plus deleted by this author's commits. */
  readonly churn: number;
  /** Share of the file's churn (of its commits when no lines were counted), 0–1. */
  readonly share: number;
  /** This author's latest change to the file. */
  readonly lastChangedAt: string;
  /** This author's latest commit anywhere in the repository. */
  readonly lastCommitAt: string;
  /** Committed anywhere in the repository within the activity window. */
  readonly active: boolean;
}

export interface FileOwnership {
  readonly file: { readonly id: number; readonly path: string };
  readonly commits: number;
  readonly churn: number;
  /** Authors by share, largest first. */
  readonly authors: readonly AuthorShare[];
  /**
   * The history of the file is mostly one author's (at least the
   * concentration threshold) and that author has not committed within the
   * activity window: what the history knows of it may have left.
   */
  readonly atRisk: boolean;
}

export interface OwnershipReport {
  /** The file or directory looked at; null for the whole repository. */
  readonly scope: string | null;
  readonly filesConsidered: number;
  /**
   * The fewest authors whose leaving would leave more than half of the files
   * without anyone who wrote a substantial part of them (truck factor).
   */
  readonly busFactor: number;
  /** Those authors, in the order they were removed. */
  readonly busFactorAuthors: readonly string[];
  /** The repository's latest commit: "active" is measured back from here, not from today. */
  readonly asOf: string | null;
  readonly activeWindowDays: number;
  /** Files, those at risk first, then by churn. */
  readonly files: readonly FileOwnership[];
  readonly classification: EvidenceLevel;
  readonly notes: readonly string[];
}

export interface OwnershipOptions {
  /** A file path or a directory prefix, relative to the repository root. */
  readonly path?: string;
  readonly limit?: number;
  readonly includeTests?: boolean;
  /** Days before the latest commit within which an author counts as active (default 365). */
  readonly activeDays?: number;
}

/** An author who wrote at least this share of a file knows it, for the bus factor. */
const KNOWLEDGE_SHARE = 0.25;
/** A file this concentrated in one author depends on that author. */
const CONCENTRATION = 0.75;
const DEFAULT_ACTIVE_DAYS = 365;
const DEFAULT_LIMIT = 20;

const round = (value: number) => Math.round(value * 1000) / 1000;

function inScope(path: string, scope: string | undefined): boolean {
  if (!scope) return true;
  const prefix = scope.replace(/\/+$/, '');
  return path === prefix || path.startsWith(`${prefix}/`);
}

/**
 * The truck factor: greedily remove the author who knows the most remaining
 * files until more than half of the files have nobody left who knows them.
 */
function truckFactor(knowers: readonly ReadonlySet<string>[]): string[] {
  const remaining = knowers.map((set) => new Set(set));
  const removed: string[] = [];
  const orphaned = () => remaining.filter((set) => set.size === 0).length;
  while (remaining.length > 0 && orphaned() * 2 <= remaining.length) {
    const counts = new Map<string, number>();
    for (const set of remaining)
      for (const author of set) counts.set(author, (counts.get(author) ?? 0) + 1);
    const [top] = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (!top) break;
    removed.push(top[0]);
    for (const set of remaining) set.delete(top[0]);
  }
  return removed;
}

/**
 * Who wrote the code at HEAD, by the indexed history: per file each author's
 * share of the lines changed, whether they are still active, and the bus
 * factor of the files in scope. Authorship of changes is a proxy for
 * knowledge, so the reading is INFERRED; the counts behind it are facts.
 */
export function analyzeOwnership(
  db: FossilDb,
  repositoryId: number,
  options: OwnershipOptions = {},
): OwnershipReport {
  const activeDays = options.activeDays ?? DEFAULT_ACTIVE_DAYS;
  const commits = analysisCommits(db, repositoryId);
  const commitById = new Map(commits.map((c) => [c.id, c]));
  const people = new People(commits, activeDays);
  const asOf = people.asOf;

  const activity = fileActivity(
    analysisFiles(db, repositoryId),
    analysisChanges(db, repositoryId),
  ).filter(
    (file) =>
      file.commitIds.size > 0 &&
      inScope(file.path, options.path) &&
      isCodePath(file.path) &&
      !isGeneratedPath(file.path) &&
      (options.includeTests || !isTestPath(file.path)),
  );

  const owned = activity.map((file): FileOwnership => {
    const byAuthor = new Map<string, { commits: number; churn: number; last: string }>();
    for (const commitId of file.commitIds) {
      const commit = commitById.get(commitId);
      if (!commit) continue;
      const person = people.personOf(commit);
      const entry = byAuthor.get(person) ?? { commits: 0, churn: 0, last: '' };
      byAuthor.set(person, {
        commits: entry.commits + 1,
        churn: entry.churn + (file.churnByCommit.get(commitId) ?? 0),
        last: commit.committedAt > entry.last ? commit.committedAt : entry.last,
      });
    }
    const byLines = file.churn > 0;
    const authors = [...byAuthor]
      .map(([author, entry]): AuthorShare => ({
        author,
        commits: entry.commits,
        churn: entry.churn,
        share: round(byLines ? entry.churn / file.churn : entry.commits / file.commitIds.size),
        lastChangedAt: entry.last,
        lastCommitAt: people.lastCommitOf(author) ?? entry.last,
        active: people.isActive(author),
      }))
      .sort(
        (a, b) => b.share - a.share || b.commits - a.commits || a.author.localeCompare(b.author),
      );
    const top = authors[0];
    return {
      file: { id: file.fileId, path: file.path },
      commits: file.commitIds.size,
      churn: file.churn,
      authors,
      atRisk: top !== undefined && top.share >= CONCENTRATION && !top.active,
    };
  });

  const removed = truckFactor(
    owned.map(
      (file) =>
        new Set(
          file.authors
            .filter((a, index) => index === 0 || a.share >= KNOWLEDGE_SHARE)
            .map((a) => a.author),
        ),
    ),
  );
  const ordered = [...owned].sort(
    (a, b) =>
      Number(b.atRisk) - Number(a.atRisk) ||
      b.churn - a.churn ||
      a.file.path.localeCompare(b.file.path),
  );
  return {
    scope: options.path ?? null,
    filesConsidered: owned.length,
    busFactor: removed.length,
    busFactorAuthors: removed,
    asOf,
    activeWindowDays: activeDays,
    files: ordered.slice(0, options.limit ?? DEFAULT_LIMIT),
    classification: 'INFERRED',
    notes: [
      'Shares are lines added and deleted per author (commits when no lines were counted), from the indexed history of each file, across renames.',
      `An author is active when they committed anywhere in the repository within ${String(activeDays)} days of its latest commit.`,
      `A file is at risk when one inactive author wrote at least ${String(CONCENTRATION * 100)}% of it.`,
      `Bus factor: the fewest authors whose leaving leaves more than half of the files without anyone who wrote at least ${String(KNOWLEDGE_SHARE * 100)}% of them (or most of them).`,
      'Authorship of changes stands in for knowledge (INFERRED). One person is one author across name spellings and every name used with the same email address (and .mailmap).',
    ],
  };
}
