import { z } from 'zod';

/** Every node type that can appear on either side of a relation. */
export const ENTITY_TYPES = [
  'repository',
  'commit',
  'file',
  'symbol',
  'issue',
  'pull_request',
  'review',
  'test',
  'dependency',
  'incident',
] as const;
export const entityTypeSchema = z.enum(ENTITY_TYPES);
export type EntityType = z.infer<typeof entityTypeSchema>;

/** Typed edges in the evidence graph. */
export const RELATION_TYPES = [
  'PARENT_OF',
  'MODIFIES',
  'CONTAINS',
  'IMPORTS',
  'CALLS',
  'TESTED_BY',
  'DEPENDS_ON',
  'RESOLVED_BY',
  'IMPLEMENTED_BY',
  'REFERENCES',
  'INTRODUCED_BY',
  /**
   * symbol → symbol: lineage. The symbol continues an earlier one: identical
   * content in another file (a copy or a move), the same code under a new name
   * (a rename), or the same name moved with edits (INFERRED). The provenance
   * method says which.
   */
  'COPIED_FROM',
  'REVIEWED_IN',
  'CAUSED',
  'FIXED_BY',
] as const;
export const relationTypeSchema = z.enum(RELATION_TYPES);
export type RelationType = z.infer<typeof relationTypeSchema>;

export const entityRefSchema = z.object({
  type: entityTypeSchema,
  id: z.number().int().positive(),
});
export type EntityRef = z.infer<typeof entityRefSchema>;

/**
 * How an issue or pull request is written: `#12` in the indexed repository,
 * `owner/name#12` in another one.
 */
export function issueReference(item: {
  readonly number: number | string;
  readonly repo?: string | null;
}): string {
  return `${item.repo ? item.repo : ''}#${String(item.number)}`;
}

/**
 * Provenance method of an `issue RESOLVED_BY` link that GitHub itself records
 * (a pull request's closing issue references), as opposed to one read from a
 * closing keyword in text.
 */
export const GITHUB_CLOSING_METHOD = 'github-closing-reference';

/** How a resolution link was established, for answers that cite it. */
export function resolutionBasis(method: string, confidence: number): string {
  return method === GITHUB_CLOSING_METHOD
    ? 'linked as closing on GitHub'
    : `closing keyword; confidence ${confidence.toFixed(2)}`;
}
