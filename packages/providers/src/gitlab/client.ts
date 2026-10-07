import { z } from 'zod';
import { JsonClient } from '../trackers/http.js';

/** Items per page, GitLab's maximum. */
const PAGE_SIZE = 100;
/** Pages read per list per sync; the sync resumes from its cursor next time. */
const MAX_PAGES = 50;

const user = z.object({ username: z.string() }).nullish();

export const gitlabIssueSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  web_url: z.string(),
  author: user,
  labels: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
});
export type GitLabIssue = z.infer<typeof gitlabIssueSchema>;

export const gitlabMergeRequestSchema = z.object({
  iid: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullish(),
  state: z.string(),
  web_url: z.string(),
  author: user,
  labels: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullish(),
  merged_at: z.string().nullish(),
  merge_commit_sha: z.string().nullish(),
  squash_commit_sha: z.string().nullish(),
  source_branch: z.string(),
  target_branch: z.string(),
});
export type GitLabMergeRequest = z.infer<typeof gitlabMergeRequestSchema>;

const commitSchema = z.object({ id: z.string().regex(/^[0-9a-f]{40,64}$/) });
const closedIssueSchema = z.object({ iid: z.number().int().positive(), project_id: z.number() });
const projectSchema = z.object({ id: z.number(), path_with_namespace: z.string() });

export interface GitLabClientOptions {
  /** API base, e.g. `https://gitlab.com/api/v4`. */
  readonly apiUrl: string;
  /** A personal or project access token; null for public projects. */
  readonly token: string | null;
  readonly maxRequests: number;
  readonly fetch?: typeof fetch;
}

/** Reads a project's issues and merge requests from GitLab's REST API (v4). */
export class GitLabClient {
  private readonly http: JsonClient;

  constructor(options: GitLabClientOptions) {
    this.http = new JsonClient({
      baseUrl: options.apiUrl,
      authorization: options.token ? `Bearer ${options.token}` : null,
      maxRequests: options.maxRequests,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  get requestsMade(): number {
    return this.http.requestsMade;
  }

  private projectPath(project: string, rest = ''): string {
    return `/projects/${encodeURIComponent(project)}${rest}`;
  }

  /** The project by its path (`group/sub/name`): its numeric id. */
  async project(path: string): Promise<z.infer<typeof projectSchema>> {
    return this.http.request(this.http.url(this.projectPath(path)), projectSchema);
  }

  private async list<T>(
    path: string,
    item: z.ZodType<T>,
    query: Readonly<Record<string, string>>,
  ): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = this.http.url(path);
      for (const [key, value] of Object.entries({
        ...query,
        per_page: String(PAGE_SIZE),
        page: String(page),
      })) {
        url.searchParams.set(key, value);
      }
      const batch = await this.http.request(url, z.array(item));
      items.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return items;
  }

  /** Issues updated at or after `since` (all when null), oldest update first. */
  issues(project: string, since: string | null): Promise<GitLabIssue[]> {
    return this.list(this.projectPath(project, '/issues'), gitlabIssueSchema, {
      scope: 'all',
      state: 'all',
      order_by: 'updated_at',
      sort: 'asc',
      ...(since ? { updated_after: since } : {}),
    });
  }

  /** Merge requests updated at or after `since` (all when null), oldest update first. */
  mergeRequests(project: string, since: string | null): Promise<GitLabMergeRequest[]> {
    return this.list(this.projectPath(project, '/merge_requests'), gitlabMergeRequestSchema, {
      scope: 'all',
      state: 'all',
      order_by: 'updated_at',
      sort: 'asc',
      ...(since ? { updated_after: since } : {}),
    });
  }

  /** One merge request by its number (iid). */
  mergeRequest(project: string, iid: number): Promise<GitLabMergeRequest> {
    return this.http.request(
      this.http.url(this.projectPath(project, `/merge_requests/${String(iid)}`)),
      gitlabMergeRequestSchema,
    );
  }

  /** Shas of a merge request's commits. */
  async mergeRequestCommits(project: string, iid: number): Promise<string[]> {
    const commits = await this.list(
      this.projectPath(project, `/merge_requests/${String(iid)}/commits`),
      commitSchema,
      {},
    );
    return commits.map((commit) => commit.id);
  }

  /** The issues GitLab records as closed by a merge request, with their project ids. */
  closesIssues(project: string, iid: number): Promise<z.infer<typeof closedIssueSchema>[]> {
    return this.list(
      this.projectPath(project, `/merge_requests/${String(iid)}/closes_issues`),
      closedIssueSchema,
      {},
    );
  }
}

/** A GitLab project a Git remote points at. */
export interface GitLabProjectRef {
  readonly host: string;
  /** `group/sub/name`. */
  readonly path: string;
}

const PATH_PART = /^[A-Za-z0-9_.-]+$/;

/**
 * Parse a remote of a GitLab project, which may sit in nested groups:
 * `https://gitlab.com/group/sub/name.git`, `git@gitlab.example.com:group/name.git`.
 */
export function parseGitLabRemote(remote: string): GitLabProjectRef | null {
  const scp = /^[\w.-]+@([\w.-]+):(.+?)(?:\.git)?\/?$/.exec(remote);
  let host: string | undefined;
  let path: string | undefined;
  if (scp) {
    [, host, path] = scp;
  } else {
    try {
      const url = new URL(remote);
      if (!['https:', 'http:', 'ssh:'].includes(url.protocol)) return null;
      host = url.hostname;
      path = url.pathname
        .replace(/^\/+/, '')
        .replace(/\.git\/?$/, '')
        .replace(/\/+$/, '');
    } catch {
      return null;
    }
  }
  return host && path ? parseGitLabPath(path, host) : null;
}

/** Parse `group/sub/name` (at least two parts, GitLab's path characters only). */
export function parseGitLabPath(path: string, host = 'gitlab.com'): GitLabProjectRef | null {
  const parts = path.split('/');
  if (parts.length < 2 || parts.length > 20 || !parts.every((part) => PATH_PART.test(part))) {
    return null;
  }
  return { host: host.toLowerCase(), path: parts.join('/') };
}

/** REST API base URL of a GitLab host. */
export const gitlabApiUrl = (host: string): string => `https://${host}/api/v4`;
