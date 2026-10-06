import { spawn, type ChildProcess } from 'node:child_process';

/** A tool result: the text the tool returned, and whether it reported an error. */
export interface ToolResult {
  readonly text: string;
  readonly isError: boolean;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * A minimal Model Context Protocol client over stdio: newline-delimited
 * JSON-RPC to one long-running `codefossil mcp` process. The command line is
 * fixed; file paths only travel inside JSON messages, never through a shell.
 */
export class McpClient {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = '';
  private ready: Promise<void>;
  private closed: Error | null = null;

  constructor(
    command: string,
    args: readonly string[],
    cwd: string,
    onLog: (text: string) => void = () => undefined,
  ) {
    this.child = spawn(command, [...args], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      windowsVerbatimArguments: command.toLowerCase().endsWith('cmd.exe'),
    });
    this.child.stdout?.setEncoding('utf8');
    this.child.stdout?.on('data', (chunk: string) => {
      this.onData(chunk);
    });
    this.child.stderr?.setEncoding('utf8');
    this.child.stderr?.on('data', (chunk: string) => {
      onLog(chunk);
    });
    const fail = (error: Error) => {
      this.closed = error;
      for (const waiting of this.pending.values()) waiting.reject(error);
      this.pending.clear();
    };
    this.child.on('error', fail);
    this.child.on('exit', (code) => {
      fail(new Error(`codefossil mcp exited with code ${String(code)}`));
    });
    this.ready = this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'codefossil-vscode', version: '0.1.0' },
    }).then(() => {
      this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    });
  }

  /** Call a tool once the session is open; calls queue in the server, one at a time. */
  async callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    await this.ready;
    const result = await this.request('tools/call', { name, arguments: args });
    if (!isRecord(result) || !Array.isArray(result.content)) {
      throw new Error(`Unexpected reply from codefossil for ${name}`);
    }
    const text = result.content
      .map((part: unknown) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
      .join('');
    return { text, isError: result.isError === true };
  }

  dispose(): void {
    this.child.stdin?.end();
    this.child.kill();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ jsonrpc: '2.0', id, method, params });
    });
  }

  private send(message: unknown): void {
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    for (
      let newline = this.buffer.indexOf('\n');
      newline !== -1;
      newline = this.buffer.indexOf('\n')
    ) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line !== '') this.onMessage(line);
    }
  }

  private onMessage(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(message) || typeof message.id !== 'number') return;
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    this.pending.delete(message.id);
    if (isRecord(message.error)) {
      const text = message.error.message;
      waiting.reject(new Error(typeof text === 'string' ? text : 'codefossil error'));
    } else {
      waiting.resolve(message.result);
    }
  }
}
