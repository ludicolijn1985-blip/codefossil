import { linkGitHubReferences, runIndex } from '@codefossil/core';
import {
  savePullRequestDetails,
  upsertIssue,
  upsertPullRequest,
  type FossilDatabase,
} from '@codefossil/db';
import type { FixtureRepo } from '@codefossil/git/testing';

export const now = () => new Date('2026-09-26T12:00:00.000Z');

/**
 * The chain from ARCHITECTURE.md: issue #398 is resolved by PR #421, which is
 * implemented by the commit that introduced calculateVAT in src/payment/vat.ts;
 * checkout.ts imports vat.ts and api.ts imports checkout.ts.
 */
export async function buildScenario(repo: FixtureRepo, fossil: FossilDatabase) {
  await repo.write('src/payment/vat.ts', 'export const RATE = 0.21;\n');
  await repo.write(
    'src/checkout.ts',
    "import { RATE } from './payment/vat.js';\nexport const total = RATE;\n",
  );
  await repo.write(
    'src/api.ts',
    "import { total } from './checkout.js';\nimport { z } from 'zod';\nexport const get = () => total;\n",
  );
  await repo.write(
    'src/checkout.test.ts',
    "import { total } from './checkout.js';\ntest(total);\n",
  );
  await repo.write(
    'package.json',
    JSON.stringify({ name: 'shop', dependencies: { zod: '^4.0.0' } }),
  );
  await repo.write('src/a.ts', "import './b.js';\nexport function helper() {}\n");
  await repo.write('src/b.ts', "import './a.js';\nexport function helper() {}\n");
  await repo.commit('Add payment module');
  await repo.git('checkout', '-q', '-b', 'feature');
  await repo.write(
    'src/payment/vat.ts',
    'export const RATE = 0.21;\nexport function calculateVAT(n: number) {\n  return n * RATE;\n}\n',
  );
  const implementation = await repo.commit('Add calculateVAT');
  await repo.git('checkout', '-q', 'main');
  const merge = await repo.merge('feature', 'Merge pull request #421 from acme/feature');
  await repo.write(
    'src/payment/vat.ts',
    'export const RATE = 0.21;\nexport function calculateVAT(n: number) {\n  return Math.round(n * RATE);\n}\n',
  );
  const rounding = await repo.commit('Round VAT');

  const { repositoryId } = await runIndex(fossil.db, repo.root, { now });
  const common = {
    repositoryId,
    provider: 'github',
    state: 'closed',
    author: 'ada',
    labels: ['bug'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-02T00:00:00.000Z',
    closedAt: '2026-01-02T00:00:00.000Z',
  };
  upsertIssue(fossil.db, {
    ...common,
    number: 398,
    title: 'VAT missing on invoices',
    body: '',
    url: 'https://github.com/acme/shop/issues/398',
  });
  const pr = upsertPullRequest(fossil.db, {
    ...common,
    number: 421,
    title: 'Calculate VAT',
    body: 'Resolves #398',
    url: 'https://github.com/acme/shop/pull/421',
    mergedAt: '2026-01-02T00:00:00.000Z',
  });
  savePullRequestDetails(
    fossil.db,
    pr,
    {
      mergeCommitSha: merge,
      mergedAt: '2026-01-02T00:00:00.000Z',
      baseBranch: 'main',
      headBranch: 'feature',
      commitShas: [implementation],
      reviews: [],
    },
    now().toISOString(),
  );
  linkGitHubReferences(
    fossil.db,
    repositoryId,
    { owner: 'acme', name: 'shop' },
    now().toISOString(),
  );
  return { repositoryId, implementation, merge, rounding };
}
