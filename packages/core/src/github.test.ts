import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectProvider,
  findCommitBySha,
  findIssueByNumber,
  findPullRequestByNumber,
  IN_MEMORY,
  incomingRelations,
  openDatabase,
  outgoingRelations,
  providerCounts,
  registerRepository,
  schema,
  type FossilDatabase,
} from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { GitHubClient } from '@codefossil/providers';
import { GITHUB_CLOSING_METHOD } from '@codefossil/shared';
import { and, eq } from 'drizzle-orm';
import {
  paged,
  startFakeGitHub,
  type FakeGitHub,
  type FakeRequest,
  type FakeRoute,
} from '@codefossil/providers/testing';
import { GITHUB_LINKER_PRODUCER } from './reference-linker.js';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-09-26T12:00:00.000Z');
const TEST_MERGE_SHA = 'f'.repeat(40);

interface Shas {
  readonly fix: string;
  readonly tests: string;
  readonly merge: string;
}

async function buildHistory(repo: FixtureRepo): Promise<Shas> {
  await repo.write('src/vat.ts', 'export const vat = 0.21;\n');
  await repo.commit('Add VAT');
  await repo.git('checkout', '-q', '-b', 'feature');
  await repo.write('src/vat.ts', 'export const vat = (r = false) => (r ? 0.09 : 0.21);\n');
  const fix = await repo.commit('Handle reduced rate\n\nFixes #1');
  await repo.write('src/vat.test.ts', 'test("vat", () => {});\n');
  const tests = await repo.commit('Tests for rates (see #2)');
  await repo.git('checkout', '-q', 'main');
  const merge = await repo.merge('feature', 'Merge pull request #3 from acme/feature');
  await repo.write('src/other.ts', 'export {};\n');
  await repo.commit('Refactor, refs #99');
  return { fix, tests, merge };
}

const item = (number: number, fields: Record<string, unknown>) => ({
  number,
  title: `Item ${number}`,
  body: null,
  state: 'open',
  html_url: `https://github.com/acme/shop/issues/${number}`,
  created_at: '2026-01-01T09:00:00Z',
  updated_at: `2026-01-0${number}T10:00:00Z`,
  closed_at: null,
  user: { login: 'ada' },
  labels: [],
  ...fields,
});

/** Answer a closing-references GraphQL query: `closing` maps a PR number to its issues. */
function closingRefs(closing: Record<number, readonly (readonly [string, number])[]>): FakeRoute {
  return (_url, request: FakeRequest) => {
    const { query } = JSON.parse(request.body) as { query: string };
    const repository: Record<string, unknown> = {};
    for (const [, number] of query.matchAll(/pr(\d+):/g)) {
      repository[`pr${String(number)}`] = {
        closingIssuesReferences: {
          nodes: (closing[Number(number)] ?? []).map(([repo, issue]) => ({
            number: issue,
            repository: { nameWithOwner: repo },
          })),
        },
      };
    }
    return { body: { data: { repository } } };
  };
}

function githubRoutes(shas: Shas, overrides: Record<string, FakeRoute> = {}): FakeRoute {
  const items = [
    item(1, { title: 'VAT wrong for reduced rate', state: 'closed', labels: [{ name: 'bug' }] }),
    item(2, { title: 'Missing tests' }),
    item(3, {
      title: 'Reduced VAT rate',
      body: 'Closes #2\n\nAlso relates to #1',
      state: 'closed',
      html_url: 'https://github.com/acme/shop/pull/3',
      pull_request: { merged_at: '2026-01-03T12:00:00Z' },
    }),
    item(4, {
      title: 'Experimental rate change',
      body: 'Fixes #1',
      html_url: 'https://github.com/acme/shop/pull/4',
      pull_request: { merged_at: null },
    }),
  ];
  const routes: Record<string, FakeRoute> = {
    // Like GitHub: `since` returns items updated at or after the given time.
    '/repos/acme/shop/issues': (url) => {
      const since = url.searchParams.get('since');
      return paged(
        url,
        since ? items.filter((i) => Date.parse(i.updated_at) >= Date.parse(since)) : items,
      );
    },
    '/repos/acme/shop/pulls/3': () => ({
      body: {
        number: 3,
        merged_at: '2026-01-03T12:00:00Z',
        merge_commit_sha: shas.merge,
        base: { ref: 'main' },
        head: { ref: 'feature' },
      },
    }),
    '/repos/acme/shop/pulls/3/commits': () => ({ body: [{ sha: shas.fix }, { sha: shas.tests }] }),
    '/repos/acme/shop/pulls/3/reviews': () => ({
      body: [
        {
          id: 10,
          user: { login: 'grace' },
          body: 'LGTM',
          state: 'APPROVED',
          submitted_at: '2026-01-03T11:00:00Z',
        },
        { id: 11, user: { login: 'bob' }, body: '', state: 'PENDING' },
      ],
    }),
    '/repos/acme/shop/pulls/4': () => ({
      body: {
        number: 4,
        merged_at: null,
        merge_commit_sha: TEST_MERGE_SHA,
        base: { ref: 'main' },
        head: { ref: 'experiment' },
      },
    }),
    '/repos/acme/shop/pulls/4/commits': () => ({ body: [] }),
    '/repos/acme/shop/pulls/4/reviews': () => ({ body: [] }),
    // GitHub links PR #3 to the issue its body closes.
    '/graphql': closingRefs({ 3: [['acme/shop', 2]] }),
    ...overrides,
  };
  return (url, request) => routes[url.pathname]?.(url, request);
}

