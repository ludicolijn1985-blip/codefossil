import { spawn } from 'node:child_process';
import { BASE_ARGS, GitError, waitForExit } from './exec.js';

export interface BlobRequest {
  /** Commit (or any revision) to read from. */
  readonly revision: string;
  /** Path relative to the repository root. */
  readonly path: string;
}

export interface BlobResult<R extends BlobRequest> {
  readonly request: R;
  /**
   * File content, or null when there is no blob at that path (missing,
   * a directory, a submodule), it exceeds `maxBytes`, or the path cannot be
   * expressed in cat-file's line-based protocol.
   */
  readonly content: Buffer | null;
}

export interface ReadBlobsOptions {
  /** Larger blobs are skipped (read and discarded, never buffered). */
  readonly maxBytes?: number;
}

export const DEFAULT_MAX_BLOB_BYTES = 4 * 1024 * 1024;

/**
 * Read many blobs through one `git cat-file --batch` process, yielding results
 * in request order. Content is streamed; only one blob is held at a time.
 */
export async function* readBlobs<R extends BlobRequest>(
  root: string,
  requests: readonly R[],
  options: ReadBlobsOptions = {},
): AsyncGenerator<BlobResult<R>> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BLOB_BYTES;
  // cat-file reads one request per line, so paths containing newlines cannot be requested.
  const sendable = requests.map((r) => !/[\n\r]/.test(r.path) && !/[\n\r]/.test(r.revision));
  if (!sendable.some(Boolean)) {
    for (const request of requests) yield { request, content: null };
    return;
  }

  const args = [...BASE_ARGS, 'cat-file', '--batch', '--buffer'];
  const child = spawn('git', args, {
    cwd: root,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = waitForExit(child);

  const input = requests
    .filter((_, i) => sendable[i])
    .map((r) => `${r.revision}:${r.path}\n`)
    .join('');
  // If git exits early, the write fails with EPIPE; the exit code reports the real error.
  child.stdin.on('error', () => undefined);
  child.stdin.end(input);

  const reader = new ByteReader(child.stdout);
  try {
    for (const [i, request] of requests.entries()) {
      if (!sendable[i]) {
        yield { request, content: null };
        continue;
      }
      const header = await reader.readLine();
      if (header === null)
        throw new GitError(`git cat-file ended early: ${stderr.trim()}`, args, null, stderr);
      const match = /^[0-9a-f]+ (\S+) (\d+)$/.exec(header);
      if (!match) {
        // "<spec> missing" or "<spec> ambiguous": no content follows.
        yield { request, content: null };
        continue;
      }
      const type = match[1] ?? '';
      const size = Number(match[2]);
      const keep = type === 'blob' && size <= maxBytes;
      const content = keep ? await reader.readBytes(size) : (await reader.skipBytes(size), null);
      await reader.skipBytes(1); // trailing newline
      yield { request, content };
    }
    const code = await exited;
    if (code !== 0) throw new GitError(`git cat-file failed: ${stderr.trim()}`, args, code, stderr);
  } finally {
    if (child.exitCode === null) child.kill();
  }
}

/** Minimal pull-based reader over a byte stream. */
class ByteReader {
  private readonly chunks: AsyncIterator<Buffer>;
  private buffer: Buffer = Buffer.alloc(0);
  private done = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.chunks = stream[Symbol.asyncIterator]();
  }

  async readLine(): Promise<string | null> {
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline !== -1) {
        const line = this.buffer.subarray(0, newline).toString('utf8');
        this.buffer = this.buffer.subarray(newline + 1);
        return line;
      }
      if (!(await this.fill())) return null;
    }
  }

  async readBytes(count: number): Promise<Buffer> {
    while (this.buffer.length < count) {
      if (!(await this.fill())) throw new Error('Unexpected end of git cat-file output');
    }
    const bytes = Buffer.from(this.buffer.subarray(0, count));
    this.buffer = this.buffer.subarray(count);
    return bytes;
  }

  async skipBytes(count: number): Promise<void> {
    let remaining = count;
    for (;;) {
      const take = Math.min(remaining, this.buffer.length);
      this.buffer = this.buffer.subarray(take);
      remaining -= take;
      if (remaining === 0) return;
      if (!(await this.fill())) throw new Error('Unexpected end of git cat-file output');
    }
  }

  private async fill(): Promise<boolean> {
    if (this.done) return false;
    const next = await this.chunks.next();
    if (next.done) {
      this.done = true;
      return false;
    }
    this.buffer = this.buffer.length === 0 ? next.value : Buffer.concat([this.buffer, next.value]);
    return true;
  }
}
