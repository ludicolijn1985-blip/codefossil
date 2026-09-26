import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { evidenceKindSchema } from '@codefossil/shared';
import type { FossilDb } from './client.js';
import { preparedFor } from './prepared.js';
import { evidence } from './schema.js';

export type EvidenceRow = typeof evidence.$inferSelect;

export const recordEvidenceInputSchema = z.object({
  repositoryId: z.number().int().positive(),
  type: evidenceKindSchema,
  /** Stable pointer into the source, e.g. a commit SHA or `path#L10-L20`. */
  locator: z.string().min(1),
  excerpt: z.string().nullable().default(null),
  metadata: z.record(z.string(), z.unknown()).nullable().default(null),
});
export type RecordEvidenceInput = z.input<typeof recordEvidenceInputSchema>;

/** Store a piece of raw evidence that relations and investigations can cite. */
export function recordEvidence(db: FossilDb, input: RecordEvidenceInput): EvidenceRow {
  const value = recordEvidenceInputSchema.parse(input);
  const row = statements(db).insert.get(value);
  return row;
}

/** Of the given evidence IDs, return those that do not exist in this repository. */
export function missingEvidenceIds(
  db: FossilDb,
  repositoryId: number,
  ids: readonly number[],
): number[] {
  const { exists } = statements(db);
  return [...new Set(ids)].filter((id) => exists.get({ id, repositoryId }) === undefined);
}

const statements = preparedFor((db) => ({
  insert: db
    .insert(evidence)
    .values({
      repositoryId: sql.placeholder('repositoryId'),
      type: sql.placeholder('type'),
      locator: sql.placeholder('locator'),
      excerpt: sql.placeholder('excerpt'),
      metadataJson: sql.placeholder('metadata'),
    })
    .returning()
    .prepare(),
  exists: db
    .select({ id: evidence.id })
    .from(evidence)
    .where(
      and(
        eq(evidence.id, sql.placeholder('id')),
        eq(evidence.repositoryId, sql.placeholder('repositoryId')),
      ),
    )
    .prepare(),
}));
