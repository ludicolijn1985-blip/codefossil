import { execFile } from 'node:child_process';

export interface GitHubToken {
  readonly token: string;
  /** Where the token came from, for messages. The token itself is never shown. */
  readonly source: 'GITHUB_TOKEN' | 'GH_TOKEN' | 'GH_ENTERPRISE_TOKEN' | 'gh auth token';
}

const GH_TIMEOUT_MS = 5_000;

/** A plain DNS name or IP, optionally with a port; never something `gh` could read as a flag. */
const HOSTNAME =
  /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::\d+)?$/i;

export function isValidHostname(host: string): boolean {
  return HOSTNAME.test(host);
}

function ghAuthToken(host: string): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['auth', 'token', '--hostname', host],
      { timeout: GH_TIMEOUT_MS, windowsHide: true, encoding: 'utf8' },
      (error, stdout) => {
        // Not installed, not logged in, or no token for this host: no token.
        resolve(error ? null : stdout.trim() || null);
      },
    );
  });
}

/**
 * Find a token for `host` without storing one, scoped the way the GitHub CLI
 * scopes them: `GITHUB_TOKEN` and `GH_TOKEN` belong to github.com only; any
 * other host (GitHub Enterprise Server) gets `GH_ENTERPRISE_TOKEN` or the
 * CLI's login for that exact host. A token for one host is never offered to
 * another, so a repository cannot redirect a github.com token elsewhere.
 */
export async function resolveGitHubToken(
  host: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
  gh: (host: string) => Promise<string | null> = ghAuthToken,
): Promise<GitHubToken | null> {
  const normalized = host.toLowerCase();
  if (!isValidHostname(normalized)) return null;
  if (normalized === 'github.com') {
    const fromEnv = env.GITHUB_TOKEN?.trim();
    if (fromEnv) return { token: fromEnv, source: 'GITHUB_TOKEN' };
    const fromGhEnv = env.GH_TOKEN?.trim();
    if (fromGhEnv) return { token: fromGhEnv, source: 'GH_TOKEN' };
  } else {
    const enterprise = env.GH_ENTERPRISE_TOKEN?.trim();
    if (enterprise) return { token: enterprise, source: 'GH_ENTERPRISE_TOKEN' };
  }
  const fromCli = await gh(normalized);
  return fromCli ? { token: fromCli, source: 'gh auth token' } : null;
}
