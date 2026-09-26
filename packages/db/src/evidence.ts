import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { evidenceKindSchema } from '@codefossil/shared';
import type { FossilDb } from './client.js';
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
  return db
    .insert(evidence)
    .values({
      repositoryId: value.repositoryId,
      type: value.type,
      locator: value.locator,
      excerpt: value.excerpt,
      metadataJson: value.metadata,
    })
    .returning()
    .get();
}

/** Of the given evidence IDs, return those that do not exist in this repository. */
export function missingEvidenceIds(
  db: FossilDb,
  repositoryId: number,
  ids: readonly number[],
): number[] {
  if (ids.length === 0) return [];
  const found = new Set(
    db
      .select({ id: evidence.id })
      .from(evidence)
      .where(and(eq(evidence.repositoryId, repositoryId), inArray(evidence.id, [...ids])))
      .all()
      .map((row) => row.id),
  );
  return [...new Set(ids)].filter((id) => !found.has(id));
}
