import { streamGit } from './exec.js';
import {
  GitParseError,
  LOG_FORMAT,
  parseCommitRecord,
  RECORD_BOUNDARY,
  type GitCommit,
} from './parse.js';

/**
 * Largest single commit record accepted, in characters. A commit touching
 * tens of thousands of files stays well below this; anything larger is
 * treated as hostile input rather than buffered until memory runs out.
 */
export const MAX_RECORD_LENGTH = 64 * 1024 * 1024;

export interface ReadCommitsOptions {
  /** Only include commits committed at or after this moment. */
  readonly since?: Date;
  /** Override {@link MAX_RECORD_LENGTH} (used by tests). */
  readonly maxRecordLength?: number;
}

/**
 * Stream the history reachable from HEAD, oldest first, with parents always
 * yielded before their children.
 *
 * Merge commits are yielded without file changes; the changes they bring in
 * are reported on the commits of the merged branch.
 */
export async function* readCommits(
  root: string,
  options: ReadCommitsOptions = {},
): AsyncGenerator<GitCommit> {
  const args = [
    'log',
    '--topo-order',
    '--reverse',
    '-z',
    '-M',
    '--raw',
    '--numstat',
    '--no-abbrev',
    '--no-ext-diff',
    '--no-textconv',
    LOG_FORMAT,
  ];
  if (options.since) args.push(`--since=${options.since.toISOString()}`);
  args.push('HEAD', '--');

  const maxRecordLength = options.maxRecordLength ?? MAX_RECORD_LENGTH;
  let buffer = '';
  for await (const chunk of streamGit(root, args)) {
    buffer += chunk;
    const records = buffer.split(RECORD_BOUNDARY);
    // The last piece may be an incomplete record; keep it for the next chunk.
    buffer = records.pop() ?? '';
    if (buffer.length > maxRecordLength) {
      throw new GitParseError(
        `A single commit produced more than ${maxRecordLength} characters of log output; refusing to buffer it.`,
      );
    }
    // Splitting consumes the separators; the stream starts with one, leaving an empty first piece.
    for (const record of records) {
      if (record !== '') yield parseCommitRecord(record);
    }
  }
  if (buffer !== '') yield parseCommitRecord(buffer);
}
