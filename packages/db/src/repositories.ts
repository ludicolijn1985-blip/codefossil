import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FossilDb } from './client.js';
import { repositories } from './schema.js';

export type RepositoryRow = typeof repositories.$inferSelect;

export const registerRepositoryInputSchema = z.object({
  /** Absolute path to the repository's working tree. */
  path: z.string().min(1),
  name: z.string().min(1),
  remoteUrl: z.string().min(1).nullable().default(null),
  defaultBranch: z.string().min(1).nullable().default(null),
});
export type RegisterRepositoryInput = z.input<typeof registerRepositoryInputSchema>;

/**
 * Register a repository, or update the metadata of one already registered at
 * the same path. Returns the stored row.
 */
export function registerRepository(db: FossilDb, input: RegisterRepositoryInput): RepositoryRow {
  const value = registerRepositoryInputSchema.parse(input);
  return db
    .insert(repositories)
    .values(value)
    .onConflictDoUpdate({
      target: repositories.path,
      set: { name: value.name, remoteUrl: value.remoteUrl, defaultBranch: value.defaultBranch },
    })
    .returning()
    .get();
}

export function findRepositoryByPath(db: FossilDb, path: string): RepositoryRow | undefined {
  return db.select().from(repositories).where(eq(repositories.path, path)).get();
}

export function listRepositories(db: FossilDb): RepositoryRow[] {
  return db.select().from(repositories).orderBy(repositories.name).all();
}

export function markRepositoryIndexed(
  db: FossilDb,
  repositoryId: number,
  indexedAt: Date,
): RepositoryRow | undefined {
  return db
    .update(repositories)
    .set({ indexedAt: indexedAt.toISOString() })
    .where(eq(repositories.id, repositoryId))
    .returning()
    .get();
}

export function findRepositoryById(db: FossilDb, id: number): RepositoryRow | undefined {
  return db.select().from(repositories).where(eq(repositories.id, id)).get();
}
