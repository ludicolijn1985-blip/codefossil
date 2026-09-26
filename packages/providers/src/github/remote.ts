export interface GitHubRepositoryRef {
  readonly host: string;
  readonly owner: string;
  readonly name: string;
}

const SLUG_PART = /^[A-Za-z0-9_.-]+$/;

/**
 * Parse a Git remote URL that points at GitHub (or GitHub Enterprise):
 * `https://github.com/acme/shop.git`, `git@github.com:acme/shop.git`,
 * `ssh://git@github.example.com/acme/shop`. Returns null for anything else.
 */
export function parseGitHubRemote(remote: string): GitHubRepositoryRef | null {
  const scp = /^[\w.-]+@([\w.-]+):([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(remote);
  if (scp) return build(scp[1], scp[2], scp[3]);
  try {
    const url = new URL(remote);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return null;
    const parts = url.pathname
      .replace(/\.git\/?$/, '')
      .split('/')
      .filter(Boolean);
    return parts.length === 2 ? build(url.hostname, parts[0], parts[1]) : null;
  } catch {
    return null;
  }
}

/** Parse `owner/name`. */
export function parseGitHubSlug(slug: string, host = 'github.com'): GitHubRepositoryRef | null {
  const [owner, name, ...rest] = slug.split('/');
  return rest.length === 0 ? build(host, owner, name) : null;
}

function build(
  host: string | undefined,
  owner: string | undefined,
  name: string | undefined,
): GitHubRepositoryRef | null {
  if (!host || !owner || !name || !SLUG_PART.test(owner) || !SLUG_PART.test(name)) return null;
  return { host: host.toLowerCase(), owner, name };
}

/** REST API base URL for a GitHub host: api.github.com, or `/api/v3` on Enterprise Server. */
export function defaultApiUrl(host: string): string {
  return host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`;
}
