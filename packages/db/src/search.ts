import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import type { FossilDb } from './client.js';
import { commits, dependencies, files, issues, pullRequests, symbols } from './schema.js';

/** Most matches returned by a search; more are reported as ambiguous by the caller. */
const SEARCH_LIMIT = 20;

/** Escape `%` and `_` so user input is matched literally in LIKE. */
function literal(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

export function commitsByShaPrefix(
  db: FossilDb,
  repositoryId: number,
  prefix: string,
): { id: number; sha: string }[] {
  return db
    .select({ id: commits.id, sha: commits.sha })
    .from(commits)
    .where(
      and(
        eq(commits.repositoryId, repositoryId),
        like(commits.sha, sql`${`${literal(prefix.toLowerCase())}%`} ESCAPE '\\'`),
      ),
    )
    .limit(SEARCH_LIMIT)
    .all();
}

export function filesByPath(
  db: FossilDb,
  repositoryId: number,
  path: string,
): { id: number; path: string }[] {
  return db
    .select({ id: files.id, path: files.path })
    .from(files)
    .where(and(eq(files.repositoryId, repositoryId), eq(files.path, path)))
    .all();
}

/**
 * Symbols whose name or qualified name equals `name`, current ones first,
 * optionally limited to one file.
 */
export function symbolsByName(
  db: FossilDb,
  repositoryId: number,
  name: string,
  fileId?: number,
): { id: number; qualifiedName: string; kind: string; path: string; current: boolean }[] {
  return db
    .select({
      id: symbols.id,
      qualifiedName: symbols.qualifiedName,
      kind: symbols.kind,
      path: files.path,
      current: symbols.current,
    })
    .from(symbols)
    .innerJoin(files, eq(symbols.fileId, files.id))
    .where(
      and(
        eq(files.repositoryId, repositoryId),
        or(eq(symbols.name, name), eq(symbols.qualifiedName, name)),
        fileId === undefined ? undefined : eq(symbols.fileId, fileId),
      ),
    )
    .orderBy(desc(symbols.current), symbols.id)
    .limit(SEARCH_LIMIT)
    .all();
}

export function issueOrPullRequestByNumber(
  db: FossilDb,
  repositoryId: number,
  number: number,
): { type: 'issue' | 'pull_request'; id: number; title: string }[] {
  const externalId = String(number);
  const issueRows = db
    .select({ id: issues.id, title: issues.title })
    .from(issues)
    .where(and(eq(issues.repositoryId, repositoryId), eq(issues.externalId, externalId)))
    .all()
    .map((row) => ({ type: 'issue' as const, ...row }));
  const pullRows = db
    .select({ id: pullRequests.id, title: pullRequests.title })
    .from(pullRequests)
    .where(
      and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.externalId, externalId)),
    )
    .all()
    .map((row) => ({ type: 'pull_request' as const, ...row }));
  return [...issueRows, ...pullRows];
}

export function dependenciesByName(
  db: FossilDb,
  repositoryId: number,
  name: string,
  ecosystem?: string,
): { id: number; ecosystem: string; name: string; manifestFile: string }[] {
  return db
    .select({
      id: dependencies.id,
      ecosystem: dependencies.ecosystem,
      name: dependencies.name,
      manifestFile: dependencies.manifestFile,
    })
    .from(dependencies)
    .where(
      and(
        eq(dependencies.repositoryId, repositoryId),
        eq(dependencies.name, name),
        ecosystem === undefined ? undefined : eq(dependencies.ecosystem, ecosystem),
      ),
    )
    .orderBy(desc(dependencies.current), dependencies.id)
    .limit(SEARCH_LIMIT)
    .all();
}

/** Files whose path contains `text` (case-insensitive), current ones first. */
export function searchFiles(
  db: FossilDb,
  repositoryId: number,
  text: string,
  limit = SEARCH_LIMIT,
): { id: number; path: string; language: string | null; deletedAt: string | null }[] {
  return db
    .select({
      id: files.id,
      path: files.path,
      language: files.language,
      deletedAt: files.deletedAt,
    })
    .from(files)
    .where(
      and(
        eq(files.repositoryId, repositoryId),
        text === '' ? undefined : like(files.path, sql`${`%${literal(text)}%`} ESCAPE '\\'`),
      ),
    )
    .orderBy(sql`${files.deletedAt} IS NOT NULL`, files.path)
    .limit(limit)
    .all();
}

/** The most recent commits, newest first. */
export function recentCommits(
  db: FossilDb,
  repositoryId: number,
  limit = SEARCH_LIMIT,
): { id: number; sha: string; subject: string; authorName: string; committedAt: string }[] {
  return db
    .select({
      id: commits.id,
      sha: commits.sha,
      subject: commits.subject,
      authorName: commits.authorName,
      committedAt: commits.committedAt,
    })
    .from(commits)
    .where(eq(commits.repositoryId, repositoryId))
    .orderBy(desc(commits.committedAt), desc(commits.id))
    .limit(limit)
    .all();
}
