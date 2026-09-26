import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runIndex } from '@codefossil/core';
import { findFileByPath, IN_MEMORY, openDatabase, type FossilDatabase } from '@codefossil/db';
import { createSampleHistory, type SampleHistory } from '@codefossil/git/testing';
import { graphDocumentSchema } from '@codefossil/query';
import { GitHubClient } from '@codefossil/providers';
import { startFakeGitHub } from '@codefossil/providers/testing';
import { buildServer } from './server.js';

const now = () => new Date('2026-09-26T12:00:00.000Z');

interface Envelope {
  data?: unknown;
  error?: { code: string; message: string; details?: unknown };
}

describe('CODEFOSSIL API', () => {
  let sample: SampleHistory | undefined;
  let fossil: FossilDatabase;
  let app: FastifyInstance;
  let repositoryId: number;

  beforeAll(async () => {
    sample = await createSampleHistory();
    await sample.repo.write('src/tax/helpers.ts', 'export function calculateVAT() {}\n');
    await sample.repo.commit('Second calculateVAT');
    fossil = openDatabase(IN_MEMORY);
    repositoryId = (await runIndex(fossil.db, sample.repo.root, { now })).repositoryId;
    app = await buildServer({ fossil, allowNetwork: false, now });
  });

  afterAll(async () => {
    await app.close();
    fossil.close();
    await sample?.repo.cleanup();
  });

  async function call(options: InjectOptions & { body?: unknown }) {
    const { body, ...rest } = options;
    const response = await app.inject({
      headers: {
        host: 'localhost:4000',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...rest.headers,
      },
      ...rest,
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
    return { status: response.statusCode, body: response.json<Envelope>() };
  }
  const repo = (path = '') => `/api/repositories/${repositoryId}${path}`;

  it('reports health', async () => {
    expect(await call({ method: 'GET', url: '/health' })).toEqual({
      status: 200,
      body: { data: { status: 'ok', version: '0.1.0' } },
    });
  });

  describe('local-only protections', () => {
    it('rejects requests addressed to another host (DNS rebinding)', async () => {
      const result = await call({
        method: 'GET',
        url: '/health',
        headers: { host: 'evil.example:4000' },
      });
      expect(result).toMatchObject({ status: 403, body: { error: { code: 'forbidden_host' } } });
    });

    it('rejects state-changing requests that are not JSON (cross-site forms)', async () => {
      for (const type of [
        'text/plain',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
      ]) {
        const response = await app.inject({
          method: 'POST',
          url: repo('/index'),
          headers: { host: 'localhost', 'content-type': type },
          payload: 'x=1',
        });
        expect(response.statusCode).toBe(415);
      }
    });

    it('limits the request rate', async () => {
      const limited = await buildServer({ fossil, allowNetwork: false, rateLimitPerMinute: 2 });
      try {
        const codes: number[] = [];
        for (let i = 0; i < 3; i++) {
          codes.push(
            (
              await limited.inject({
                method: 'GET',
                url: '/health',
                headers: { host: 'localhost' },
              })
            ).statusCode,
          );
        }
        expect(codes).toEqual([200, 200, 429]);
      } finally {
        await limited.close();
      }
    });
  });

  describe('validation and errors', () => {
    it('validates params, queries and bodies', async () => {
      expect(await call({ method: 'GET', url: '/api/repositories/abc' })).toMatchObject({
        status: 400,
        body: { error: { code: 'validation_error', details: [{ path: 'id' }] } },
      });
      expect(await call({ method: 'GET', url: repo('/timeline') })).toMatchObject({
        status: 400,
        body: { error: { code: 'validation_error' } },
      });
      expect(
        await call({ method: 'POST', url: repo('/index'), body: { unexpected: true } }),
      ).toMatchObject({
        status: 400,
      });
    });

    it('answers unknown resources and routes with a 404 envelope', async () => {
      expect(await call({ method: 'GET', url: '/api/repositories/999' })).toMatchObject({
        status: 404,
        body: { error: { code: 'not_found' } },
      });
      expect(await call({ method: 'GET', url: '/nope' })).toMatchObject({
        status: 404,
        body: { error: { code: 'not_found' } },
      });
    });
  });

  describe('repositories', () => {
    it('lists and describes repositories with their index status', async () => {
      const list = await call({ method: 'GET', url: '/api/repositories' });
      expect(list.body.data).toHaveLength(1);
      expect(list.body.data).toMatchObject([{ id: repositoryId }]);
      const one = await call({ method: 'GET', url: repo() });
      expect(one.body.data).toMatchObject({ status: { counts: { commits: 7 } }, github: null });
    });

    it('registers only absolute paths inside a Git repository', async () => {
      expect(
        await call({ method: 'POST', url: '/api/repositories', body: { path: 'relative/path' } }),
      ).toMatchObject({
        status: 400,
      });
      const plain = await mkdtemp(join(tmpdir(), 'codefossil-api-'));
      try {
        expect(
          await call({ method: 'POST', url: '/api/repositories', body: { path: plain } }),
        ).toMatchObject({
          status: 422,
          body: { error: { code: 'not_a_repository' } },
        });
      } finally {
        await rm(plain, { recursive: true, force: true });
      }
      const again = await call({
        method: 'POST',
        url: '/api/repositories',
        body: { path: sample?.repo.root },
      });
      expect(again).toMatchObject({ status: 201, body: { data: { id: repositoryId } } });
    });

    it('indexes offline, refuses network sync when disabled, and runs one index at a time', async () => {
      const network = await call({ method: 'POST', url: repo('/index'), body: { github: true } });
      expect(network).toMatchObject({ status: 403, body: { error: { code: 'network_disabled' } } });

      const [first, second] = await Promise.all([
        call({ method: 'POST', url: repo('/index'), body: {} }),
        call({ method: 'POST', url: repo('/index'), body: {} }),
      ]);
      expect([first.status, second.status].sort()).toEqual([200, 409]);
      const done = first.status === 200 ? first : second;
      expect(done.body.data).toMatchObject({ commitsIndexed: 0, commitsSkipped: 7 });
    });
  });

  describe('exploration', () => {
    it('serves a timeline, file details and symbol details', async () => {
      const timeline = await call({ method: 'GET', url: repo('/timeline?path=src/tax/vat.ts') });
      expect(timeline.body.data).toMatchObject({ paths: ['src/tax/vat.ts', 'src/payment/vat.ts'] });
      expect(await call({ method: 'GET', url: repo('/timeline?path=missing.ts') })).toMatchObject({
        status: 404,
      });

      const fileId = findFileByPath(fossil.db, repositoryId, 'src/tax/vat.ts')?.id ?? 0;
      const file = await call({ method: 'GET', url: repo(`/files/${fileId}`) });
      expect(file.body.data).toMatchObject({
        file: { path: 'src/tax/vat.ts' },
        symbols: [{ stableKey: 'function:calculateVAT' }],
        imports: [],
        importedBy: [],
      });
      const symbolId = (file.body.data as { symbols: { id: number }[] }).symbols[0]?.id ?? 0;
      const symbol = await call({ method: 'GET', url: repo(`/symbols/${symbolId}`) });
      expect(symbol.body.data).toMatchObject({
        symbol: { name: 'calculateVAT' },
        why: { kind: 'why' },
      });
      expect(await call({ method: 'GET', url: repo('/symbols/999999') })).toMatchObject({
        status: 404,
      });
    });

    it('serves graphs, and lists candidates for an ambiguous root', async () => {
      const graph = await call({ method: 'GET', url: repo('/graph?root=src/tax/vat.ts&depth=1') });
      expect(graphDocumentSchema.safeParse(graph.body.data).success).toBe(true);

      const ambiguous = await call({ method: 'GET', url: repo('/graph?root=calculateVAT') });
      expect(ambiguous).toMatchObject({
        status: 409,
        body: { error: { code: 'ambiguous_target' } },
      });
      expect((ambiguous.body.error?.details as { candidates: unknown[] }).candidates).toHaveLength(
        2,
      );

      const whole = await call({ method: 'GET', url: repo('/graph') });
      expect(graphDocumentSchema.parse(whole.body.data).scope.root).toBeNull();
    });

    it('serves impact reports', async () => {
      const impact = await call({ method: 'GET', url: repo('/impact?target=src/tax/vat.ts') });
      expect(impact.body.data).toMatchObject({ kind: 'impact', direct: [], transitive: [] });
      expect(await call({ method: 'GET', url: repo('/impact?target=nothing') })).toMatchObject({
        status: 404,
        body: { error: { code: 'target_not_found' } },
      });
    });
  });

  describe('investigations', () => {
    it('answers questions and targets, saving unless told not to', async () => {
      const byQuestion = await call({
        method: 'POST',
        url: repo('/investigate'),
        body: { question: 'Why does src/tax/vat.ts exist?' },
      });
      expect(byQuestion.body.data).toMatchObject({
        kind: 'why',
        result: { classification: 'FACT', target: { label: 'src/tax/vat.ts' } },
      });
      expect(typeof (byQuestion.body.data as { investigationId: unknown }).investigationId).toBe(
        'number',
      );

      const byTarget = await call({
        method: 'POST',
        url: repo('/investigate'),
        body: { target: 'src/tax/vat.ts', kind: 'impact', save: false },
      });
      expect(byTarget.body.data).toMatchObject({ kind: 'impact', investigationId: null });

      const saved = await call({ method: 'GET', url: repo('/investigations') });
      expect(saved.body.data).toHaveLength(1);
    });

    it('declines unsupported questions and reports ambiguous subjects', async () => {
      expect(
        await call({
          method: 'POST',
          url: repo('/query'),
          body: { question: 'Summarize everything' },
        }),
      ).toMatchObject({ status: 422, body: { error: { code: 'unsupported_question' } } });
      expect(
        await call({
          method: 'POST',
          url: repo('/query'),
          body: { question: 'why does calculateVAT exist?' },
        }),
      ).toMatchObject({ status: 409, body: { error: { code: 'ambiguous_target' } } });
    });

    it('never lets a rewritten connection receive the token the server was started with', async () => {
      const github = await startFakeGitHub((url) =>
        url.pathname.endsWith('/issues') ? { body: [] } : undefined,
      );
      const trusted = github.apiUrl;
      const networked = await buildServer({
        fossil,
        allowNetwork: true,
        now,
        github: {
          apiUrl: trusted,
          client: (conn) =>
            conn.apiUrl === trusted
              ? new GitHubClient({ apiUrl: trusted, token: 'secret', maxRequests: 10 })
              : null,
        },
      });
      const post = async (url: string, body: unknown) => {
        const response = await networked.inject({
          method: 'POST',
          url,
          headers: { host: 'localhost', 'content-type': 'application/json' },
          payload: JSON.stringify(body),
        });
        return { status: response.statusCode, body: response.json<Envelope>() };
      };
      try {
        // Connected to the trusted API: the sync runs.
        await post(repo('/providers/github/connect'), {
          owner: 'acme',
          name: 'shop',
          apiUrl: trusted,
        });
        const synced = await post(repo('/index'), { github: true });
        expect(synced.status).toBe(200);
        expect(github.requests.length).toBeGreaterThan(0);

        // Rewritten to another host: refused before anything is contacted.
        github.clearRequests();
        await post(repo('/providers/github/connect'), {
          owner: 'acme',
          name: 'shop',
          apiUrl: 'https://attacker.example',
        });
        const refused = await post(repo('/index'), { github: true });
        expect(refused).toMatchObject({
          status: 403,
          body: { error: { code: 'connection_changed' } },
        });
        expect(github.requests).toHaveLength(0);
      } finally {
        await networked.close();
        await github.close();
      }
    });

    it('stores a GitHub connection without contacting anything, and only over https', async () => {
      const connected = await call({
        method: 'POST',
        url: repo('/providers/github/connect'),
        body: { owner: 'acme', name: 'shop' },
      });
      expect(connected).toMatchObject({
        status: 201,
        body: { data: { owner: 'acme', apiUrl: 'https://api.github.com', verified: false } },
      });
      const insecure = await call({
        method: 'POST',
        url: repo('/providers/github/connect'),
        body: { owner: 'acme', name: 'shop', apiUrl: 'http://evil.example/api' },
      });
      expect(insecure).toMatchObject({ status: 400, body: { error: { code: 'invalid_api_url' } } });
      const badSlug = await call({
        method: 'POST',
        url: repo('/providers/github/connect'),
        body: { owner: '../etc', name: 'shop' },
      });
      expect(badSlug.status).toBe(400);
    });
  });
});
