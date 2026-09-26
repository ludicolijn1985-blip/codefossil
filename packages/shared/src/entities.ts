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
