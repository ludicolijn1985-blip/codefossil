/**
 * The API the end-to-end tests run against: a small known history, indexed
 * into an in-memory database and served on a fixed loopback port. Started by
 * Playwright as a web server; runs on Node's built-in type stripping against
 * the built workspace packages.
 */
import type { AiProvider } from '@codefossil/ai';
import { buildServer } from '@codefossil/api';
import { runIndex } from '@codefossil/core';
import { IN_MEMORY, openDatabase } from '@codefossil/db';
import { createSampleHistory } from '@codefossil/git/testing';

const FIXTURE_API_PORT = Number(process.env.FIXTURE_API_PORT ?? 4100);

const sample = await createSampleHistory();
const { repo } = sample;
await repo.write(
  'src/checkout.ts',
  "import { calculateVAT } from './tax/vat.js';\n\nexport const total = (n: number) => n + calculateVAT(n);\n",
);
await repo.write('package.json', '{ "name": "shop", "dependencies": { "zod": "^4.0.0" } }\n');
await repo.commit('Add checkout total\n\nUses the VAT calculation. Refs #12');

const fossil = openDatabase(IN_MEMORY);
await runIndex(fossil.db, repo.root, { now: () => new Date('2026-09-26T12:00:00.000Z') });
/** A stand-in model on this machine: cites the first evidence item it is shown. */
const fakeModel: AiProvider = {
  name: 'ollama',
  model: 'fixture-model',
  cloud: false,
  complete(request) {
    const id = Number(/"id": (\d+)/.exec(request.prompt)?.[1]);
    const output = request.schema.parse({
      answer: 'The evidence ties the reduced rate to legacy invoices.',
      unanswerable: false,
      claims: [
        {
          text: 'The reduced rate exists for legacy invoices.',
          evidenceIds: [id],
          confidence: 0.9,
        },
      ],
      caveats: [],
    });
    return Promise.resolve({ output, model: 'fixture-model' });
  },
};
const ai = {
  config: {
    provider: 'ollama' as const,
    model: 'fixture-model',
    allowCloud: false,
    includeSource: false,
  },
  provider: fakeModel,
};
const app = await buildServer({ fossil, allowNetwork: false, rateLimitPerMinute: 10_000, ai });
await app.listen({ host: '127.0.0.1', port: FIXTURE_API_PORT });

const stop = async () => {
  await app.close();
  fossil.close();
  await repo.cleanup();
  process.exit(0);
};
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
