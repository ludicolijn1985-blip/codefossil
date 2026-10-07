import { z } from 'zod';
import { JsonClient, TrackerApiError, type TrackerClient, type TrackerIssue } from './http.js';

export const LINEAR_API_URL = 'https://api.linear.app/graphql';

/** Issues asked for in one GraphQL query. */
const BATCH = 50;
const KEY = /^[A-Z][A-Z0-9]{1,9}-[1-9]\d{0,6}$/;

const graphql = <T extends z.ZodType>(data: T) =>
  z.object({
    data: data.nullish(),
    errors: z.array(z.object({ message: z.string() })).optional(),
  });

const teams = z.object({
  teams: z.object({ nodes: z.array(z.object({ key: z.string() })) }),
});

const linearIssue = z
  .object({
    identifier: z.string(),
    title: z.string(),
    description: z.string().nullish(),
    url: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().nullish(),
    canceledAt: z.string().nullish(),
    state: z.object({ type: z.string() }).nullish(),
    labels: z.object({ nodes: z.array(z.object({ name: z.string() })) }).nullish(),
  })
  .nullable();

export interface LinearClientOptions {
  /** A personal API key (`lin_api_…`). */
  readonly apiKey: string;
  readonly url?: string;
  readonly maxRequests: number;
  readonly fetch?: typeof fetch;
}

/** Reads teams and issues from Linear's GraphQL API. */
export class LinearClient implements TrackerClient {
  readonly provider = 'linear';
  private readonly http: JsonClient;

  constructor(options: LinearClientOptions) {
    this.http = new JsonClient({
      baseUrl: options.url ?? LINEAR_API_URL,
      authorization: options.apiKey,
      maxRequests: options.maxRequests,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  get requestsMade(): number {
    return this.http.requestsMade;
  }

  private async query<T extends z.ZodType>(
    query: string,
    variables: Record<string, unknown>,
    shape: T,
  ): Promise<z.infer<T>> {
    const result = await this.http.request(this.http.url(''), graphql(shape), {
      method: 'POST',
      body: { query, variables },
    });
    if (result.data === undefined || result.data === null) {
      throw new TrackerApiError(
        `Linear query failed: ${result.errors?.[0]?.message ?? 'no data returned'}`,
        null,
      );
    }
    return result.data;
  }

  async projectKeys(): Promise<string[]> {
    const data = await this.query('query { teams(first: 250) { nodes { key } } }', {}, teams);
    return data.teams.nodes.map((team) => team.key);
  }

  async issues(keys: readonly string[]): Promise<TrackerIssue[]> {
    const valid = keys.filter((key) => KEY.test(key));
    const found: TrackerIssue[] = [];
    for (let start = 0; start < valid.length; start += BATCH) {
      const batch = valid.slice(start, start + BATCH);
      const fields =
        'identifier title description url createdAt updatedAt completedAt canceledAt state { type } labels { nodes { name } }';
      const query = `query(${batch.map((_, i) => `$k${String(i)}: String!`).join(', ')}) { ${batch
        .map((_, i) => `i${String(i)}: issue(id: $k${String(i)}) { ${fields} }`)
        .join(' ')} }`;
      const variables = Object.fromEntries(batch.map((key, i) => [`k${String(i)}`, key]));
      // A key that names no visible issue makes Linear report an error for that alias only.
      const result = await this.http.request(
        this.http.url(''),
        graphql(z.record(z.string(), linearIssue)),
        { method: 'POST', body: { query, variables } },
      );
      for (const issue of Object.values(result.data ?? {})) {
        if (!issue) continue;
        const done = issue.state?.type === 'completed' || issue.state?.type === 'canceled';
        found.push({
          key: issue.identifier,
          title: issue.title,
          body: issue.description ?? '',
          state: done ? 'closed' : 'open',
          url: issue.url,
          labels: issue.labels?.nodes.map((label) => label.name) ?? [],
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
          closedAt: issue.completedAt ?? issue.canceledAt ?? null,
        });
      }
    }
    return found;
  }
}
