import { z } from 'zod';
import { GitHubApiError, readLimited, validateApiUrl } from '../github/client.js';

const USER_AGENT = 'codefossil';
const REQUEST_TIMEOUT_MS = 30_000;
/** No legitimate answer comes close; anything larger is refused unread. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export class TrackerApiError extends Error {
  override readonly name = 'TrackerApiError';

  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
  }
}

/** The tracker refused more requests for now, or this run's request budget is spent. */
export class TrackerLimitError extends Error {
  override readonly name = 'TrackerLimitError';
}

export interface JsonClientOptions {
  readonly baseUrl: string;
  /** Header sent with every request to the base URL's origin, never elsewhere. */
  readonly authorization: string | null;
  readonly maxRequests: number;
  readonly fetch?: typeof fetch;
}

/**
 * A small JSON client for issue trackers: https only (plain HTTP to the local
 * machine for tests), credentials only to the configured origin, a timeout,
 * a response size cap and a request budget. Responses are validated with Zod
 * and stay data: tracker text is never interpreted.
 */
export class JsonClient {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private made = 0;

  constructor(private readonly options: JsonClientOptions) {
    this.base = validateApiUrl(options.baseUrl);
    this.fetchImpl = options.fetch ?? fetch;
  }

  get requestsMade(): number {
    return this.made;
  }

  /** A path joined to the base URL's path. */
  url(path: string): URL {
    return new URL(`${this.base.pathname.replace(/\/$/, '')}${path}`, this.base);
  }

  async request<T>(
    url: URL,
    schema: z.ZodType<T>,
    init: { readonly method?: 'GET' | 'POST'; readonly body?: unknown } = {},
  ): Promise<T> {
    if (url.origin !== this.base.origin) {
      throw new TrackerApiError(`Refusing to send credentials to ${url.origin}`, null);
    }
    if (this.made >= this.options.maxRequests) {
      throw new TrackerLimitError(`Request budget of ${String(this.options.maxRequests)} used`);
    }
    this.made++;
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'User-Agent': USER_AGENT,
    };
    if (this.options.authorization) headers.Authorization = this.options.authorization;
    if (init.body !== undefined) headers['Content-Type'] = 'application/json';

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: init.method ?? 'GET',
        headers,
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new TrackerApiError(`Network error talking to ${url.origin}: ${reason}`, null);
    }
    if (response.status === 429) {
      throw new TrackerLimitError(`${url.origin} is rate limiting requests`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TrackerApiError(
        response.status === 401 || response.status === 403
          ? `${url.origin} rejected the credentials (${String(response.status)})`
          : `Request to ${url.pathname} failed with ${String(response.status)}`,
        response.status,
      );
    }
    let text: string;
    try {
      // Streams the body and stops reading once it exceeds the cap, declared length or not.
      text = await readLimited(response, MAX_RESPONSE_BYTES);
    } catch (error) {
      if (error instanceof GitHubApiError) {
        throw new TrackerApiError(`Response from ${url.pathname} is too large`, response.status);
      }
      throw error;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new TrackerApiError(`Invalid JSON from ${url.pathname}`, response.status);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new TrackerApiError(
        `Unexpected response shape from ${url.pathname}: ${parsed.error.issues[0]?.message ?? ''}`,
        response.status,
      );
    }
    return parsed.data;
  }
}

/** An issue in Jira or Linear, as stored: its key, text, state and labels. */
export interface TrackerIssue {
  /** `PROJ-123` (Jira) or `ENG-123` (Linear). */
  readonly key: string;
  readonly title: string;
  readonly body: string;
  /** `open` or `closed` (done or canceled). */
  readonly state: 'open' | 'closed';
  readonly url: string;
  /** The tracker's labels plus `type:<issue type>` (Jira) when known. */
  readonly labels: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

/** What a tracker offers the sync: its project (team) keys, and issues by key. */
export interface TrackerClient {
  readonly provider: 'jira' | 'linear';
  readonly requestsMade: number;
  /** Keys of the projects (Jira) or teams (Linear) visible with the credentials. */
  projectKeys(): Promise<string[]>;
  /** The issues with these keys that exist and are visible; others are left out. */
  issues(keys: readonly string[]): Promise<TrackerIssue[]>;
}

/** `PROJ-123`: a project key (2–10 capitals and digits, starting with a capital) and a number. */
export const TRACKER_KEY = /\b([A-Z][A-Z0-9]{1,9})-([1-9]\d{0,6})\b/g;

/** Every tracker key in a text, whose project is one of `projects`. */
export function trackerKeys(text: string, projects: ReadonlySet<string>): string[] {
  const found = new Set<string>();
  for (const [key = '', project = ''] of text.matchAll(TRACKER_KEY)) {
    if (projects.has(project)) found.add(key);
  }
  return [...found];
}

export const isoDate = z.string().min(1);
