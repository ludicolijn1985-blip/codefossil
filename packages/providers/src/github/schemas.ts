import { z } from 'zod';

/** GitHub timestamps, normalized to the ISO form used everywhere in the index. */
const timestamp = z.iso
  .datetime({ offset: true })
  .transform((value) => new Date(value).toISOString());

const user = z.object({ login: z.string() }).nullable();

/** An item of `GET /repos/{owner}/{repo}/issues`; pull requests appear here too. */
export const issueItemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.enum(['open', 'closed']),
  html_url: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
  closed_at: timestamp.nullable(),
  user,
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).default([]),
  pull_request: z.object({ merged_at: timestamp.nullish() }).optional(),
});
export type IssueItem = z.infer<typeof issueItemSchema>;

/** `GET /repos/{owner}/{repo}/pulls/{number}` */
export const pullDetailSchema = z.object({
  number: z.number().int().positive(),
  merged_at: timestamp.nullable(),
  merge_commit_sha: z.string().nullable(),
  base: z.object({ ref: z.string() }),
  head: z.object({ ref: z.string() }),
});
export type PullDetail = z.infer<typeof pullDetailSchema>;

/** An item of `GET /repos/{owner}/{repo}/pulls/{number}/commits` */
export const pullCommitSchema = z.object({ sha: z.string().regex(/^[0-9a-f]{40,64}$/) });

/** An item of `GET /repos/{owner}/{repo}/pulls/{number}/reviews` */
export const reviewSchema = z.object({
  id: z.number().int(),
  user,
  body: z.string().nullish(),
  state: z.string(),
  // Pending reviews have no submission time and are skipped.
  submitted_at: timestamp.nullish(),
});
export type Review = z.infer<typeof reviewSchema>;

/** `GET /repos/{owner}/{repo}` */
export const repositorySchema = z.object({
  full_name: z.string(),
  private: z.boolean(),
  default_branch: z.string(),
});

export const labelNames = (labels: IssueItem['labels']): string[] =>
  labels.map((label) => (typeof label === 'string' ? label : label.name));
