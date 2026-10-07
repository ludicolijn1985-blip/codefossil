import {
  connectProvider,
  findRepositoryByPath,
  listProviderConnections,
  type ProviderConnectionRow,
} from '@codefossil/db';
import {
  AzureDevOpsClient,
  azureApiUrl,
  BITBUCKET_API_URL,
  BitbucketClient,
  parseAzureRemote,
  parseBitbucketRemote,
  parseBitbucketSlug,
  TrackerApiError,
  validateApiUrl,
  type PullRequestHostClient,
} from '@codefossil/providers';
import { CliError, type CliIO } from './io.js';
import type { Workspace } from './workspace.js';

/** A Bitbucket repository or workspace access token, sent as a Bearer token. */
export const BITBUCKET_TOKEN_ENV = 'BITBUCKET_TOKEN';
/** An Atlassian API token with Bitbucket scopes, sent as Basic auth with the account email. */
export const BITBUCKET_EMAIL_ENV = 'BITBUCKET_EMAIL';
export const BITBUCKET_API_TOKEN_ENV = 'BITBUCKET_API_TOKEN';
/** An Azure DevOps personal access token; the name the Azure CLI uses is read too. */
export const AZURE_TOKEN_ENV = 'AZURE_DEVOPS_TOKEN';
const AZURE_CLI_TOKEN_ENV = 'AZURE_DEVOPS_EXT_PAT';

/** Requests allowed without credentials: public repositories only, and hosts limit anonymous use. */
const UNAUTHENTICATED_MAX_REQUESTS = 60;

type Env = Readonly<Record<string, string | undefined>>;

function bitbucketAuthorization(env: Env): string | null {
  const token = env[BITBUCKET_TOKEN_ENV];
  if (token) return `Bearer ${token}`;
  const email = env[BITBUCKET_EMAIL_ENV];
  const apiToken = env[BITBUCKET_API_TOKEN_ENV];
  return email && apiToken
    ? `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`
    : null;
}

const azureToken = (env: Env): string | null =>
  env[AZURE_TOKEN_ENV] ?? env[AZURE_CLI_TOKEN_ENV] ?? null;

/** A client for a stored connection, credentials from the environment (never stored). */
function clientFor(
  connection: ProviderConnectionRow,
  env: Env,
  maxRequests: number,
): PullRequestHostClient | null {
  if (connection.provider === 'bitbucket') {
    // Always Bitbucket Cloud: a stored URL never decides where the token goes.
    return new BitbucketClient({
      apiUrl: BITBUCKET_API_URL,
      workspace: connection.owner,
      repository: connection.name,
      authorization: bitbucketAuthorization(env),
      maxRequests,
    });
  }
  if (connection.provider === 'azure') {
    return new AzureDevOpsClient({
      apiUrl: connection.apiUrl,
      project: connection.owner,
      repository: connection.name,
      token: azureToken(env),
      maxRequests,
    });
  }
  return null;
}

const hasCredentials = (provider: string, env: Env) =>
  provider === 'bitbucket' ? bitbucketAuthorization(env) !== null : azureToken(env) !== null;

async function verifyAccess(client: PullRequestHostClient | null): Promise<void> {
  try {
    await client?.verify();
  } catch (error) {
    if (error instanceof TrackerApiError) {
      throw new CliError(`${error.message} Use --no-verify to connect without checking.`);
    }
    throw error;
  }
}

/** Link the repository to a Bitbucket Cloud repository, from `workspace/repo` or the origin remote. */
export async function connectBitbucket(
  ws: Workspace,
  io: CliIO,
  slug: string | undefined,
  options: { readonly verify: boolean },
): Promise<ProviderConnectionRow> {
  const remote = findRepositoryByPath(ws.fossil.db, ws.root)?.remoteUrl;
  const target = slug ? parseBitbucketSlug(slug) : remote ? parseBitbucketRemote(remote) : null;
  if (!target) {
    throw new CliError(
      slug
        ? `"${slug}" is not a workspace/repository slug.`
        : 'The origin remote is not a bitbucket.org URL. Pass the repository as `codefossil connect bitbucket workspace/repo`.',
    );
  }
  const connection = {
    repositoryId: ws.repositoryId,
    provider: 'bitbucket' as const,
    owner: target.workspace,
    name: target.repository,
    apiUrl: BITBUCKET_API_URL,
  };
  if (options.verify) {
    const row = { ...connection, id: 0, cursor: null, lastSyncedAt: null, createdAt: '' };
    await verifyAccess(clientFor(row, io.env ?? process.env, 1));
  }
  return connectProvider(ws.fossil.db, connection);
}

