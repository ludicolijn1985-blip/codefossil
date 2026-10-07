import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';
import {
  clearCoverage,
  fileCoverage,
  findFileByPath,
  hasCoverageReport,
  replaceCoverage,
  type FossilDb,
} from '@codefossil/db';

/** Where test runners write an lcov report by default, relative to the repository root. */
export const COVERAGE_REPORTS = ['coverage/lcov.info', 'lcov.info', 'coverage/lcov/lcov.info'];

/** Larger reports are refused unread; real ones are far smaller. */
const MAX_REPORT_BYTES = 100 * 1024 * 1024;
/** Lines beyond this are not real source lines; such a record is malformed. */
const MAX_LINE = 10_000_000;

export interface LcovFile {
  /** The source path as the report writes it (`SF:`). */
  readonly path: string;
  /** Instrumented lines, ascending. */
  readonly found: number[];
  /** Instrumented lines run at least once, ascending. */
  readonly hit: number[];
}

/**
 * Parse an lcov report: per source file (`SF:`), its instrumented lines and
 * their hit counts (`DA:line,hits`). A file reported more than once (several
 * test runs) is merged; malformed lines are skipped. The report is untrusted
 * input, so nothing in it is evaluated.
 */
export function parseLcov(text: string): LcovFile[] {
  const byPath = new Map<string, { found: Set<number>; hit: Set<number> }>();
  let current: { found: Set<number>; hit: Set<number> } | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('SF:')) {
      const path = line.slice(3);
      current = byPath.get(path) ?? { found: new Set(), hit: new Set() };
      byPath.set(path, current);
    } else if (line === 'end_of_record') {
      current = null;
    } else if (current && line.startsWith('DA:')) {
      const [lineText = '', hitsText = ''] = line.slice(3).split(',');
      const number = Number(lineText);
      const hits = Number(hitsText);
      if (!Number.isInteger(number) || number < 1 || number > MAX_LINE || !Number.isFinite(hits)) {
        continue;
      }
      current.found.add(number);
      if (hits > 0) current.hit.add(number);
    }
  }
  const ascending = (lines: Set<number>) => [...lines].sort((a, b) => a - b);
  return [...byPath].map(([path, lines]) => ({
    path,
    found: ascending(lines.found),
    hit: ascending(lines.hit),
  }));
}

export interface CoverageIndexResult {
  /** The report read, relative to the repository root; null when there is none. */
  readonly report: string | null;
  /** Repository files the report covers. */
  readonly files: number;
  /** Files in the report that are not in the repository (or outside it). */
  readonly skipped: number;
  /** The report was read before and has not changed since. */
  readonly unchanged: boolean;
  /** Why the report could not be read; the coverage stored before is kept. */
  readonly error: string | null;
}

/** A report path written by the runner, as a path relative to the repository root. */
function repositoryPath(root: string, written: string): string | null {
  const path = (isAbsolute(written) ? relative(root, written) : written).replace(/\\/g, '/');
  if (path === '' || path.startsWith('../') || path === '..' || isAbsolute(path)) return null;
  return path.replace(/^\.\//, '');
}

async function findReport(
  root: string,
): Promise<{ path: string; mtime: Date; size: number } | null> {
  for (const path of COVERAGE_REPORTS) {
    try {
      const info = await stat(join(root, path));
      if (info.isFile()) return { path, mtime: info.mtime, size: info.size };
    } catch {
      // Not there: try the next default location.
    }
  }
  return null;
}

/**
 * Read the line coverage of the repository's files from an lcov report in the
 * working tree, when there is one (see `COVERAGE_REPORTS`). Coverage is
 * stored as reported; whether it still applies to a file (the file may have
 * changed since the report was written) is decided where it is used.
 */
export async function indexCoverage(
  db: FossilDb,
  repositoryId: number,
  root: string,
): Promise<CoverageIndexResult> {
  const found = await findReport(root);
  if (!found) {
    if (fileCoverage(db, repositoryId).size > 0) clearCoverage(db, repositoryId);
    return { report: null, files: 0, skipped: 0, unchanged: false, error: null };
  }
  const generatedAt = found.mtime.toISOString();
  const locator = `${found.path}@${generatedAt}`;
  if (hasCoverageReport(db, repositoryId, locator)) {
    return {
      report: found.path,
      files: fileCoverage(db, repositoryId).size,
      skipped: 0,
      unchanged: true,
      error: null,
    };
  }
  const failed = (error: string): CoverageIndexResult => ({
    report: found.path,
    files: 0,
    skipped: 0,
    unchanged: false,
    error,
  });
  if (found.size > MAX_REPORT_BYTES) {
    return failed(`the report is larger than ${String(MAX_REPORT_BYTES / 1024 / 1024)} MiB`);
  }
  let text: string;
  try {
    text = await readFile(join(root, found.path), 'utf8');
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error));
  }

  const entries = parseLcov(text);
  const covered = new Map<number, { found: number[]; hit: number[] }>();
  let skipped = 0;
  for (const entry of entries) {
    const path = repositoryPath(root, entry.path);
    const file = path ? findFileByPath(db, repositoryId, path) : undefined;
    if (!file || file.deletedAt !== null) {
      skipped++;
      continue;
    }
    covered.set(file.id, { found: entry.found, hit: entry.hit });
  }
  db.transaction((tx) => {
    replaceCoverage(tx, repositoryId, {
      locator,
      path: found.path,
      generatedAt,
      files: [...covered].map(([fileId, lines]) => ({ fileId, ...lines })),
    });
  });
  return { report: found.path, files: covered.size, skipped, unchanged: false, error: null };
}

/** Covered and instrumented lines within a line range of one file. */
export function rangeCoverage(
  coverage: { readonly found: readonly number[]; readonly hit: readonly number[] },
  startLine: number,
  endLine: number,
): { readonly found: number; readonly hit: number } {
  const inRange = (line: number) => line >= startLine && line <= endLine;
  return {
    found: coverage.found.filter(inRange).length,
    hit: coverage.hit.filter(inRange).length,
  };
}
