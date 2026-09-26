import { and, eq, type SQL } from 'drizzle-orm';
import type { SQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core';
import type { EntityRef, EntityType } from '@codefossil/shared';
import type { FossilDb } from './client.js';
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
  return ENTITY_LOOKUPS[ref.type](db, repositoryId, ref.id);
}

type Lookup = (db: FossilDb, repositoryId: number, id: number) => boolean;

/** Entity tables that carry their own `repository_id` column. */
function direct(table: SQLiteTable & { id: SQLiteColumn; repositoryId: SQLiteColumn }): Lookup {
  return (db, repositoryId, id) =>
    exists(db, table, and(eq(table.id, id), eq(table.repositoryId, repositoryId)));
}

function exists(db: FossilDb, table: SQLiteTable, where: SQL | undefined): boolean {
  return db.select().from(table).where(where).limit(1).all().length > 0;
}

const ENTITY_LOOKUPS: Record<EntityType, Lookup> = {
  repository: (db, repositoryId, id) =>
    id === repositoryId && exists(db, repositories, eq(repositories.id, id)),
  commit: direct(commits),
  file: direct(files),
  issue: direct(issues),
  pull_request: direct(pullRequests),
  dependency: direct(dependencies),
  incident: direct(incidents),
  symbol: (db, repositoryId, id) =>
    db
      .select({ id: symbols.id })
      .from(symbols)
      .innerJoin(files, eq(symbols.fileId, files.id))
      .where(and(eq(symbols.id, id), eq(files.repositoryId, repositoryId)))
      .limit(1)
      .all().length > 0,
  test: (db, repositoryId, id) =>
    db
      .select({ id: tests.id })
      .from(tests)
      .innerJoin(files, eq(tests.fileId, files.id))
      .where(and(eq(tests.id, id), eq(files.repositoryId, repositoryId)))
      .limit(1)
      .all().length > 0,
  review: (db, repositoryId, id) =>
    db
      .select({ id: reviews.id })
      .from(reviews)
      .innerJoin(pullRequests, eq(reviews.pullRequestId, pullRequests.id))
      .where(and(eq(reviews.id, id), eq(pullRequests.repositoryId, repositoryId)))
      .limit(1)
      .all().length > 0,
};