describe('GitHub sync and linking', () => {
  let repo: FixtureRepo | undefined;
  let server: FakeGitHub | undefined;
  let fossil: FossilDatabase;
  let shas: Shas;
  let repositoryId: number;
  /** The fake API's behaviour for the next run; one server per test, like one GitHub. */
  let route: FakeRoute = () => undefined;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    shas = await buildHistory(repo);
    fossil = openDatabase(IN_MEMORY);
    repositoryId = registerRepository(fossil.db, { path: repo.root, name: 'shop' }).id;
    server = await startFakeGitHub((url, request) => route(url, request));
    connectProvider(fossil.db, {
      repositoryId,
      provider: 'github',
      owner: 'acme',
      name: 'shop',
      apiUrl: server.apiUrl,
    });
  });

  afterEach(async () => {
    fossil.close();
    await server?.close();
    server = undefined;
    await repo?.cleanup();
  });

  /** Run a full index against the fake API; `requests` then holds only this run's calls. */
  async function index(routes: FakeRoute, maxRequests = 100, token: string | null = 'test-token') {
    route = routes;
    const apiUrl = server?.apiUrl ?? '';
    server?.clearRequests();
    return runIndex(fossil.db, repo?.root ?? '', {
      now,
      github: () => new GitHubClient({ apiUrl, token, maxRequests }),
    });
  }

  const ref = (type: 'issue' | 'pull_request', number: number) => {
    const row =
      type === 'issue'
        ? findIssueByNumber(fossil.db, repositoryId, number)
        : findPullRequestByNumber(fossil.db, repositoryId, number);
    if (!row) throw new Error(`${type} #${number} not synced`);
    return { type, id: row.id } as const;
  };
  const commit = (sha: string) =>
    ({ type: 'commit', id: findCommitBySha(fossil.db, repositoryId, sha)?.id ?? 0 }) as const;
  const edges = (from: { type: 'issue' | 'pull_request' | 'commit'; id: number }) =>
    outgoingRelations(fossil.db, repositoryId, from).map(
      (r) => `${r.relation} ${r.targetType}#${r.targetId} ${r.evidenceType} ${r.confidence}`,
    );

  it('syncs issues, pull requests and reviews, and links them to history with evidence', async () => {
    const result = await index(githubRoutes(shas));

    expect(result.github?.sync).toMatchObject({
      issues: 2,
      pullRequests: 2,
      detailsFetched: 2,
      detailsPending: 0,
      // Only the merged PR is asked for the issues it closes.
      closingRefsFetched: 1,
      closingRefsError: null,
      stoppedEarly: null,
    });
    expect(fossil.db.select().from(schema.reviews).all()).toEqual([
      expect.objectContaining({ author: 'grace', state: 'APPROVED', externalId: '10' }),
    ]);

    const pr3 = ref('pull_request', 3);
    // Commits GitHub lists for the PR plus its merge commit: facts.
    expect(
      edges(pr3)
        .filter((e) => e.startsWith('IMPLEMENTED_BY'))
        .sort(),
    ).toEqual(
      [commit(shas.fix), commit(shas.tests), commit(shas.merge)]
        .map((c) => `IMPLEMENTED_BY commit#${c.id} FACT 1`)
        .sort(),
    );
    // A bare mention in the PR body.
    expect(edges(pr3)).toContain(`REFERENCES issue#${ref('issue', 1).id} DERIVED 1`);

    // GitHub records the merged PR as closing #2 (a fact); a commit's closing keyword resolves #1.
    expect(edges(ref('issue', 2))).toEqual([`RESOLVED_BY pull_request#${pr3.id} FACT 1`]);
    expect(edges(ref('issue', 1))).toEqual([
      `RESOLVED_BY commit#${commit(shas.fix).id} DERIVED 0.9`,
    ]);

    // Mentions in commit messages; unknown numbers (#99) link nothing.
    expect(edges(commit(shas.tests))).toContain(`REFERENCES issue#${ref('issue', 2).id} DERIVED 1`);
    expect(edges(commit(shas.merge))).toContain(`REFERENCES pull_request#${pr3.id} DERIVED 1`);

    // The open PR's "Fixes #1" is only a reference, and its test merge commit is ignored.
    expect(edges(ref('pull_request', 4))).toEqual([
      `REFERENCES issue#${ref('issue', 1).id} DERIVED 1`,
    ]);

    const resolution = incomingRelations(fossil.db, repositoryId, pr3).find(
      (r) => r.relation === 'RESOLVED_BY',
    );
    expect(resolution?.provenanceJson).toMatchObject({ method: GITHUB_CLOSING_METHOD });
    expect(resolution?.provenanceJson.evidenceIds).toHaveLength(1);
  });

  it('reads closing keywords in pull requests when GitHub cannot be asked (no token)', async () => {
    const result = await index(githubRoutes(shas), 100, null);

    expect(result.github?.sync).toMatchObject({ closingRefsFetched: 0, closingRefsError: null });
    expect(server?.requests.some((r) => r.url.pathname === '/graphql')).toBe(false);
    const pr3 = ref('pull_request', 3);
    expect(edges(ref('issue', 2))).toEqual([`RESOLVED_BY pull_request#${pr3.id} DERIVED 0.9`]);
  });

  it("lets GitHub's closing links decide over the pull request's keywords", async () => {
    // GitHub reports PR #3 closing nothing (e.g. it targeted another branch).
    await index(githubRoutes(shas, { '/graphql': closingRefs({}) }));

    const pr3 = ref('pull_request', 3);
    expect(edges(ref('issue', 2))).toEqual([]);
    expect(edges(pr3)).toContain(`REFERENCES issue#${ref('issue', 2).id} DERIVED 1`);
  });

  it('keeps keyword links and says why when the closing links cannot be read', async () => {
    const failing: FakeRoute = () => ({ status: 502, body: { message: 'Bad gateway' } });
    const result = await index(githubRoutes(shas, { '/graphql': failing }));

    expect(result.github?.sync?.closingRefsError).toMatch(/failed with 502/);
    expect(result.github?.sync?.stoppedEarly).toBeNull();
    const pr3 = ref('pull_request', 3);
    expect(edges(ref('issue', 2))).toEqual([`RESOLVED_BY pull_request#${pr3.id} DERIVED 0.9`]);
  });

  it('links issues of other repositories, and remembers the ones it cannot read', async () => {
    const fix = (await repo?.commit('Fixes Other/Lib#5, see other/lib#6')) ?? '';
    const foreign = (number: number, title: string) => () => ({
      body: item(number, {
        title,
        state: 'closed',
        html_url: `https://github.com/other/lib/issues/${String(number)}`,
      }),
    });
    const routes = githubRoutes(shas, {
      '/graphql': closingRefs({
        3: [
          ['acme/shop', 2],
          ['Other/Lib', 7],
        ],
      }),
      '/repos/other/lib/issues/5': foreign(5, 'Crash in parser'),
      '/repos/other/lib/issues/7': foreign(7, 'Upstream rate table'),
      // #6 is private or gone: a 404.
    });

    const first = await index(routes);
    expect(first.github?.sync).toMatchObject({ foreignIssues: 2, stoppedEarly: null });

    const foreignIssue = (number: number) => {
      const row = fossil.db
        .select()
        .from(schema.issues)
        .where(
          and(
            eq(schema.issues.sourceRepo, 'other/lib'),
            eq(schema.issues.externalId, String(number)),
          ),
        )
        .get();
      if (!row) throw new Error(`other/lib#${String(number)} not synced`);
      return { type: 'issue', id: row.id } as const;
    };
    const pr3 = ref('pull_request', 3);
    expect(edges(foreignIssue(5))).toEqual([`RESOLVED_BY commit#${commit(fix).id} DERIVED 0.9`]);
    expect(edges(foreignIssue(7))).toEqual([`RESOLVED_BY pull_request#${pr3.id} FACT 1`]);
    // Issues of other repositories are not counted as the repository's own.
    expect(providerCounts(fossil.db, repositoryId).issues).toBe(2);

    // Within a week nothing is asked again, the unreadable #6 included.
    await index(routes);
    expect(server?.requests.some((r) => r.url.pathname.startsWith('/repos/other/'))).toBe(false);
  });

  it('resumes from its cursor and does not refetch details that are up to date', async () => {
    await index(githubRoutes(shas));
    const second = await index(githubRoutes(shas));

    expect(second.github?.sync).toMatchObject({ detailsFetched: 0, requests: 1 });
    expect(server?.requests[0]?.url.searchParams.get('since')).toBe('2026-01-04T10:00:00.000Z');
  });

  it('stops within its request budget and completes on the next run', async () => {
    const first = await index(githubRoutes(shas), 4);
    expect(first.github?.sync?.stoppedEarly).toMatch(/budget/);
    expect(providerCounts(fossil.db, repositoryId).pendingPullRequestDetails).toBeGreaterThan(0);

    const second = await index(githubRoutes(shas), 100);
    expect(second.github?.sync).toMatchObject({ stoppedEarly: null, detailsPending: 0 });
  });

  it('stops cleanly at the rate limit and keeps what it synced', async () => {
    const limited: FakeRoute = () => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
      body: { message: 'API rate limit exceeded' },
    });
    const result = await index(githubRoutes(shas, { '/repos/acme/shop/pulls/4': limited }));

    expect(result.github?.sync?.stoppedEarly).toMatch(/rate limit/);
    expect(providerCounts(fossil.db, repositoryId)).toMatchObject({ issues: 2, pullRequests: 2 });
  });

  it('does not treat a reverted fix, or the revert itself, as resolving the issue', async () => {
    await index(githubRoutes(shas));
    expect(edges(ref('issue', 1))).toEqual([
      `RESOLVED_BY commit#${commit(shas.fix).id} DERIVED 0.9`,
    ]);

    await repo?.git('revert', '--no-edit', shas.fix);
    const revert = (await repo?.git('rev-parse', 'HEAD'))?.trim() ?? '';
    await runIndex(fossil.db, repo?.root ?? '', { now });

    expect(edges(ref('issue', 1))).toEqual([]);
    const fixEdges = outgoingRelations(fossil.db, repositoryId, commit(shas.fix)).filter(
      (r) => r.provenanceJson.producer === GITHUB_LINKER_PRODUCER,
    );
    expect(fixEdges).toHaveLength(1);
    expect(fixEdges[0]).toMatchObject({ relation: 'REFERENCES', targetId: ref('issue', 1).id });
    expect(fixEdges[0]?.provenanceJson.details).toEqual({ reverted: true, revert: false });
    // `git revert` quotes only the subject, so this revert mentions no issue.
    expect(edges(commit(revert)).filter((e) => !e.startsWith('MODIFIES'))).toEqual([]);

    // A revert that quotes the closing keyword undoes the fix: a reference, never a resolution.
    const quoting =
      (await repo?.commit(`Revert "Fixes #2"\n\nThis reverts commit ${shas.tests}.`)) ?? '';
    await runIndex(fossil.db, repo?.root ?? '', { now });
    expect(edges(commit(quoting)).filter((e) => !e.startsWith('MODIFIES'))).toEqual([
      `REFERENCES issue#${ref('issue', 2).id} DERIVED 1`,
    ]);
  });

  it('links stored GitHub data to new commits when offline', async () => {
    await index(githubRoutes(shas));
    await repo?.write('src/fix.ts', 'export {};\n');
    const late = (await repo?.commit('Follow-up, fixes #2')) ?? '';

    const offline = await runIndex(fossil.db, repo?.root ?? '', { now });

    expect(offline.github?.sync).toBeNull();
    expect(edges(ref('issue', 2))).toContain(`RESOLVED_BY commit#${commit(late).id} DERIVED 0.9`);
  });
});
