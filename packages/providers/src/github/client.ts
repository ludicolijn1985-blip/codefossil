import { z } from 'zod';

const USER_AGENT = 'codefossil/0.1.0';
const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = '100';

export class GitHubApiError extends Error {
  override readonly name = 'GitHubApiError';

  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** GitHub refused more requests for now; the sync can resume after `resetAt`. */
export class GitHubRateLimitError extends Error {
  override readonly name = 'GitHubRateLimitError';

  constructor(readonly resetAt: Date | null) {
    super(
      resetAt
        ? `GitHub rate limit reached; it resets at ${resetAt.toISOString()}`
        : 'GitHub rate limit reached',
    );
  }
}

/** The per-run request budget is spent; the sync resumes on the next run. */
export class RequestBudgetExhaustedError extends Error {
  override readonly name = 'RequestBudgetExhaustedError';
}

export interface GitHubClientOptions {
  readonly apiUrl: string;
  /** Null for unauthenticated access (public repositories, low rate limit). */
  readonly token: string | null;
  /** Maximum requests this client may make. */
  readonly maxRequests: number;
  /** Largest response body accepted, in bytes (default 20 MiB). */
  readonly maxResponseBytes?: number;
  readonly fetch?: typeof fetch;
}

export interface Page<T> {
  readonly items: T;
  readonly nextUrl: string | null;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate the API base URL. The token is sent with every request, so plain
 * HTTP is only allowed to the local machine (used by tests).
 */
export function validateApiUrl(apiUrl: string): URL {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new GitHubApiError(`Invalid GitHub API URL: ${apiUrl}`, null);
  }
  const local = url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== 'https:' && !local) {
    throw new GitHubApiError(`GitHub API URL must use https: ${apiUrl}`, null);
  }
  return url;
}

/** No legitimate page of 100 items comes close; anything larger is refused unread. */
const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/** Read a response body as text, failing once it exceeds `limit` bytes. */
async function readLimited(response: Response, limit: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel();
    throw new GitHubApiError(`GitHub response exceeds ${limit} bytes`, response.status);
  }
  if (!response.body) return '';
  // The Fetch standard yields bytes; Node's typings leave the chunk type open.
  const reader = (response.body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    size += next.value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new GitHubApiError(`GitHub response exceeds ${limit} bytes`, response.status);
    }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>\s*;\s*rel="next"/.exec(part);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** A small REST client: authentication, pagination, rate limits and a request budget. */
export class GitHubClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private made = 0;

  constructor(private readonly options: GitHubClientOptions) {
    this.base = validateApiUrl(options.apiUrl);
    this.fetchImpl = options.fetch ?? fetch;
  }

  get requestsMade(): number {
    return this.made;
  }

  /** GitHub's GraphQL API only answers authenticated requests. */
  get authenticated(): boolean {
    return this.options.token !== null && this.options.token !== '';
  }

  /**
   * Run a GraphQL query and validate its `data` with `schema`. GitHub
   * Enterprise serves GraphQL at `/api/graphql` next to the REST `/api/v3`.
   */
  async graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>>,
    schema: z.ZodType<T>,
  ): Promise<T> {
    const restPath = this.base.pathname.replace(/\/$/, '');
    const path = restPath.endsWith('/v3')
      ? `${restPath.slice(0, -3)}/graphql`
      : `${restPath}/graphql`;
    const url = new URL(path, this.base);
    const envelope = z.object({
      data: schema.nullable().optional(),
      errors: z.array(z.object({ type: z.string().optional(), message: z.string() })).optional(),
    });
    const { items } = await this.request(url, envelope, {
      method: 'POST',
      body: JSON.stringify({ query, variables }),
    });
    const errors = items.errors ?? [];
    if (errors.some((error) => error.type === 'RATE_LIMITED')) throw new GitHubRateLimitError(null);
    if (items.data === undefined || items.data === null) {
      throw new GitHubApiError(
        `GitHub GraphQL request failed: ${errors[0]?.message ?? 'no data returned'}`,
        null,
      );
    }
    return items.data;
  }

  /** GET `path` (relative to the API URL) and validate the JSON body with `schema`. */
  async get<T>(
    path: string,
    schema: z.ZodType<T>,
    query: Readonly<Record<string, string>> = {},
  ): Promise<Page<T>> {
    const url = new URL(`${this.base.pathname.replace(/\/$/, '')}${path}`, this.base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    return this.request(url, schema);
  }

  /** GET a page of a list endpoint (100 items per page). */
  getList<T>(
    path: string,
    item: z.ZodType<T>,
    query: Readonly<Record<string, string>> = {},
  ): Promise<Page<T[]>> {
    return this.get(path, z.array(item), { per_page: PAGE_SIZE, ...query });
  }

  /** Follow a `next` link from a previous page. */
  async getNext<T>(nextUrl: string, item: z.ZodType<T>): Promise<Page<T[]>> {
    const url = new URL(nextUrl);
    // Never send the token anywhere but the configured API host.
    if (url.origin !== this.base.origin) {
      throw new GitHubApiError(`Refusing to follow a pagination link to ${url.origin}`, null);
    }
    return await this.request(url, z.array(item));
  }

  private async request<T>(
    url: URL,
    schema: z.ZodType<T>,
    post?: { readonly method: 'POST'; readonly body: string },
  ): Promise<Page<T>> {
    if (this.made >= this.options.maxRequests) {
      throw new RequestBudgetExhaustedError(
        `Request budget of ${this.options.maxRequests} GitHub requests used`,
      );
    }
    this.made++;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': USER_AGENT,
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    if (post) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...(post ?? {}),
        headers,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new GitHubApiError(`Network error talking to ${url.origin}: ${reason}`, null);
    }

    if (!response.ok) throw this.failure(response, url);
    let body: unknown;
    try {
      const limit = this.options.maxResponseBytes ?? MAX_RESPONSE_BYTES;
      body = JSON.parse(await readLimited(response, limit));
    } catch (error) {
      if (error instanceof GitHubApiError) throw error;
      throw new GitHubApiError(`GitHub returned invalid JSON for ${url.pathname}`, response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new GitHubApiError(
        `Unexpected response shape from ${url.pathname}: ${parsed.error.issues[0]?.message ?? ''}`,
        response.status,
      );
    }
    return { items: parsed.data, nextUrl: nextLink(response.headers.get('link')) };
  }

  private failure(response: Response, url: URL): Error {
    const { status, headers } = response;
    if ((status === 403 || status === 429) && headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(headers.get('x-ratelimit-reset'));
      return new GitHubRateLimitError(
        Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null,
      );
    }
    const retryAfter = Number(headers.get('retry-after'));
    if ((status === 403 || status === 429) && Number.isFinite(retryAfter) && retryAfter > 0) {
      return new GitHubRateLimitError(new Date(Date.now() + retryAfter * 1000));
    }
    if (status === 401) {
      return new GitHubApiError('GitHub rejected the credentials (401). Check the token.', status);
    }
    if (status === 404) {
      return new GitHubApiError(
        `Not found: ${url.pathname}. The repository may be private or the token lacks access.`,
        status,
      );
    }
    return new GitHubApiError(`GitHub request to ${url.pathname} failed with ${status}`, status);
  }
}
