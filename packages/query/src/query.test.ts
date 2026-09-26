import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { linkGitHubReferences, runIndex } from '@codefossil/core';
import {
  allRelations,
  entityKey,
  findFileByPath,
  IN_MEMORY,
  listPullRequests,
  openDatabase,
  savePullRequestDetails,
  symbolsByName,
  upsertIssue,
  upsertPullRequest,
  type FossilDatabase,
} from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import type { EntityRef } from '@codefossil/shared';
import { describeEntities } from './describe.js';
import { exportGraph, graphDocumentSchema, type GraphDocument } from './export.js';
import { resolveTarget } from './resolve-target.js';
import { HISTORY_ROUTE, IMPACT_ROUTE, ORIGIN_ROUTE } from './routes.js';
import { traverse, weakestLevel, type EvidencePath } from './traverse.js';

const now = () => new Date('2026-09-26T12:00:00.000Z');

/**
 * The chain from ARCHITECTURE.md: issue #398 is resolved by PR #421, which is
 * implemented by the commit that introduced calculateVAT in src/payment/vat.ts;
 * checkout.ts imports vat.ts and api.ts imports checkout.ts.
 */
async function buildScenario(repo: FixtureRepo, fossil: FossilDatabase) {
  await repo.write('src/payment/vat.ts', 'export const RATE = 0.21;\n');
  await repo.write(
    'src/checkout.ts',
    "import { RATE } from './payment/vat.js';\nexport const total = RATE;\n",
  );
  await repo.write(
    'src/api.ts',
    "import { total } from './checkout.js';\nexport const get = () => total;\n",
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

describe('evidence graph queries', () => {
  let repo: FixtureRepo | undefined;
  let fossil: FossilDatabase;
  let scenario: Awaited<ReturnType<typeof buildScenario>>;

  beforeAll(async () => {
    repo = await createFixtureRepo();
    fossil = openDatabase(IN_MEMORY);
    scenario = await buildScenario(repo, fossil);
  });

  afterAll(async () => {
    fossil.close();
    await repo?.cleanup();
  });

  const symbol = (name: string): EntityRef => {
    const [row] = symbolsByName(fossil.db, scenario.repositoryId, name);
    if (!row) throw new Error(`symbol ${name} not indexed`);
    return { type: 'symbol', id: row.id };
  };
  const file = (path: string): EntityRef => {
    const row = findFileByPath(fossil.db, scenario.repositoryId, path);
    if (!row) throw new Error(`${path} not indexed`);
    return { type: 'file', id: row.id };
  };
  const labels = (path: EvidencePath) => {
    const described = describeEntities(fossil.db, path.nodes);
    return path.nodes.map((node) => described.get(entityKey(node))?.label);
  };

  it('follows the origin chain from symbol to the issue that motivated it', () => {
    const result = traverse(fossil.db, scenario.repositoryId, symbol('calculateVAT'), ORIGIN_ROUTE);

    expect(result.truncated).toEqual([]);
    const [strongest] = result.paths;
    expect(strongest && labels(strongest)).toEqual([
      'function calculateVAT (src/payment/vat.ts:2)',
      `${scenario.implementation.slice(0, 7)} Add calculateVAT`,
      'PR #421 Calculate VAT',
      '#398 VAT missing on invoices',
    ]);
    expect(strongest?.edges.map((e) => `${e.relation}:${e.direction}`)).toEqual([
      'INTRODUCED_BY:out',
      'IMPLEMENTED_BY:in',
      'RESOLVED_BY:in',
    ]);
    // INTRODUCED_BY (1, DERIVED) × IMPLEMENTED_BY (1, FACT) × RESOLVED_BY (0.9, DERIVED)
    expect(strongest?.confidence).toBeCloseTo(0.9);
    expect(strongest?.level).toBe('DERIVED');
    expect(strongest?.edges.every((e) => e.provenance.evidenceIds.length > 0)).toBe(true);
  });

  it('lists every change to a symbol with its context', () => {
    const result = traverse(
      fossil.db,
      scenario.repositoryId,
      symbol('calculateVAT'),
      HISTORY_ROUTE,
    );
    const commits = new Set(result.paths.map((p) => p.nodes[1] && entityKey(p.nodes[1])));
    expect(commits.size).toBe(2);
    const rounding = result.paths.find((p) => labels(p)[1]?.includes('Round VAT'));
    expect(rounding?.nodes).toHaveLength(2); // no PR behind a direct commit
  });

  it('finds direct and transitive dependents for impact analysis', () => {
    const result = traverse(fossil.db, scenario.repositoryId, symbol('calculateVAT'), IMPACT_ROUTE);
    expect(result.paths.map(labels)).toEqual([
      [
        'function calculateVAT (src/payment/vat.ts:2)',
        'src/payment/vat.ts',
        'src/checkout.ts',
        'src/api.ts',
      ],
    ]);
  });

  it('never loops on import cycles', () => {
    const result = traverse(fossil.db, scenario.repositoryId, file('src/a.ts'), IMPACT_ROUTE);
    expect(result.paths.map(labels)).toEqual([['src/a.ts', 'src/b.ts']]);
  });

  it('reports what its bounds cut off', () => {
    const narrow = traverse(
      fossil.db,
      scenario.repositoryId,
      file('src/payment/vat.ts'),
      HISTORY_ROUTE,
      {
        maxFanOut: 1,
      },
    );
    expect(narrow.truncated[0]).toMatch(/MODIFIES \(in\) from file:\d+: followed 1 of 3/);

    const shallow = traverse(
      fossil.db,
      scenario.repositoryId,
      symbol('calculateVAT'),
      ORIGIN_ROUTE,
      {
        maxDepth: 1,
      },
    );
    expect(shallow.truncated).toContain('stopped at depth 1');
    expect(shallow.paths[0]?.nodes).toHaveLength(2);
  });

  it('resolves user input to entities, and reports ambiguity instead of guessing', () => {
    const one = (input: string) => resolveTarget(fossil.db, scenario.repositoryId, input);
    expect(one('#398').map((m) => m.label)).toEqual(['#398 VAT missing on invoices']);
    expect(one('GH-421').map((m) => m.label)).toEqual(['PR #421 Calculate VAT']);
    expect(one('calculateVAT').map((m) => m.how)).toEqual(['symbol name']);
    expect(one('src/payment/vat.ts').map((m) => m.how)).toEqual(['file path']);
    expect(one('src\\payment\\vat.ts').map((m) => m.how)).toEqual(['file path']);
    expect(one(scenario.rounding.slice(0, 8)).map((m) => m.label)).toEqual([
      `${scenario.rounding.slice(0, 7)} Round VAT`,
    ]);
    expect(
      one('helper')
        .map((m) => m.label)
        .sort(),
    ).toEqual(['function helper (src/a.ts:2)', 'function helper (src/b.ts:2)']);
    expect(one('src/a.ts:helper').map((m) => m.label)).toEqual(['function helper (src/a.ts:2)']);
    expect(one('#9999')).toEqual([]);
    expect(one('nothingLikeThis')).toEqual([]);
  });

  it('exports the whole graph as a valid, self-contained document', () => {
    const document = exportGraph(fossil.db, scenario.repositoryId, {
      repository: { name: 'shop', path: repo?.root ?? '' },
      now,
    });
    expect(graphDocumentSchema.safeParse(document).success).toBe(true);
    expect(document.edges).toHaveLength(allRelations(fossil.db, scenario.repositoryId).length);
    const nodeIds = new Set(document.nodes.map((n) => n.id));
    expect(document.edges.every((e) => nodeIds.has(e.source) && nodeIds.has(e.target))).toBe(true);
    const evidenceIds = new Set(document.evidence.map((e) => e.id));
    expect(
      document.edges.every((e) => e.provenance.evidenceIds.every((id) => evidenceIds.has(id))),
    ).toBe(true);
    expect(
      document.nodes.find((n) => n.label === '#398 VAT missing on invoices')?.attributes,
    ).toMatchObject({
      number: 398,
      state: 'closed',
    });
  });

  it('exports the neighbourhood of a root, bounded by depth and size', () => {
    const root = symbol('calculateVAT');
    const near = exportGraph(fossil.db, scenario.repositoryId, {
      repository: { name: 'shop', path: '' },
      root,
      depth: 1,
      now,
    });
    expect(near.scope).toEqual({ root: entityKey(root), depth: 1, truncated: [] });
    // Every node is the root or one hop from it…
    const adjacent = new Set(
      near.edges.flatMap((e) =>
        e.source === entityKey(root) || e.target === entityKey(root) ? [e.source, e.target] : [],
      ),
    );
    expect(near.nodes.every((n) => adjacent.has(n.id) || n.id === entityKey(root))).toBe(true);
    // …and every relation between exported nodes is included (an induced subgraph).
    expect(induced(near)).toBe(true);

    const capped = exportGraph(fossil.db, scenario.repositoryId, {
      repository: { name: 'shop', path: '' },
      root,
      depth: 5,
      maxNodes: 3,
      now,
    });
    expect(capped.nodes.length).toBeLessThanOrEqual(3);
    expect(capped.scope.truncated).toEqual(['stopped at 3 nodes']);
    expect(induced(capped)).toBe(true);
    expect(listPullRequests(fossil.db, scenario.repositoryId)).toHaveLength(1);
  });

  /** Whether the document holds every stored relation between its nodes. */
  const induced = (document: GraphDocument): boolean => {
    const ids = new Set(document.nodes.map((n) => n.id));
    const exported = new Set(document.edges.map((e) => e.id));
    return allRelations(fossil.db, scenario.repositoryId)
      .filter(
        (r) => ids.has(`${r.sourceType}:${r.sourceId}`) && ids.has(`${r.targetType}:${r.targetId}`),
      )
      .every((r) => exported.has(`relation:${r.id}`));
  };

  it('reports truncation only where something was actually cut', () => {
    // The origin chain ends at the issue: a generous depth reports nothing.
    const complete = traverse(
      fossil.db,
      scenario.repositoryId,
      symbol('calculateVAT'),
      ORIGIN_ROUTE,
      {
        maxDepth: 3,
      },
    );
    expect(complete.truncated).toEqual([]);

    // The 0.9 resolution link falls below a 0.95 floor, and that is said.
    const floored = traverse(
      fossil.db,
      scenario.repositoryId,
      symbol('calculateVAT'),
      ORIGIN_ROUTE,
      {
        minConfidence: 0.95,
      },
    );
    expect(floored.truncated).toEqual(['links below confidence 0.95 were not followed']);
    expect(floored.paths[0]?.nodes).toHaveLength(3);
  });
});

describe('weakestLevel', () => {
  it('ranks FACT < DERIVED < INFERRED', () => {
    expect(weakestLevel(['FACT', 'FACT'])).toBe('FACT');
    expect(weakestLevel(['FACT', 'DERIVED'])).toBe('DERIVED');
    expect(weakestLevel(['DERIVED', 'INFERRED', 'FACT'])).toBe('INFERRED');
    expect(weakestLevel([])).toBe('FACT');
  });
});
