import { z } from 'zod';
import type { HostedPullRequest, PullRequestHostClient } from '../hosted.js';
import { remoteParts } from '../hosted.js';
import { JsonClient, TrackerApiError } from '../trackers/http.js';

/** Bitbucket Cloud's REST API. Bitbucket Server and Data Center have another API. */
export const BITBUCKET_API_URL = 'https://api.bitbucket.org/2.0';
/** Items per page, Bitbucket's maximum for pull requests. */
const PAGE_SIZE = 50;
/** Pages read per list per sync; the sync resumes from its cursor next time. */
const MAX_PAGES = 50;

const page = <T extends z.ZodType>(item: T) =>
  z.object({ values: z.array(item), next: z.string().nullish() });

const pullRequestSchema = z.object({
  id: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  author: z.object({ display_name: z.string().nullish() }).nullish(),
  created_on: z.string(),
  updated_on: z.string(),
  merge_commit: z.object({ hash: z.string().regex(/^[0-9a-f]{12,64}$/) }).nullish(),
  source: z.object({ branch: z.object({ name: z.string() }).nullish() }),
  destination: z.object({ branch: z.object({ name: z.string() }).nullish() }),
});
type BitbucketPullRequest = z.infer<typeof pullRequestSchema>;

const commitSchema = z.object({ hash: z.string().regex(/^[0-9a-f]{40,64}$/) });

const STATES = ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] as const;

export interface BitbucketClientOptions {
  readonly apiUrl?: string;
  readonly workspace: string;
  readonly repository: string;
  /** An `Authorization` header value (Bearer access token, or Basic email:API token); null for public repositories. */
  readonly authorization: string | null;
  readonly maxRequests: number;
  readonly fetch?: typeof fetch;
}

function toHosted(pr: BitbucketPullRequest, ref: BitbucketRepositoryRef): HostedPullRequest {
  const merged = pr.state === 'MERGED';
  return {
    number: pr.id,
    title: pr.title,
    body: pr.description ?? '',
    state: merged ? 'merged' : pr.state === 'OPEN' ? 'open' : 'closed',
    // Built here, not taken from the response: a stored link is never what a host claims.
    url: `https://bitbucket.org/${encodeURIComponent(ref.workspace)}/${encodeURIComponent(ref.repository)}/pull-requests/${String(pr.id)}`,
    author: pr.author?.display_name ?? null,
    labels: [],
    createdAt: pr.created_on,
    updatedAt: pr.updated_on,
    // Bitbucket records no close or merge time; the sync dates a merge by its commit.
    closedAt: null,
    mergedAt: null,
    mergeCommitSha: merged ? (pr.merge_commit?.hash ?? null) : null,
    baseBranch: pr.destination.branch?.name ?? '',
    headBranch: pr.source.branch?.name ?? '',
  };
}

/** A `next` link as a URL; one that is not is an API error, not a crash. */
function nextPage(link: string): URL {
  try {
    return new URL(link);
  } catch {
    throw new TrackerApiError('Invalid next page link from Bitbucket', null);
  }
}

/** Reads a Bitbucket Cloud repository's pull requests (REST API 2.0). */
export class BitbucketClient implements PullRequestHostClient {
  readonly provider = 'bitbucket';
  readonly listsAllUpdates = true;
  private readonly http: JsonClient;

  constructor(private readonly options: BitbucketClientOptions) {
    this.http = new JsonClient({
      baseUrl: options.apiUrl ?? BITBUCKET_API_URL,
      authorization: options.authorization,
      maxRequests: options.maxRequests,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  private get ref(): BitbucketRepositoryRef {
    return { workspace: this.options.workspace, repository: this.options.repository };
  }

  get requestsMade(): number {
    return this.http.requestsMade;
  }

  private path(rest = ''): string {
    const { workspace, repository } = this.options;
    return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repository)}${rest}`;
  }

  /** Every item of a paged list, following `next` links on the same origin only. */
  private async list<T>(first: URL, item: z.ZodType<T>): Promise<T[]> {
    const items: T[] = [];
    let url: URL | null = first;
    for (let pages = 0; url && pages < MAX_PAGES; pages++) {
      const body: { values: T[]; next?: string | null | undefined } = await this.http.request(
        url,
        page(item),
      );
      items.push(...body.values);
      url = body.next ? nextPage(body.next) : null;
    }
    return items;
  }

  async verify(): Promise<void> {
    await this.http.request(this.http.url(this.path()), z.object({ full_name: z.string() }));
  }

  async pullRequests(
    cursor: string | null,
  ): Promise<{ items: HostedPullRequest[]; cursor: string | null }> {
    const url = this.http.url(this.path('/pullrequests'));
    for (const state of STATES) url.searchParams.append('state', state);
    url.searchParams.set('sort', 'updated_on');
    url.searchParams.set('pagelen', String(PAGE_SIZE));
    // The cursor is a timestamp Bitbucket gave; anything else is not sent.
    if (cursor && /^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/.test(cursor)) {
      url.searchParams.set('q', `updated_on >= ${cursor}`);
    }
    const items = (await this.list(url, pullRequestSchema)).map((pr) => toHosted(pr, this.ref));
    return { items, cursor: items.at(-1)?.updatedAt ?? cursor };
  }

  async pullRequest(number: number): Promise<HostedPullRequest> {
    return toHosted(
      await this.http.request(
        this.http.url(this.path(`/pullrequests/${String(number)}`)),
        pullRequestSchema,
      ),
      this.ref,
    );
  }

  async commits(number: number): Promise<string[]> {
    try {
      const commits = await this.list(
        this.http.url(this.path(`/pullrequests/${String(number)}/commits`)),
        commitSchema,
      );
      return commits.map((c) => c.hash);
    } catch (error) {
      // A pull request whose source branch or fork is gone has no commit list.
      if (error instanceof TrackerApiError && error.status === 404) return [];
      throw error;
    }
  }

  workItems(): Promise<[]> {
    return Promise.resolve([]);
  }
}

/** A Bitbucket Cloud repository a remote points at. */
export interface BitbucketRepositoryRef {
  readonly workspace: string;
  readonly repository: string;
}

const SLUG = /^[A-Za-z0-9_.-]+$/;

/** Parse a bitbucket.org remote: `https://user@bitbucket.org/ws/repo.git`, `git@bitbucket.org:ws/repo.git`. */
export function parseBitbucketRemote(remote: string): BitbucketRepositoryRef | null {
  const parts = remoteParts(remote);
  if (parts?.host !== 'bitbucket.org') return null;
  return parseBitbucketSlug(parts.path.replace(/\.git\/?$/, '').replace(/\/+$/, ''));
}

/** Parse `workspace/repository`. */
export function parseBitbucketSlug(slug: string): BitbucketRepositoryRef | null {
  const [workspace, repository, ...rest] = slug.split('/');
  if (!workspace || !repository || rest.length > 0) return null;
  const valid = (part: string) => SLUG.test(part) && part !== '.' && part !== '..';
  if (!valid(workspace) || !valid(repository)) return null;
  return { workspace, repository };
}
