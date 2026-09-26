import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type FossilDb = BetterSQLite3Database<typeof schema>;

export interface FossilDatabase {
  readonly db: FossilDb;
  readonly sqlite: Database.Database;
  close(): void;
}

/** Special path that opens a throwaway in-memory database (used by tests). */
export const IN_MEMORY = ':memory:';

/** SQL migrations live next to `src/` and `dist/`, so one relative URL works for both. */
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../drizzle', import.meta.url));

/**
 * Open (or create) a CODEFOSSIL database and bring its schema up to date.
 *
 * Foreign keys are always enforced. File-backed databases use WAL so the API
 * can read while the indexer writes.
 */
export function openDatabase(path: string): FossilDatabase {
  const sqlite = new Database(path);
  try {
    sqlite.pragma('foreign_keys = ON');
    if (path !== IN_MEMORY) {
      sqlite.pragma('journal_mode = WAL');
      sqlite.pragma('busy_timeout = 5000');
    }
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
    return {
      db,
      sqlite,
      close: () => {
        sqlite.close();
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
