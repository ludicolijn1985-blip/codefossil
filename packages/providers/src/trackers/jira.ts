import { z } from 'zod';
import { JsonClient, TrackerApiError, type TrackerClient, type TrackerIssue } from './http.js';

/** Issues fetched per search request. */
const BATCH = 50;
/** Keys are checked against this before they go into a JQL query. */
const KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6}$/;

const projectList = z.array(z.object({ key: z.string() }));

const issueFields = z.object({
  summary: z.string().nullish(),
  description: z.unknown().optional(),
  issuetype: z.object({ name: z.string() }).nullish(),
  status: z.object({ statusCategory: z.object({ key: z.string() }).nullish() }).nullish(),
  labels: z.array(z.string()).nullish(),
  created: z.string().nullish(),
  updated: z.string().nullish(),
  resolutiondate: z.string().nullish(),
});

const searchResult = z.object({
  issues: z.array(z.object({ key: z.string(), fields: issueFields })),
});

/** Jira's description: plain text (API v2) or an Atlassian document (v3); only text is kept. */
function plainText(description: unknown): string {
  if (typeof description === 'string') return description;
  const parts: string[] = [];
  const stack: unknown[] = [description];
  for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
    if (typeof node !== 'object' || node === null) continue;
    const { text, content } = node as { text?: unknown; content?: unknown };
    if (typeof text === 'string') parts.push(text);
    if (Array.isArray(content)) {
      const children: readonly unknown[] = content;
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  return parts.join(' ');
}

export interface JiraClientOptions {
  /** The site, e.g. `https://acme.atlassian.net` or a Jira Server URL. */
  readonly url: string;
  /** API token (Cloud, with `email`) or personal access token (Server/Data Center). */
  readonly token: string;
  /** Jira Cloud account email; without it the token is sent as a bearer token. */
  readonly email?: string | null;
  readonly maxRequests: number;
  readonly fetch?: typeof fetch;
}

/** Reads projects and issues from Jira's REST API. */
export class JiraClient implements TrackerClient {
  readonly provider = 'jira';
  private readonly http: JsonClient;
  private readonly site: string;

  constructor(options: JiraClientOptions) {
    const authorization = options.email
      ? `Basic ${Buffer.from(`${options.email}:${options.token}`).toString('base64')}`
      : `Bearer ${options.token}`;
    this.http = new JsonClient({
      baseUrl: options.url,
      authorization,
      maxRequests: options.maxRequests,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    this.site = options.url.replace(/\/+$/, '');
  }

  get requestsMade(): number {
    return this.http.requestsMade;
  }

  async projectKeys(): Promise<string[]> {
    return (await this.http.request(this.http.url('/rest/api/2/project'), projectList)).map(
      (project) => project.key,
    );
  }

  async issues(keys: readonly string[]): Promise<TrackerIssue[]> {
    const valid = keys.filter((key) => KEY.test(key));
    const found: TrackerIssue[] = [];
    for (let start = 0; start < valid.length; start += BATCH) {
      const batch = valid.slice(start, start + BATCH);
      const body = {
        jql: `key in (${batch.join(',')})`,
        fields: [
          'summary',
          'description',
          'issuetype',
          'status',
          'labels',
          'created',
          'updated',
          'resolutiondate',
        ],
        maxResults: BATCH,
      };
      let result: z.infer<typeof searchResult>;
      try {
        result = await this.http.request(this.http.url('/rest/api/2/search'), searchResult, {
          method: 'POST',
          body,
        });
      } catch (error) {
        // Jira Cloud retired the v2 search for /rest/api/3/search/jql.
        if (!(error instanceof TrackerApiError && (error.status === 404 || error.status === 410))) {
          throw error;
        }
        result = await this.http.request(this.http.url('/rest/api/3/search/jql'), searchResult, {
          method: 'POST',
          body,
        });
      }
      for (const issue of result.issues) {
        const { fields } = issue;
        const done = fields.status?.statusCategory?.key === 'done';
        found.push({
          key: issue.key,
          title: fields.summary ?? issue.key,
          body: plainText(fields.description),
          state: done ? 'closed' : 'open',
          url: `${this.site}/browse/${encodeURIComponent(issue.key)}`,
          labels: [
            ...(fields.labels ?? []),
            ...(fields.issuetype ? [`type:${fields.issuetype.name}`] : []),
          ],
          createdAt: fields.created ?? '',
          updatedAt: fields.updated ?? fields.created ?? '',
          closedAt: done ? (fields.resolutiondate ?? fields.updated ?? null) : null,
        });
      }
    }
    return found;
  }
}
