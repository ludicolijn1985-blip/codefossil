import { z } from 'zod';
import type { HostedPullRequest, HostedWorkItem, PullRequestHostClient } from '../hosted.js';
import { remoteParts } from '../hosted.js';
import { JsonClient } from '../trackers/http.js';

const API_VERSION = '7.1';
/** Pull requests per page. */
const PAGE_SIZE = 100;
/** Pages read per sync; the sync resumes from its cursor next time. */
const MAX_PAGES = 50;
/** Work items per batch request, Azure's maximum. */
const WORK_ITEM_BATCH = 200;
/** Work item states that mean the work is over. */
const CLOSED_STATES = new Set(['closed', 'done', 'resolved', 'removed', 'completed']);

const pullRequestSchema = z.object({
  pullRequestId: z.number().int().positive(),
  title: z.string(),
  description: z.string().nullish(),
  status: z.string(),
  createdBy: z.object({ displayName: z.string().nullish() }).nullish(),
  creationDate: z.string(),
  closedDate: z.string().nullish(),
  lastMergeCommit: z.object({ commitId: z.string().regex(/^[0-9a-f]{40,64}$/) }).nullish(),
  sourceRefName: z.string(),
  targetRefName: z.string(),
  labels: z.array(z.object({ name: z.string() })).nullish(),
});
type AzurePullRequest = z.infer<typeof pullRequestSchema>;

const list = <T extends z.ZodType>(item: T) => z.object({ value: z.array(item) });

const workItemSchema = z.object({
  id: z.number().int().positive(),
  fields: z.object({
    'System.Title': z.string(),
    'System.State': z.string(),
    'System.WorkItemType': z.string(),
    'System.CreatedDate': z.string(),
    'System.ChangedDate': z.string(),
    'System.Description': z.string().nullish(),
    'System.Tags': z.string().nullish(),
    'System.CreatedBy': z.object({ displayName: z.string().nullish() }).nullish(),
    'Microsoft.VSTS.Common.ClosedDate': z.string().nullish(),
  }),
});

export interface AzureDevOpsClientOptions {
  /** The organisation's URL, e.g. `https://dev.azure.com/acme`. */
  readonly apiUrl: string;
  readonly project: string;
  readonly repository: string;
  /** A personal access token, sent as Basic auth; null for public projects. */
  readonly token: string | null;
  readonly maxRequests: number;
  readonly fetch?: typeof fetch;
}

