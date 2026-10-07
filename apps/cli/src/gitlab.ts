import {
  connectProvider,
  findRepositoryByPath,
  getProviderConnection,
  type ProviderConnectionRow,
} from '@codefossil/db';
import {
  GitLabClient,
  gitlabApiUrl,
  parseGitLabPath,
  parseGitLabRemote,
  TrackerApiError,
  validateApiUrl,
} from '@codefossil/providers';
import { CliError, type CliIO } from './io.js';
import type { Workspace } from './workspace.js';

export const GITLAB_TOKEN_ENV = 'GITLAB_TOKEN';

/** Requests allowed without a token: public projects only, and GitLab limits anonymous use. */
const UNAUTHENTICATED_MAX_REQUESTS = 60;

/**
 * Link the repository to a GitLab project, from `group/name` or the origin
 * remote. Only gitlab.com is implied: a remote is repository content and must
 * never choose where a token is sent, so another host needs `--api-url`.
 */
export async function connectGitLab(
  ws: Workspace,
  io: CliIO,
  path: string | undefined,
  options: { readonly apiUrl?: string; readonly verify: boolean },
): Promise<ProviderConnectionRow> {
  const repository = findRepositoryByPath(ws.fossil.db, ws.root);
  const target = path
    ? parseGitLabPath(path)
    : repository?.remoteUrl
      ? parseGitLabRemote(repository.remoteUrl)
      : null;
  if (!target) {
    throw new CliError(
      path
        ? `"${path}" is not a group/name project path.`
        : 'The origin remote is not a GitLab URL. Pass the project as `codefossil connect gitlab group/name`.',
    );
  }
  if (!options.apiUrl && target.host !== 'gitlab.com') {
    throw new CliError(
      `The repository points at ${target.host}, not gitlab.com. If that is your GitLab, confirm ` +
        `it with --api-url https://${target.host}/api/v4`,
    );
  }
  const apiUrl = (options.apiUrl ?? gitlabApiUrl(target.host)).replace(/\/+$/, '');
  try {
    validateApiUrl(apiUrl);
  } catch (error) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }
  if (options.verify) {
    const token = (io.env ?? process.env)[GITLAB_TOKEN_ENV] ?? null;
    try {
      await new GitLabClient({ apiUrl, token, maxRequests: 1 }).project(target.path);
    } catch (error) {
      if (error instanceof TrackerApiError) {
        throw new CliError(`${error.message} Use --no-verify to connect without checking.`);
      }
      throw error;
    }
  }
  return connectProvider(ws.fossil.db, {
    repositoryId: ws.repositoryId,
    provider: 'gitlab',
    owner: '',
    name: target.path,
    apiUrl,
  });
}

/** A client for the connected GitLab project, with GITLAB_TOKEN when set (never stored). */
export function planGitLabSync(
  ws: Workspace,
  io: CliIO,
  options: { readonly offline: boolean; readonly maxRequests: number },
): {
  readonly factory: ((connection: ProviderConnectionRow) => GitLabClient | null) | undefined;
  readonly notes: readonly string[];
} {
  const connection = getProviderConnection(ws.fossil.db, ws.repositoryId, 'gitlab');
  if (!connection || options.offline) return { factory: undefined, notes: [] };
  const token = (io.env ?? process.env)[GITLAB_TOKEN_ENV] ?? null;
  const maxRequests = token
    ? options.maxRequests
    : Math.min(options.maxRequests, UNAUTHENTICATED_MAX_REQUESTS);
  const pinned = connection.apiUrl;
  return {
    factory: (conn) =>
      conn.apiUrl === pinned ? new GitLabClient({ apiUrl: pinned, token, maxRequests }) : null,
    notes: token
      ? []
      : [
          `No ${GITLAB_TOKEN_ENV} set; syncing GitLab unauthenticated, which only works for public ` +
            `projects and is limited to ${String(maxRequests)} requests.`,
        ],
  };
}
