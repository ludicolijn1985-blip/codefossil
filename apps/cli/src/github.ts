import {
  connectProvider,
  findRepositoryByPath,
  getProviderConnection,
  type ProviderConnectionRow,
} from '@codefossil/db';
import {
  defaultApiUrl,
  GitHubApiError,
  GitHubClient,
  parseGitHubRemote,
  parseGitHubSlug,
  repositorySchema,
  resolveGitHubToken,
  validateApiUrl,
  type GitHubToken,
} from '@codefossil/providers';
import { CliError, type CliIO } from './io.js';
import type { Workspace } from './workspace.js';

/** Unauthenticated GitHub allows 60 requests an hour; stay well inside it. */
const UNAUTHENTICATED_MAX_REQUESTS = 50;

export type TokenResolver = (host: string) => Promise<GitHubToken | null>;

export const defaultTokenResolver: TokenResolver = (host) => resolveGitHubToken(host);

/** The host a token belongs to: `github.com` for api.github.com, else the API host. */
function tokenHost(apiUrl: string): string {
  const host = new URL(apiUrl).hostname;
  return host === 'api.github.com' ? 'github.com' : host;
}

function tokenResolver(io: CliIO): TokenResolver {
  return io.resolveGitHubToken ?? defaultTokenResolver;
}

export interface ConnectOptions {
  readonly apiUrl?: string;
  readonly verify: boolean;
}

/**
 * Link the repository to a GitHub repository: from `owner/name`, or from the
 * `origin` remote. Verifies access unless told not to. Stores no credentials.
 */
export async function connectGitHub(
  ws: Workspace,
  io: CliIO,
  slug: string | undefined,
  options: ConnectOptions,
): Promise<ProviderConnectionRow> {
  const repository = findRepositoryByPath(ws.fossil.db, ws.root);
  const target = slug
    ? parseGitHubSlug(slug)
    : repository?.remoteUrl
      ? parseGitHubRemote(repository.remoteUrl)
      : null;
  if (!target) {
    throw new CliError(
      slug
        ? `"${slug}" is not an owner/name slug.`
        : 'The origin remote is not a GitHub URL. Pass the repository as `fossil connect github owner/name`.',
    );
  }
  // A remote is repository content: never let it choose where a token is sent.
  // Only github.com is implied; any other host must be confirmed with --api-url.
  if (!options.apiUrl && target.host !== 'github.com') {
    throw new CliError(
      `The repository points at ${target.host}, not github.com. If that is your GitHub ` +
        `Enterprise Server, confirm it with --api-url https://${target.host}/api/v3`,
    );
  }
  const apiUrl = options.apiUrl ?? defaultApiUrl(target.host);
  try {
    validateApiUrl(apiUrl);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  if (options.verify) {
    const token = await tokenResolver(io)(tokenHost(apiUrl));
    const client = new GitHubClient({ apiUrl, token: token?.token ?? null, maxRequests: 1 });
    try {
      await client.get(
        `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.name)}`,
        repositorySchema,
      );
    } catch (error) {
      if (error instanceof GitHubApiError) {
        throw new CliError(`${error.message} Use --no-verify to connect without checking.`);
      }
      throw error;
    }
  }
  return connectProvider(ws.fossil.db, {
    repositoryId: ws.repositoryId,
    provider: 'github',
    owner: target.owner,
    name: target.name,
    apiUrl,
  });
}

export interface SyncPlan {
  readonly factory: ((connection: ProviderConnectionRow) => GitHubClient) | undefined;
  /** Messages to show before indexing (why the sync is offline or limited). */
  readonly notes: readonly string[];
}

/** Decide how `fossil index` talks to GitHub: not at all, unauthenticated, or with a token. */
export async function planGitHubSync(
  ws: Workspace,
  io: CliIO,
  options: { readonly offline: boolean; readonly maxRequests: number },
): Promise<SyncPlan> {
  const connection = getProviderConnection(ws.fossil.db, ws.repositoryId, 'github');
  if (!connection || options.offline) return { factory: undefined, notes: [] };

  const token = await tokenResolver(io)(tokenHost(connection.apiUrl));
  const notes: string[] = [];
  const maxRequests = token
    ? options.maxRequests
    : Math.min(options.maxRequests, UNAUTHENTICATED_MAX_REQUESTS);
  if (!token) {
    notes.push(
      'No GitHub token found (GITHUB_TOKEN, GH_TOKEN or `gh auth login`); syncing unauthenticated, ' +
        `which only works for public repositories and is limited to ${maxRequests} requests.`,
    );
  }
  return {
    factory: (conn) =>
      new GitHubClient({ apiUrl: conn.apiUrl, token: token?.token ?? null, maxRequests }),
    notes,
  };
}