const branch = (ref: string) => ref.replace(/^refs\/heads\//, '');

/** Reads an Azure Repos repository's pull requests and their linked work items. */
export class AzureDevOpsClient implements PullRequestHostClient {
  readonly provider = 'azure';
  readonly listsAllUpdates = false;
  private readonly http: JsonClient;

  constructor(private readonly options: AzureDevOpsClientOptions) {
    this.http = new JsonClient({
      baseUrl: options.apiUrl,
      authorization: options.token
        ? `Basic ${Buffer.from(`:${options.token}`).toString('base64')}`
        : null,
      maxRequests: options.maxRequests,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  }

  get requestsMade(): number {
    return this.http.requestsMade;
  }

  private url(rest: string, query: Readonly<Record<string, string>> = {}): URL {
    const url = this.http.url(`/${encodeURIComponent(this.options.project)}/_apis${rest}`);
    for (const [key, value] of Object.entries({ ...query, 'api-version': API_VERSION })) {
      url.searchParams.set(key, value);
    }
    return url;
  }

  private repositoryPath(rest = ''): string {
    return `/git/repositories/${encodeURIComponent(this.options.repository)}${rest}`;
  }

  /** The page a person opens, under the organisation URL. */
  private webUrl(rest: string): string {
    const base = this.options.apiUrl.replace(/\/+$/, '');
    return `${base}/${encodeURIComponent(this.options.project)}${rest}`;
  }

  private toHosted(pr: AzurePullRequest): HostedPullRequest {
    const completed = pr.status === 'completed';
    const closedAt = pr.closedDate ?? null;
    return {
      number: pr.pullRequestId,
      title: pr.title,
      body: pr.description ?? '',
      state: completed ? 'merged' : pr.status === 'abandoned' ? 'closed' : 'open',
      url: this.webUrl(
        `/_git/${encodeURIComponent(this.options.repository)}/pullrequest/${String(pr.pullRequestId)}`,
      ),
      author: pr.createdBy?.displayName ?? null,
      labels: (pr.labels ?? []).map((label) => label.name),
      createdAt: pr.creationDate,
      // Azure keeps no update time: closing is the last change it dates.
      updatedAt: closedAt ?? pr.creationDate,
      closedAt,
      mergedAt: completed ? closedAt : null,
      mergeCommitSha: completed ? (pr.lastMergeCommit?.commitId ?? null) : null,
      baseBranch: branch(pr.targetRefName),
      headBranch: branch(pr.sourceRefName),
    };
  }

  async verify(): Promise<void> {
    await this.http.request(this.url(this.repositoryPath()), z.object({ id: z.string() }));
  }

  /**
   * Pull requests created after the one numbered `cursor`, newest first from
   * Azure, returned oldest first. Ones that changed later are re-read by the
   * sync (`listsAllUpdates` is false). A first sync reads the newest
   * `MAX_PAGES` pages; older pull requests are not read.
   */
  async pullRequests(
    cursor: string | null,
  ): Promise<{ items: HostedPullRequest[]; cursor: string | null }> {
    const seen = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
    const found: AzurePullRequest[] = [];
    for (let pageIndex = 0; pageIndex < MAX_PAGES; pageIndex++) {
      const { value } = await this.http.request(
        this.url(this.repositoryPath('/pullrequests'), {
          'searchCriteria.status': 'all',
          $top: String(PAGE_SIZE),
          $skip: String(pageIndex * PAGE_SIZE),
        }),
        list(pullRequestSchema),
      );
      const fresh = value.filter((pr) => pr.pullRequestId > seen);
      found.push(...fresh);
      if (value.length < PAGE_SIZE || fresh.length < value.length) break;
    }
    const items = found
      .sort((a, b) => a.pullRequestId - b.pullRequestId)
      .map((pr) => this.toHosted(pr));
    const newest = items.at(-1)?.number ?? seen;
    return { items, cursor: newest > 0 ? String(newest) : cursor };
  }

  async pullRequest(number: number): Promise<HostedPullRequest> {
    return this.toHosted(
      await this.http.request(
        this.url(this.repositoryPath(`/pullrequests/${String(number)}`)),
        pullRequestSchema,
      ),
    );
  }

  /** Shas of a pull request's commits, up to the first 1000. */
  async commits(number: number): Promise<string[]> {
    const { value } = await this.http.request(
      this.url(this.repositoryPath(`/pullRequests/${String(number)}/commits`), { $top: '1000' }),
      list(z.object({ commitId: z.string().regex(/^[0-9a-f]{40,64}$/) })),
    );
    return value.map((commit) => commit.commitId);
  }

  async workItems(number: number): Promise<HostedWorkItem[]> {
    const { value: refs } = await this.http.request(
      this.url(this.repositoryPath(`/pullRequests/${String(number)}/workitems`)),
      list(z.object({ id: z.union([z.string().regex(/^\d+$/), z.number().int()]) })),
    );
    const ids = [...new Set(refs.map((ref) => Number(ref.id)))].filter((id) => id > 0);
    const items: HostedWorkItem[] = [];
    for (let start = 0; start < ids.length; start += WORK_ITEM_BATCH) {
      const { value } = await this.http.request(
        this.url('/wit/workitems', { ids: ids.slice(start, start + WORK_ITEM_BATCH).join(',') }),
        list(workItemSchema),
      );
      items.push(...value.map((item) => this.toWorkItem(item)));
    }
    return items;
  }

  private toWorkItem(item: z.infer<typeof workItemSchema>): HostedWorkItem {
    const f = item.fields;
    const closed = CLOSED_STATES.has(f['System.State'].toLowerCase());
    const tags = (f['System.Tags'] ?? '')
      .split(';')
      .map((tag) => tag.trim())
      .filter((tag) => tag !== '');
    return {
      number: item.id,
      title: f['System.Title'],
      body: f['System.Description'] ?? '',
      state: closed ? 'closed' : 'open',
      url: this.webUrl(`/_workitems/edit/${String(item.id)}`),
      author: f['System.CreatedBy']?.displayName ?? null,
      labels: [...tags, `type:${f['System.WorkItemType']}`],
      createdAt: f['System.CreatedDate'],
      updatedAt: f['System.ChangedDate'],
      closedAt: closed ? (f['Microsoft.VSTS.Common.ClosedDate'] ?? f['System.ChangedDate']) : null,
    };
  }
}

/** An Azure Repos repository a remote points at. */
export interface AzureRepositoryRef {
  readonly organization: string;
  readonly project: string;
  readonly repository: string;
}

const NAME = /^[^/\\?#%]+$/;

const decoded = (part: string): string | null => {
  try {
    const text = decodeURIComponent(part);
    return NAME.test(text) && text !== '.' && text !== '..' ? text : null;
  } catch {
    return null;
  }
};

/**
 * Parse an Azure Repos remote: `https://dev.azure.com/org/project/_git/repo`
 * (optionally `user@`), `git@ssh.dev.azure.com:v3/org/project/repo` and the
 * older `https://org.visualstudio.com/[DefaultCollection/]project/_git/repo`.
 */
export function parseAzureRemote(remote: string): AzureRepositoryRef | null {
  const parts = remoteParts(remote);
  if (!parts) return null;
  const segments = parts.path
    .replace(/\.git\/?$/, '')
    .replace(/\/+$/, '')
    .split('/');
  let raw: (string | undefined)[];
  if (parts.host === 'dev.azure.com') {
    const [org, project, git, repo, ...rest] = segments;
    if (git !== '_git' || rest.length > 0) return null;
    raw = [org, project, repo];
  } else if (parts.host === 'ssh.dev.azure.com') {
    const [version, org, project, repo, ...rest] = segments;
    if (version !== 'v3' || rest.length > 0) return null;
    raw = [org, project, repo];
  } else if (parts.host.endsWith('.visualstudio.com')) {
    const org = parts.host.slice(0, -'.visualstudio.com'.length);
    const tail = segments[0]?.toLowerCase() === 'defaultcollection' ? segments.slice(1) : segments;
    const [project, git, repo, ...rest] = tail;
    if (git !== '_git' || rest.length > 0 || org.includes('.')) return null;
    raw = [org, project, repo];
  } else {
    return null;
  }
  const [organization, project, repository] = raw.map((part) => (part ? decoded(part) : null));
  return organization && project && repository ? { organization, project, repository } : null;
}

/** The organisation URL that holds Azure DevOps Services' REST API. */
export const azureApiUrl = (organization: string): string =>
  `https://dev.azure.com/${encodeURIComponent(organization)}`;
