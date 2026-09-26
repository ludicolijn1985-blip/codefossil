import { z } from 'zod';

/**
 * How a record came to be known.
 *
 * - FACT: directly observed from a source (a commit, a parsed AST node, an API record).
 * - DERIVED: computed deterministically from facts.
 * - INFERRED: produced by a heuristic or AI model. Never presented as certain.
 */
export const EVIDENCE_LEVELS = ['FACT', 'DERIVED', 'INFERRED'] as const;
export const evidenceLevelSchema = z.enum(EVIDENCE_LEVELS);
export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;

/** Confidence is a probability-like score in [0, 1]. */
export const confidenceSchema = z.number().min(0).max(1);
export type Confidence = z.infer<typeof confidenceSchema>;

/** Kinds of raw evidence that can be cited by relations and investigations. */
export const EVIDENCE_KINDS = [
  'commit',
  'file_change',
  'ast_node',
  'issue',
  'pull_request',
  'review',
  'incident',
  'manifest',
  'test',
] as const;
export const evidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;
