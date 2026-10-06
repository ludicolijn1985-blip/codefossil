import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { createSampleHistory, type SampleHistory } from '@codefossil/git/testing';
import type { CliIO } from './io.js';
import { commandRunner, createMcpServer, MCP_TOOLS, type CommandRunner } from './mcp-command.js';

const quietIo = (cwd: string): CliIO => ({
  cwd,
  stdout: () => undefined,
  stderr: () => undefined,
  resolveGitHubToken: () => Promise.resolve(null),
});

async function connect(run: CommandRunner, ready: Promise<unknown> = Promise.resolve()) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(run, ready);
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-agent', version: '1.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

interface TextResult {
  readonly isError?: boolean;
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

const textOf = (result: TextResult): string =>
  result.content.map((part) => (part.type === 'text' ? (part.text ?? '') : '')).join('');

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const result = (await client.callTool({ name, arguments: args })) as TextResult;
  return { isError: result.isError === true, text: textOf(result) };
}

describe('codefossil mcp on a real repository', () => {
  let sample: SampleHistory | undefined;
  let session: Awaited<ReturnType<typeof connect>> | undefined;

  beforeEach(async () => {
    sample = await createSampleHistory();
    session = await connect(commandRunner(sample.repo.root, quietIo(sample.repo.root)));
  });

  afterEach(async () => {
    await session?.close();
    await sample?.repo.cleanup();
  });

  const client = (): Client => {
    if (!session) throw new Error('not connected');
    return session.client;
  };

  it('lists read-only, offline tools', async () => {
    const { tools } = await client().listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(MCP_TOOLS.map((t) => t.name).sort());
    for (const listed of tools) {
      expect(listed.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    }
  });

  it('answers why from evidence, indexing on first use', async () => {
    const result = await call(client(), 'why', { target: 'calculateVAT' });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('Add VAT calculation');
    expect(result.text).toMatch(/FACT|DERIVED/);
  });

  it('follows a file across renames in timeline', async () => {
    const result = await call(client(), 'timeline', { path: 'src/tax/vat.ts' });

    expect(result.isError).toBe(false);
    expect(result.text).toContain('Move VAT into tax module');
    expect(result.text).toContain('Handle reduced VAT rate');
  });

  it('reports a target it cannot find as a tool error, not a crash', async () => {
    const result = await call(client(), 'why', { target: 'noSuchThingAnywhere' });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/error:/);
  });
});

describe('codefossil mcp tool handling', () => {
  it('never passes a target that could be read as a CLI option', async () => {
    const seen: (readonly string[])[] = [];
    const { client, close } = await connect((args) => {
      seen.push(args);
      return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' });
    });

    const rejected = await client
      .callTool({ name: 'why', arguments: { target: '--repo=/etc' } })
      .then((result) => (result as TextResult).isError === true)
      .catch(() => true);
    await call(client, 'why', { target: 'calculateVAT' });
    await close();

    expect(rejected).toBe(true);
    expect(seen).toEqual([['why', '--no-save', '--', 'calculateVAT']]);
  });

  it.each([
    ['change_report', { base: '-x' }],
    ['change_report', { base: '--' }],
    ['impact', { target: 'a.ts', depth: 0 }],
    ['impact', { target: 'a.ts', depth: 11 }],
    ['impact', { target: 'a.ts', depth: 1.5 }],
    ['hotspots', { since: 'yesterday' }],
    ['timeline', { path: '../outside.ts' }],
    ['timeline', { path: '/etc/passwd' }],
    ['symbols', { path: 'C:\\Windows\\win.ini' }],
    ['why', { target: 'src/../../secret' }],
  ])('refuses %s with %j before running anything', async (name, args) => {
    const seen: (readonly string[])[] = [];
    const { client, close } = await connect((runArgs) => {
      seen.push(runArgs);
      return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' });
    });

    const rejected = await client
      .callTool({ name, arguments: args })
      .then((result) => (result as TextResult).isError === true)
      .catch(() => true);
    await close();

    expect(rejected).toBe(true);
    expect(seen).toEqual([]);
  });

  it('passes option values after validation and paths after --', async () => {
    const seen: (readonly string[])[] = [];
    const { client, close } = await connect((args) => {
      seen.push(args);
      return Promise.resolve({ code: 0, stdout: 'ok', stderr: '' });
    });

    await call(client, 'change_report', { base: 'origin/main' });
    await call(client, 'impact', { target: 'src/a.ts', depth: 3 });
    await call(client, 'hotspots', { limit: 5, since: '2025-01-01' });
    await close();

    expect(seen).toEqual([
      ['report', '--base', 'origin/main'],
      ['impact', '--no-save', '--depth', '3', '--', 'src/a.ts'],
      ['hotspots', '--limit', '5', '--since', '2025-01-01'],
    ]);
  });

  it('returns progress messages only when a command fails', async () => {
    let code = 0;
    const { client, close } = await connect(() =>
      Promise.resolve({ code, stdout: 'answer', stderr: 'Indexing new commits…' }),
    );

    const ok = await call(client, 'dead_intent', {});
    code = 1;
    const failed = await call(client, 'dead_intent', {});
    await close();

    expect(ok).toEqual({ isError: false, text: 'answer' });
    expect(failed.isError).toBe(true);
    expect(failed.text).toContain('Indexing new commits…');
  });

  it('runs one command at a time, after the first index', async () => {
    let running = 0;
    let most = 0;
    const order: string[] = [];
    let finishIndex = (): void => undefined;
    const ready = new Promise<void>((resolve) => {
      finishIndex = () => {
        order.push('indexed');
        resolve();
      };
    });
    const { client, close } = await connect(async (args) => {
      running += 1;
      most = Math.max(most, running);
      order.push(args[0] ?? '');
      await new Promise((resolve) => setTimeout(resolve, 10));
      running -= 1;
      return { code: 0, stdout: 'ok', stderr: '' };
    }, ready);

    const calls = Promise.all([
      call(client, 'hotspots', { limit: 5 }),
      call(client, 'dead_intent', {}),
      call(client, 'symbols', { path: 'src/a.ts' }),
    ]);
    setTimeout(finishIndex, 20);
    await calls;
    await close();

    expect(most).toBe(1);
    expect(order[0]).toBe('indexed');
    expect(order).toHaveLength(4);
  });

  it('cuts very long answers and says so', async () => {
    const { client, close } = await connect(() =>
      Promise.resolve({ code: 0, stdout: 'x'.repeat(200_000), stderr: '' }),
    );

    const result = await call(client, 'hotspots', {});
    await close();

    expect(result.text.length).toBeLessThan(61_000);
    expect(result.text).toContain('ask a narrower question');
  });
});
