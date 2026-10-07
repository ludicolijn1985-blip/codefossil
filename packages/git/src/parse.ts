export type GitChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export interface GitFileChange {
  readonly status: GitChangeStatus;
  readonly path: string;
  /** Path before a rename, otherwise null. */
  readonly previousPath: string | null;
  /** Lines added, or null when git cannot count them (binary files). */
  readonly additions: number | null;
  /** Lines deleted, or null when git cannot count them (binary files). */
  readonly deletions: number | null;
}

export interface GitCommit {
  readonly sha: string;
  readonly parents: readonly string[];
  readonly authorName: string;
  readonly authorEmail: string;
  /** ISO-8601 in UTC. */
  readonly authoredAt: string;
  /** ISO-8601 in UTC. */
  readonly committedAt: string;
  readonly subject: string;
  readonly body: string;
  /** Changes against the first parent. Empty for merge commits. */
  readonly changes: readonly GitFileChange[];
}

/** Starts each commit in the log stream (ASCII record separator). */
export const RECORD_SEPARATOR = '\x1e';

/**
 * A record boundary: the separator followed by a full SHA (SHA-1 or SHA-256)
 * and the NUL that ends it. Commit messages may legally contain \x1e, so
 * splitting on the bare byte would break such commits.
 */
// eslint-disable-next-line no-control-regex -- matching git's record separator is the point
export const RECORD_BOUNDARY = /\x1e(?=[0-9a-f]{40}(?:[0-9a-f]{24})?\0)/;

/** `git log` format matching {@link parseCommitRecord}. */
export const LOG_FORMAT = `--format=${RECORD_SEPARATOR}%H%x00%P%x00%aN%x00%aE%x00%aI%x00%cI%x00%s%x00%b%x00`;

const HEADER_FIELD_COUNT = 8;

export class GitParseError extends Error {
  override readonly name = 'GitParseError';
}

/**
 * Parse one commit record produced by `git log -z --raw --numstat` with
 * {@link LOG_FORMAT}, without the leading record separator.
 *
 * `--raw` supplies each change's status and paths; `--numstat` supplies line
 * counts. Both list changes in the same order, keyed here by final path.
 */
export function parseCommitRecord(record: string): GitCommit {
  const tokens = record.split('\0');
  if (tokens.length < HEADER_FIELD_COUNT) {
    throw new GitParseError(`Truncated commit record: ${JSON.stringify(record.slice(0, 80))}`);
  }
  const [sha, parents, authorName, authorEmail, authoredAt, committedAt, subject, body] =
    tokens as [string, string, string, string, string, string, string, string];
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
    throw new GitParseError(`Invalid commit SHA: ${JSON.stringify(sha)}`);
  }

  return {
    sha,
    parents: parents ? parents.split(' ') : [],
    authorName,
    authorEmail,
    authoredAt: toUtcIso(authoredAt),
    committedAt: toUtcIso(committedAt),
    subject,
    body: body.trimEnd(),
    changes: parseChanges(tokens.slice(HEADER_FIELD_COUNT)),
  };
}

interface RawChange {
  status: GitChangeStatus;
  path: string;
  previousPath: string | null;
}

function parseChanges(tokens: readonly string[]): GitFileChange[] {
  const raw: RawChange[] = [];
  const counts = new Map<string, { additions: number | null; deletions: number | null }>();

  // The diff section starts after an empty token and a newline; skip both.
  const queue = tokens.map((token) => token.replace(/^\n+/, '')).filter((token) => token !== '');
  for (let i = 0; i < queue.length; i++) {
    const token = queue[i] ?? '';
    if (token.startsWith(':')) {
      const status = token.slice(token.lastIndexOf(' ') + 1);
      if (status.startsWith('R') || status.startsWith('C')) {
        const sourcePath = expectPath(queue[++i], token);
        const path = expectPath(queue[++i], token);
        // A copy leaves its source in place, so only a rename has a previous path.
        const isRename = status.startsWith('R');
        raw.push({
          status: isRename ? 'renamed' : 'added',
          path,
          previousPath: isRename ? sourcePath : null,
        });
      } else {
        raw.push({
          status: toStatus(status),
          path: expectPath(queue[++i], token),
          previousPath: null,
        });
      }
      continue;
    }

    const [added, deleted, path] = token.split('\t');
    if (added === undefined || deleted === undefined || path === undefined) {
      throw new GitParseError(`Unexpected diff token: ${JSON.stringify(token)}`);
    }
    let finalPath = path;
    if (path === '') {
      // For renames numstat leaves the path empty and lists old and new paths next.
      i += 2;
      finalPath = expectPath(queue[i], token);
    }
    counts.set(finalPath, { additions: toCount(added), deletions: toCount(deleted) });
  }

  return raw.map((change) => ({
    ...change,
    ...(counts.get(change.path) ?? { additions: null, deletions: null }),
  }));
}

function toStatus(code: string): GitChangeStatus {
  switch (code[0]) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'M':
    case 'T':
      return 'modified';
    default:
      throw new GitParseError(`Unsupported change status: ${code}`);
  }
}

function toCount(value: string): number | null {
  return value === '-' ? null : Number.parseInt(value, 10);
}

function expectPath(value: string | undefined, context: string): string {
  if (!value) throw new GitParseError(`Missing path after ${JSON.stringify(context)}`);
  return value;
}

function toUtcIso(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new GitParseError(`Invalid date: ${value}`);
  return date.toISOString();
}
