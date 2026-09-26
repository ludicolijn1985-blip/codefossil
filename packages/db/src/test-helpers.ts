import { IN_MEMORY, openDatabase, type FossilDatabase } from './client.js';
import * as schema from './schema.js';

/** A fresh, fully migrated in-memory database for a single test. */
export function openTestDatabase(): FossilDatabase {
  return openDatabase(IN_MEMORY);
}

/** Insert a minimal commit and file so relation tests have real rows to point at. */
export function seedCommitAndFile(
  fossil: FossilDatabase,
  repositoryId: number,
): { commitId: number; fileId: number } {
  const commit = fossil.db
    .insert(schema.commits)
    .values({
      repositoryId,
      sha: 'a'.repeat(40),
      authorName: 'Ada',
      authorEmail: 'ada@example.com',
      authoredAt: '2026-01-01T00:00:00.000Z',
      committedAt: '2026-01-01T00:00:00.000Z',
      subject: 'Add VAT calculation',
    })
    .returning()
    .get();
  const file = fossil.db
    .insert(schema.files)
    .values({ repositoryId, path: 'src/payment/vat.ts', language: 'typescript' })
    .returning()
    .get();
  return { commitId: commit.id, fileId: file.id };
}
