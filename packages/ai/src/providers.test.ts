import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { anthropicProvider } from './anthropic.js';
import { modelAnswerSchema } from './answer.js';
import { ollamaProvider } from './ollama.js';
import { AiProviderError } from './provider.js';

interface Captured {
  readonly url: string;
  readonly headers: IncomingMessage['headers'];
  readonly body: Record<string, unknown>;
}

const reply = {
  answer: 'Because of legacy invoices.',
  unanswerable: false,
  claims: [{ text: 'Legacy invoices.', evidenceIds: [1], confidence: 0.5 }],
  caveats: [],
};

let server: Server | undefined;

/** A local stand-in for the provider: records the request, answers with `respond`. */
async function fake(respond: (captured: Captured) => { status?: number; body: unknown }): Promise<{
  url: string;
  requests: Captured[];
}> {
  const requests: Captured[] = [];
  server = createServer((req, res) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString()));
    req.on('end', () => {
      const captured = {
        url: req.url ?? '',
        headers: req.headers,
        body: JSON.parse(data) as Record<string, unknown>,
      };
      requests.push(captured);
      const { status = 200, body } = respond(captured);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, requests };
}

afterEach(async () => {
  await new Promise<void>((resolve) => {
    if (server)
      server.close(() => {
        resolve();
      });
    else resolve();
  });
  server = undefined;
});

const request = { system: 'sys', prompt: 'prompt', schema: modelAnswerSchema };

describe('ollama provider', () => {
  it('asks for JSON matching the schema and validates the reply', async () => {
    const { url, requests } = await fake(() => ({
      body: {
        model: 'llama3.1',
        message: { role: 'assistant', content: JSON.stringify(reply) },
        done_reason: 'stop',
      },
    }));
    const provider = ollamaProvider({ model: 'llama3.1', baseUrl: url, cloud: false });
    const completion = await provider.complete(request);
    expect(completion).toEqual({ output: reply, model: 'llama3.1' });
    const [sent] = requests;
    expect(sent?.url).toBe('/api/chat');
    expect(sent?.body).toMatchObject({
      model: 'llama3.1',
      stream: false,
      format: { type: 'object' },
    });
    expect(sent?.body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'prompt' },
    ]);
  });

  it('refuses a reply outside the schema, errors and unreachable servers', async () => {
    const { url } = await fake(({ body }) =>
      body.model === 'broken'
        ? { status: 500, body: { error: 'model not found' } }
        : { body: { model: 'x', message: { content: '{"answer": 3}' } } },
    );
    await expect(
      ollamaProvider({ model: 'x', baseUrl: url, cloud: false }).complete(request),
    ).rejects.toThrow('required structure');
    await expect(
      ollamaProvider({ model: 'broken', baseUrl: url, cloud: false }).complete(request),
    ).rejects.toThrow(/answered 500/);
    await expect(
      ollamaProvider({ model: 'x', baseUrl: 'http://127.0.0.1:1', cloud: false }).complete(request),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});

const message = (stopReason: string, text: string) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [{ type: 'text', text }],
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 10 },
});

describe('anthropic provider', () => {
  it('sends a structured-output request with server-side refusal fallbacks', async () => {
    const { url, requests } = await fake(() => ({
      body: message('end_turn', JSON.stringify(reply)),
    }));
    const provider = anthropicProvider({
      model: 'claude-opus-5',
      baseURL: url,
      apiKey: 'test-key',
    });
    expect(provider.cloud).toBe(true);
    expect(await provider.complete(request)).toEqual({ output: reply, model: 'claude-opus-5' });
    const [sent] = requests;
    expect(sent?.url).toMatch(/^\/v1\/messages/);
    expect(sent?.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(sent?.body).toMatchObject({
      model: 'claude-opus-5',
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      system: 'sys',
      messages: [{ role: 'user', content: 'prompt' }],
      output_config: { format: { type: 'json_schema' } },
    });
  });

  it('reports refusals, truncation and API errors instead of answering', async () => {
    const { url } = await fake(({ body }) => {
      if (body.model === 'refuses') return { body: message('refusal', '') };
      if (body.model === 'truncates') return { body: message('max_tokens', '{"answer": "') };
      return {
        status: 401,
        body: { type: 'error', error: { type: 'authentication_error', message: 'bad key' } },
      };
    });
    const make = (model: string) => anthropicProvider({ model, baseURL: url, apiKey: 'test-key' });
    await expect(make('refuses').complete(request)).rejects.toThrow('declined');
    await expect(make('truncates').complete(request)).rejects.toThrow(AiProviderError);
    await expect(make('unauthorized').complete(request)).rejects.toThrow('ANTHROPIC_API_KEY');
  });
});
