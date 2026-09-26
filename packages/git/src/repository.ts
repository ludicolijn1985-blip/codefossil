import { GitError, runGit, runGitOptional } from './exec.js';

export interface GitRepository {
  /** Absolute path of the working tree root, with forward slashes. */
  readonly root: string;
  /** Branch checked out at HEAD, or null when HEAD is detached. */
  readonly currentBranch: string | null;
  /** SHA of HEAD, or null for a repository without commits. */
  readonly headSha: string | null;
  /** URL of the `origin` remote with any credentials removed, or null. */
  readonly remoteUrl: string | null;
}

export class NotAGitRepositoryError extends Error {
  override readonly name = 'NotAGitRepositoryError';

  constructor(readonly path: string) {
    super(`${path} is not inside a Git working tree`);
  }
}

/** Locate the repository containing `path` and read its basic metadata. */
export async function openGitRepository(path: string): Promise<GitRepository> {
  let root: string;
  try {
    root = (await runGit(path, ['rev-parse', '--show-toplevel'])).trim();
  } catch (error) {
    if (error instanceof GitError || isMissingDirectory(error)) {
      throw new NotAGitRepositoryError(path);
    }
    throw error;
  }

  const [branch, head, remote] = await Promise.all([
    runGitOptional(root, ['symbolic-ref', '--short', '-q', 'HEAD']),
    runGitOptional(root, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => null),
    runGitOptional(root, ['config', '--get', 'remote.origin.url']),
  ]);

  return {
    root,
    currentBranch: branch?.trim() || null,
    headSha: head?.trim() || null,
    remoteUrl: remote ? redactUrlCredentials(remote.trim()) : null,
  };
}

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

/**
 * Remove `user:password@` from a remote URL so tokens embedded in HTTPS
 * remotes never reach the database or logs. SSH-style `git@host:path`
 * remotes carry no secret and are returned unchanged.
 */
export function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    // Not parseable as a URL: still strip anything that looks like userinfo so
    // a malformed but credential-bearing URL is never stored as-is.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@]*@/i, '$1');
  }
}
