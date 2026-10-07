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
  // A tracker key (`PROJ-123`) is written as it is.
  if (typeof item.number === 'string' && !/^\d+$/.test(item.number)) return item.number;
  return `${item.repo ? item.repo : ''}#${String(item.number)}`;
}

/**
 * Provenance method of an `issue RESOLVED_BY` link that GitHub itself records
 * (a pull request's closing issue references), as opposed to one read from a
 * closing keyword in text.
 */
export const GITHUB_CLOSING_METHOD = 'github-closing-reference';
/** The same for GitLab: the issues a merge request closes (`closes_issues`). */
export const GITLAB_CLOSING_METHOD = 'gitlab-closes-issues';
/**
 * A work item linked to an Azure Repos pull request that was completed while
 * the work item is closed: recorded links, but resolution is a reading.
 */
export const AZURE_WORK_ITEM_METHOD = 'azure-linked-work-item';

/** How a resolution link was established, for answers that cite it. */
export function resolutionBasis(method: string, confidence: number): string {
  if (method === GITHUB_CLOSING_METHOD) return 'linked as closing on GitHub';
  if (method === GITLAB_CLOSING_METHOD) return 'linked as closing on GitLab';
  if (method === AZURE_WORK_ITEM_METHOD) {
    return `work item linked on Azure DevOps and closed; confidence ${confidence.toFixed(2)}`;
  }
  return `closing keyword; confidence ${confidence.toFixed(2)}`;
}

/** How a symbol continues an earlier one, by the provenance method of its `COPIED_FROM` link. */
export type LineageKind = 'copied' | 'renamed' | 'moved';

export function lineageKind(method: string): LineageKind {
  return method === 'renamed' ? 'renamed' : method === 'moved-with-edits' ? 'moved' : 'copied';
}

/**
 * How a pull or merge request is written: `PR #12` on GitHub and Bitbucket,
 * `MR !12` on GitLab, `PR !12` on Azure Repos; in running text (`long`)
 * `pull request #12`, `merge request !12`.
 */
export function pullRequestReference(
  item: { readonly number: number | string; readonly provider?: string },
  options: { readonly long?: boolean } = {},
): string {
  const gitlab = item.provider === 'gitlab';
  const noun = options.long ? (gitlab ? 'merge request' : 'pull request') : gitlab ? 'MR' : 'PR';
  const bang = gitlab || item.provider === 'azure';
  return `${noun} ${bang ? '!' : '#'}${String(item.number)}`;
}
