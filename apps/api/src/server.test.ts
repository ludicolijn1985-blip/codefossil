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
import { AiProviderError, type AiProvider } from '@codefossil/ai';
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
      const status = await call({ method: 'GET', url: repo('/status') });
      const head = (status.body.data as { head: { freshness: string; indexedSha: string } }).head;
      expect(head.freshness).toBe('current');
      expect(head.indexedSha).toMatch(/^[0-9a-f]{40}$/);
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

    it('searches files and lists recent commits and dependencies', async () => {
      const files = await call({ method: 'GET', url: repo('/files?query=vat') });
      expect((files.body.data as { path: string }[]).map((f) => f.path)).toEqual([
        'src/tax/vat.ts',
        'src/payment/vat.ts',
      ]);
      const commits = await call({ method: 'GET', url: repo('/commits?limit=2') });
      expect((commits.body.data as { subject: string }[]).map((c) => c.subject)).toEqual([
        'Second calculateVAT',
        'Merge branch feature/logo',
      ]);
      expect(await call({ method: 'GET', url: repo('/dependencies') })).toMatchObject({
        status: 200,
        body: { data: [] },
      });
      expect(await call({ method: 'GET', url: repo('/commits?limit=0') })).toMatchObject({
        status: 400,
      });
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

  describe('AI layer', () => {
    const fakeAi = (fail = false): AiProvider => ({
      name: 'ollama',
      model: 'fake-1',
      cloud: false,
      complete(request) {
        if (fail) return Promise.reject(new AiProviderError('Ollama is not reachable.'));
        const id = Number(/"id": (\d+)/.exec(request.prompt)?.[1]);
        const output = request.schema.parse({
          answer: 'Legacy invoices.',
          unanswerable: false,
          claims: [{ text: 'Legacy invoices needed it.', evidenceIds: [id], confidence: 0.8 }],
          caveats: [],
        });
        return Promise.resolve({ output, model: 'fake-1' });
      },
    });
    const config = {
      provider: 'ollama' as const,
      model: 'fake-1',
      allowCloud: false,
      includeSource: false,
    };

    async function withAi(provider: AiProvider, test: (ai: FastifyInstance) => Promise<void>) {
      const ai = await buildServer({ fossil, allowNetwork: false, now, ai: { config, provider } });
      try {
        await test(ai);
      } finally {
        await ai.close();
      }
    }
    const post = (server: FastifyInstance, url: string, body: unknown) =>
      server.inject({
        method: 'POST',
        url,
        headers: { host: 'localhost:4000', 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });

    it('reports itself off and refuses AI requests when not configured', async () => {
      expect((await call({ method: 'GET', url: '/api/ai' })).body.data).toEqual({ enabled: false });
      expect(
        await call({ method: 'POST', url: repo('/ask'), body: { question: 'Why legacy?' } }),
      ).toMatchObject({ status: 409, body: { error: { code: 'ai_disabled' } } });
    });

    it('answers from gathered evidence and summarizes investigations', async () => {
      await withAi(fakeAi(), async (ai) => {
        const status = await ai.inject({
          method: 'GET',
          url: '/api/ai',
          headers: { host: 'localhost:4000' },
        });
        expect(status.json()).toEqual({
          data: {
            enabled: true,
            provider: 'ollama',
            model: 'fake-1',
            cloud: false,
            includeSource: false,
          },
        });
        const asked = await post(ai, repo('/ask'), {
          question: 'Why the legacy invoices workaround?',
        });
        expect(asked.json()).toMatchObject({
          data: { kind: 'ai', classification: 'INFERRED', confidence: 0.6, rejectedClaims: 0 },
        });
        const nothing = await post(ai, repo('/ask'), { question: 'quantum teleportation?' });
        expect(nothing.json()).toMatchObject({ error: { code: 'no_related_evidence' } });
        const summary = await post(ai, repo('/summarize'), { target: 'src/tax/vat.ts' });
        expect(summary.json()).toMatchObject({
          data: { why: { kind: 'why' }, summary: { kind: 'ai', classification: 'INFERRED' } },
        });
        expect((await post(ai, repo('/ask'), { question: '' })).statusCode).toBe(400);
        expect((await post(ai, repo('/ask'), { question: 'x', model: 'other' })).statusCode).toBe(
          400,
        );
      });
    });

    it('reports provider failures as a bad gateway, and limits AI requests per client', async () => {
      await withAi(fakeAi(true), async (ai) => {
        const failed = await post(ai, repo('/ask'), { question: 'Why the legacy invoices?' });
        expect(failed.statusCode).toBe(502);
        expect(failed.json()).toMatchObject({ error: { code: 'ai_provider_error' } });
        const statuses: number[] = [];
        for (let i = 0; i < 12; i++) {
          statuses.push(
            (await post(ai, repo('/ask'), { question: 'Why the legacy invoices?' })).statusCode,
          );
        }
        expect(statuses).toContain(429);
      });
    });
  });

  describe('risk analysis', () => {
    it('serves hotspots with their components, validating the options', async () => {
      const report = await call({ method: 'GET', url: repo('/hotspots?limit=1&order=risk') });
      expect(report.status).toBe(200);
      expect(report.body.data).toMatchObject({ orderBy: 'risk', since: null });
      const [hotspot] = (report.body.data as { hotspots: { risk: { components: object } }[] })
        .hotspots;
      expect(Object.keys(hotspot?.risk.components ?? {})).toEqual([
        'changeFrequency',
        'dependencyCentrality',
        'bugDensity',
        'testReachInverse',
      ]);
      const since = await call({ method: 'GET', url: repo('/hotspots?since=2999-01-01') });
      expect(since.body.data).toMatchObject({ since: '2999-01-01T00:00:00.000Z', hotspots: [] });
      for (const bad of ['limit=0', 'order=size', 'tests=yes', 'since=soon', 'extra=1']) {
        expect((await call({ method: 'GET', url: repo(`/hotspots?${bad}`) })).status).toBe(400);
      }
    });

    it('serves dead-intent candidates, always as inferences', async () => {
      const report = await call({ method: 'GET', url: repo('/dead-intent') });
      const { candidates } = report.body.data as {
        candidates: { target: { label: string }; classification: string }[];
      };
      expect(candidates.map((c) => c.target.label)).toEqual([
        expect.stringMatching(/^\w+ calculateVAT \(src\/tax\/vat\.ts:1\)$/),
      ]);
      expect(new Set(candidates.map((c) => c.classification))).toEqual(new Set(['INFERRED']));
      expect((await call({ method: 'GET', url: repo('/dead-intent?staleDays=0') })).status).toBe(
        400,
      );
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
      const id = (byQuestion.body.data as { investigationId: number }).investigationId;
      expect(await call({ method: 'GET', url: repo(`/investigations/${id}`) })).toMatchObject({
        status: 200,
        body: { data: { id, kind: 'why' } },
      });
      expect(await call({ method: 'GET', url: repo('/investigations/9999') })).toMatchObject({
        status: 404,
      });
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
