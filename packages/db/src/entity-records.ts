import { eq, inArray } from 'drizzle-orm';
import type { EntityRef, EntityType } from '@codefossil/shared';
import type { FossilDb } from './client.js';
import {
  commits,
  dependencies,
  evidence,
  files,
  incidents,
  issues,
  pullRequests,
  repositories,
  reviews,
  symbols,
  tests,
} from './schema.js';

/** The stored facts about one entity, enough to name and place it. */
export type EntityRecord =
  | {
      readonly type: 'repository';
      readonly id: number;
      readonly name: string;
      readonly path: string;
    }
  | {
      readonly type: 'commit';
      readonly id: number;
      readonly sha: string;
      readonly subject: string;
      readonly authorName: string;
      readonly committedAt: string;
    }
  | {
      readonly type: 'file';
      readonly id: number;
      readonly path: string;
      readonly language: string | null;
      readonly deletedAt: string | null;
    }
  | {
      readonly type: 'symbol';
      readonly id: number;
      readonly name: string;
      readonly qualifiedName: string;
      readonly kind: string;
      readonly path: string;
      readonly startLine: number;
      readonly endLine: number;
      readonly current: boolean;
    }
  | {
      readonly type: 'issue' | 'pull_request';
      readonly id: number;
      readonly number: number;
      readonly title: string;
      readonly state: string;
      readonly url: string | null;
      readonly mergedAt: string | null;
    }
  | {
      readonly type: 'review';
      readonly id: number;
      readonly author: string;
      readonly state: string | null;
      readonly submittedAt: string;
    }
  | { readonly type: 'test'; readonly id: number; readonly name: string }
  | {
      readonly type: 'dependency';
      readonly id: number;
      readonly ecosystem: string;
      readonly name: string;
      readonly version: string | null;
      readonly scope: string;
    }
  | { readonly type: 'incident'; readonly id: number; readonly title: string };

export const entityKey = (ref: EntityRef): string => `${ref.type}:${ref.id}`;

type Loader = (db: FossilDb, ids: number[]) => EntityRecord[];

const LOADERS: Record<EntityType, Loader> = {
  repository: (db, ids) =>
    db
      .select({ id: repositories.id, name: repositories.name, path: repositories.path })
      .from(repositories)
      .where(inArray(repositories.id, ids))
      .all()
      .map((row) => ({ type: 'repository', ...row })),
  commit: (db, ids) =>
    db
      .select({
        id: commits.id,
        sha: commits.sha,
        subject: commits.subject,
        authorName: commits.authorName,
        committedAt: commits.committedAt,
      })
      .from(commits)
      .where(inArray(commits.id, ids))
      .all()
      .map((row) => ({ type: 'commit', ...row })),
  file: (db, ids) =>
    db
      .select({
        id: files.id,
        path: files.path,
        language: files.language,
        deletedAt: files.deletedAt,
      })
      .from(files)
      .where(inArray(files.id, ids))
      .all()
      .map((row) => ({ type: 'file', ...row })),
  symbol: (db, ids) =>
    db
      .select({
        id: symbols.id,
        name: symbols.name,
        qualifiedName: symbols.qualifiedName,
        kind: symbols.kind,
        path: files.path,
        startLine: symbols.startLine,
        endLine: symbols.endLine,
        current: symbols.current,
      })
      .from(symbols)
      .innerJoin(files, eq(symbols.fileId, files.id))
      .where(inArray(symbols.id, ids))
      .all()
      .map((row) => ({ type: 'symbol', ...row })),
  issue: (db, ids) =>
    db
      .select({
        id: issues.id,
        externalId: issues.externalId,
        title: issues.title,
        state: issues.state,
        url: issues.url,
      })
      .from(issues)
      .where(inArray(issues.id, ids))
      .all()
      .map(({ externalId, ...row }) => ({
        type: 'issue',
        number: Number(externalId),
        mergedAt: null,
        ...row,
      })),
  pull_request: (db, ids) =>
    db
      .select({
        id: pullRequests.id,
        externalId: pullRequests.externalId,
        title: pullRequests.title,
        state: pullRequests.state,
        url: pullRequests.url,
        mergedAt: pullRequests.mergedAt,
      })
      .from(pullRequests)
      .where(inArray(pullRequests.id, ids))
      .all()
      .map(({ externalId, ...row }) => ({
        type: 'pull_request',
        number: Number(externalId),
        ...row,
      })),
  review: (db, ids) =>
    db
      .select({
        id: reviews.id,
        author: reviews.author,
        state: reviews.state,
        submittedAt: reviews.submittedAt,
      })
      .from(reviews)
      .where(inArray(reviews.id, ids))
      .all()
      .map((row) => ({ type: 'review', ...row })),
  test: (db, ids) =>
    db
      .select({ id: tests.id, name: tests.name })
      .from(tests)
      .where(inArray(tests.id, ids))
      .all()
      .map((row) => ({ type: 'test', ...row })),
  dependency: (db, ids) =>
    db
      .select({
        id: dependencies.id,
        ecosystem: dependencies.ecosystem,
        name: dependencies.name,
        version: dependencies.version,
        scope: dependencies.scope,
      })
      .from(dependencies)
      .where(inArray(dependencies.id, ids))
      .all()
      .map((row) => ({ type: 'dependency', ...row })),
  incident: (db, ids) =>
    db
      .select({ id: incidents.id, title: incidents.title })
      .from(incidents)
      .where(inArray(incidents.id, ids))
      .all()
      .map((row) => ({ type: 'incident', ...row })),
};

/** SQLite limits bound parameters per statement; stay well below it. */
const CHUNK = 500;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

/** Load many entities of mixed types with one query per type (and chunk). Keyed by `type:id`. */
export function loadEntityRecords(
  db: FossilDb,
  refs: readonly EntityRef[],
): Map<string, EntityRecord> {
  const idsByType = new Map<EntityType, Set<number>>();
  for (const ref of refs) {
    idsByType.set(ref.type, (idsByType.get(ref.type) ?? new Set()).add(ref.id));
  }
  const out = new Map<string, EntityRecord>();
  for (const [type, ids] of idsByType) {
    for (const chunk of chunks([...ids])) {
      for (const record of LOADERS[type](db, chunk)) out.set(entityKey(record), record);
    }
  }
  return out;
}

export type EvidenceRecord = typeof evidence.$inferSelect;

/** Load evidence rows by id. */
export function loadEvidenceRecords(
  db: FossilDb,
  ids: readonly number[],
): Map<number, EvidenceRecord> {
  const out = new Map<number, EvidenceRecord>();
  for (const chunk of chunks([...new Set(ids)])) {
    for (const row of db.select().from(evidence).where(inArray(evidence.id, chunk)).all()) {
      out.set(row.id, row);
    }
  }
  return out;
}
