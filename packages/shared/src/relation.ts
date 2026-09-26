import { z } from 'zod';
import { entityRefSchema, relationTypeSchema } from './entities.js';
import { confidenceSchema, evidenceLevelSchema } from './evidence.js';

/**
 * Where a relationship came from. Stored with every relation so any edge in
 * the graph can be traced back to the component and inputs that produced it.
 */
export const provenanceSchema = z.object({
  /** Component that produced the record, e.g. `git-indexer@0.1.0`. */
  producer: z.string().min(1),
  /** Algorithm or rule used, e.g. `commit-diff`, `import-resolution`. */
  method: z.string().min(1),
  /** IDs of rows in the `evidence` table that support this record. */
  evidenceIds: z.array(z.number().int().positive()).default([]),
  /** ISO-8601 timestamp of the observation. */
  observedAt: z.iso.datetime(),
  /** Free-form structured detail for debugging and display. */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type Provenance = z.infer<typeof provenanceSchema>;
export type ProvenanceInput = z.input<typeof provenanceSchema>;

/**
 * A relation between two entities, validated against the evidence rules:
 *
 * 1. FACT relations are direct observations and must have confidence 1.
 * 2. INFERRED relations must cite at least one evidence record.
 */
export const relationInputSchema = z
  .object({
    repositoryId: z.number().int().positive(),
    source: entityRefSchema,
    relation: relationTypeSchema,
    target: entityRefSchema,
    evidenceType: evidenceLevelSchema,
    confidence: confidenceSchema,
    provenance: provenanceSchema,
  })
  .superRefine((value, ctx) => {
    if (value.evidenceType === 'FACT' && value.confidence !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['confidence'],
        message: 'FACT relations are direct observations and must have confidence 1',
      });
    }
    if (value.evidenceType === 'INFERRED' && value.provenance.evidenceIds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['provenance', 'evidenceIds'],
        message: 'INFERRED relations must cite at least one evidence record',
      });
    }
  });
export type RelationInput = z.infer<typeof relationInputSchema>;
