import type { FossilDb } from './client.js';

/**
 * Lazily build a set of prepared statements once per database handle and
 * reuse them. Building SQL with Drizzle and preparing it in SQLite costs far
 * more than executing it, so hot paths such as indexing must not do it per
 * row.
 *
 * A transaction handle is a distinct object and gets its own set, which is
 * prepared on first use in that transaction.
 */
export function preparedFor<T>(build: (db: FossilDb) => T): (db: FossilDb) => T {
  const cache = new WeakMap<FossilDb, T>();
  return (db) => {
    let statements = cache.get(db);
    if (statements === undefined) {
      statements = build(db);
      cache.set(db, statements);
    }
    return statements;
  };
}
