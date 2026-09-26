import { and, eq, sql } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { EntityRef, EntityType } from '@codefossil/shared';
import type { FossilDb } from './client.js';
import { preparedFor } from './prepared.js';
import {
  commits,
  dependencies,
  files,
  incidents,
  issues,
  pullRequests,
  repositories,
  reviews,
  symbols,
  tests,
} from './schema.js';

/**
 * Relations point at entities polymorphically (`source_type` + `source_id`), so
 * SQLite cannot enforce those references with foreign keys. This check does it
 * in code: the entity must exist and belong to the given repository.
 */
export function entityExists(db: FossilDb, repositoryId: number, ref: EntityRef): boolean {
  if (ref.type === 'repository' && ref.id !== repositoryId) return false;
  return lookups(db)[ref.type].get({ id: ref.id, repositoryId }) !== undefined;
}

const id = sql.placeholder('id');
const repositoryId = sql.placeholder('repositoryId');

/** Entity tables that carry their own `repository_id` column. */
function direct(
  db: FossilDb,
  table: SQLiteTable & { id: SQLiteColumn; repositoryId: SQLiteColumn },
) {
  return db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.id, id), eq(table.repositoryId, repositoryId)))
    .prepare();
}

const lookups = preparedFor((db) => {
  const statements = {
    repository: db
      .select({ id: repositories.id })
      .from(repositories)
      .where(and(eq(repositories.id, id), eq(repositories.id, repositoryId)))
      .prepare(),
    commit: direct(db, commits),
    file: direct(db, files),
    issue: direct(db, issues),
    pull_request: direct(db, pullRequests),
    dependency: direct(db, dependencies),
    incident: direct(db, incidents),
    symbol: db
      .select({ id: symbols.id })
      .from(symbols)
      .innerJoin(files, eq(symbols.fileId, files.id))
      .where(and(eq(symbols.id, id), eq(files.repositoryId, repositoryId)))
      .prepare(),
    test: db
      .select({ id: tests.id })
      .from(tests)
      .innerJoin(files, eq(tests.fileId, files.id))
      .where(and(eq(tests.id, id), eq(files.repositoryId, repositoryId)))
      .prepare(),
    review: db
      .select({ id: reviews.id })
      .from(reviews)
      .innerJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
      .where(and(eq(reviews.id, id), eq(pullRequests.repositoryId, repositoryId)))
      .prepare(),
  } satisfies Record<EntityType, unknown>;
  return statements as Record<
    EntityType,
    { get(values: { id: number; repositoryId: number }): { id: number } | undefined }
  >;
});
