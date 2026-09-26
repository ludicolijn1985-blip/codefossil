import { execFile, spawn, type ChildProcess } from 'node:child_process';

/** Options applied to every git invocation so output is stable and machine-readable. */
export const BASE_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '--no-pager'];

const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Resolve with the exit code once `child` closes; reject if it fails to spawn.
 * Callers often fail on their own (e.g. truncated output) before awaiting this,
 * so a rejection must never go unhandled and crash the process.
 */
export function waitForExit(child: ChildProcess): Promise<number | null> {
  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  exited.catch(() => undefined);
  return exited;
}

export class GitError extends Error {
  override readonly name = 'GitError';

  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
  }
}

function describe(args: readonly string[], stderr: string): string {
  const detail = stderr.trim().split('\n')[0] ?? '';
  return `git ${args[0] ?? ''} failed${detail ? `: ${detail}` : ''}`;
}

/**
 * Run git and return stdout. Arguments are always passed as an array and never
 * through a shell, so repository content cannot inject commands.
 */
export function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...BASE_ARGS, ...args],
      { cwd, maxBuffer: MAX_BUFFER_BYTES, windowsHide: true, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === 'number' ? error.code : null;
          reject(new GitError(describe(args, stderr), args, code, stderr));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Like {@link runGit}, but resolves to `null` when git exits with status 1 (e.g. "not found"). */
export async function runGitOptional(cwd: string, args: readonly string[]): Promise<string | null> {
  try {
    return await runGit(cwd, args);
  } catch (error) {
    if (error instanceof GitError && error.exitCode === 1) return null;
    throw error;
  }
}

/**
 * Stream git's stdout as UTF-8 text chunks. Used for `git log`, whose output
 * can be far larger than is reasonable to buffer.
 */
export async function* streamGit(cwd: string, args: readonly string[]): AsyncGenerator<string> {
  const child = spawn('git', [...BASE_ARGS, ...args], {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = waitForExit(child);

  try {
    child.stdout.setEncoding('utf8');
    for await (const chunk of child.stdout) {
      yield chunk as string;
    }
    const code = await exited;
    if (code !== 0) throw new GitError(describe(args, stderr), args, code, stderr);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}