/**
 * Link the repository to an Azure Repos repository, from
 * `organization/project/repository` or the origin remote. Only Azure DevOps
 * Services is implied: a remote must never choose where a token is sent, so
 * Azure DevOps Server needs `--api-url` (its collection URL) and `project/repository`.
 */
export async function connectAzure(
  ws: Workspace,
  io: CliIO,
  path: string | undefined,
  options: { readonly apiUrl?: string; readonly verify: boolean },
): Promise<ProviderConnectionRow> {
  const remote = findRepositoryByPath(ws.fossil.db, ws.root)?.remoteUrl;
  let target: { organization: string | null; project: string; repository: string } | null = null;
  if (path) {
    const parts = path.split('/');
    const valid = parts.every(
      (part) => part !== '' && part !== '.' && part !== '..' && !/[\\?#%]/.test(part),
    );
    if (valid && options.apiUrl && parts.length === 2) {
      target = { organization: null, project: parts[0] ?? '', repository: parts[1] ?? '' };
    } else if (valid && !options.apiUrl && parts.length === 3) {
      const [organization = '', project = '', repository = ''] = parts;
      target = { organization, project, repository };
    }
  } else if (remote && !options.apiUrl) {
    target = parseAzureRemote(remote);
  }
  if (!target) {
    throw new CliError(
      path
        ? options.apiUrl
          ? `"${path}" is not a project/repository path.`
          : `"${path}" is not an organization/project/repository path.`
        : 'The origin remote is not an Azure Repos URL. Pass the repository as ' +
            '`codefossil connect azure organization/project/repository`.',
    );
  }
  const apiUrl = (options.apiUrl ?? azureApiUrl(target.organization ?? '')).replace(/\/+$/, '');
  try {
    validateApiUrl(apiUrl);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
  const connection = {
    repositoryId: ws.repositoryId,
    provider: 'azure' as const,
    owner: target.project,
    name: target.repository,
    apiUrl,
  };
  if (options.verify) {
    const row = { ...connection, id: 0, cursor: null, lastSyncedAt: null, createdAt: '' };
    await verifyAccess(clientFor(row, io.env ?? process.env, 1));
  }
  return connectProvider(ws.fossil.db, connection);
}

/** Clients for connected Bitbucket and Azure Repos repositories, pinned to the stored API URL. */
export function planHostedSync(
  ws: Workspace,
  io: CliIO,
  options: { readonly offline: boolean; readonly maxRequests: number },
): {
  readonly factory:
    ((connection: ProviderConnectionRow) => PullRequestHostClient | null) | undefined;
  readonly notes: readonly string[];
} {
  const hosts = listProviderConnections(ws.fossil.db, ws.repositoryId).filter(
    (c) => c.provider === 'bitbucket' || c.provider === 'azure',
  );
  if (hosts.length === 0 || options.offline) return { factory: undefined, notes: [] };
  const env = io.env ?? process.env;
  const pinned = new Map(hosts.map((c) => [c.provider, c.apiUrl]));
  const notes = hosts
    .filter((c) => !hasCredentials(c.provider, env))
    .map((c) =>
      c.provider === 'bitbucket'
        ? `No ${BITBUCKET_TOKEN_ENV} (or ${BITBUCKET_EMAIL_ENV} and ${BITBUCKET_API_TOKEN_ENV}) set; ` +
          `syncing Bitbucket unauthenticated, which only works for public repositories and is limited to ${String(UNAUTHENTICATED_MAX_REQUESTS)} requests.`
        : `No ${AZURE_TOKEN_ENV} set; syncing Azure DevOps unauthenticated, which only works for ` +
          `public projects and is limited to ${String(UNAUTHENTICATED_MAX_REQUESTS)} requests.`,
    );
  return {
    factory: (connection) => {
      if (pinned.get(connection.provider) !== connection.apiUrl) return null;
      const budget = hasCredentials(connection.provider, env)
        ? options.maxRequests
        : Math.min(options.maxRequests, UNAUTHENTICATED_MAX_REQUESTS);
      return clientFor(connection, env, budget);
    },
    notes,
  };
}
