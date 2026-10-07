import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectProvider,
  findCommitBySha,
  IN_MEMORY,
  openDatabase,
  outgoingRelations,
  registerRepository,
  schema,
  type FossilDatabase,
} from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { GitLabClient } from '@codefossil/providers';
import { startFakeGitHub, type FakeGitHub, type FakeRoute } from '@codefossil/providers/testing';
import { and, eq } from 'drizzle-orm';
import { parseGitLabReferences } from './gitlab-sync.js';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-10-07T12:00:00.000Z');

describe('parseGitLabReferences', () => {
  it('tells issues (#) from merge requests (!) and reads GitLab closing words', () => {
    expect(parseGitLabReferences('Closes #12, see !4 and #13. Implements #14')).toEqual([
      { number: 12, kind: 'issue', closing: true },
      { number: 4, kind: 'merge_request', closing: false },
      { number: 13, kind: 'issue', closing: false },
      { number: 14, kind: 'issue', closing: true },
    ]);
    expect(parseGitLabReferences('see https://x.org/page#2 or a!3 or group/project#4')).toEqual([]);
    const started = performance.now();
    parseGitLabReferences(`closes${' '.repeat(50_000)}x #1 ${'#1 '.repeat(40_000)}`);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

const item = (iid: number, fields: Record<string, unknown>) => ({
  iid,
  title: `Item ${String(iid)}`,
  description: null,
  state: 'opened',
  web_url: `https://gitlab.com/acme/shop/-/issues/${String(iid)}`,
  author: { username: 'ada' },
  labels: [],
  created_at: '2026-01-01T09:00:00Z',
  updated_at: `2026-01-0${String(iid)}T10:00:00Z`,
  closed_at: null,
  ...fields,
});

describe('GitLab sync and linking', () => {
  let repo: FixtureRepo;
  let fossil: FossilDatabase;
  let server: FakeGitHub;
  let repositoryId: number;
  let fixSha: string;
  let mergeSha: string;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    fossil = openDatabase(IN_MEMORY);
    await repo.write('src/vat.ts', 'export const vat = 0.21;\n');
    await repo.commit('Add VAT');
    await repo.git('checkout', '-q', '-b', 'feature');
    await repo.write('src/vat.ts', 'export const vat = 0.09;\n');
    fixSha = await repo.commit('Reduced rate, fixes #1');
    await repo.git('checkout', '-q', 'main');
    mergeSha = await repo.merge('feature', "Merge branch 'feature' into 'main'");
    repositoryId = registerRepository(fossil.db, { path: repo.root, name: 'shop' }).id;

    const routes: Record<string, FakeRoute> = {
      '/api/v4/projects/acme%2Fshop': () => ({ body: { id: 7, path_with_namespace: 'acme/shop' } }),
      '/api/v4/projects/acme%2Fshop/issues': (url) => ({
        body: url.searchParams.has('updated_after')
          ? []
          : [
              item(1, { title: 'Wrong VAT', state: 'closed', labels: ['bug'] }),
              item(2, { title: 'Reduced rate' }),
            ],
      }),
      '/api/v4/projects/acme%2Fshop/merge_requests': (url) => ({
        body: url.searchParams.has('updated_after') ? [] : [mergeRequest()],
      }),
      '/api/v4/projects/acme%2Fshop/merge_requests/3': () => ({ body: mergeRequest() }),
      '/api/v4/projects/acme%2Fshop/merge_requests/3/commits': () => ({ body: [{ id: fixSha }] }),
      // GitLab's own record: #2 here, and an issue of another project that is ignored.
      '/api/v4/projects/acme%2Fshop/merge_requests/3/closes_issues': () => ({
        body: [
          { iid: 2, project_id: 7 },
          { iid: 9, project_id: 99 },
        ],
      }),
    };
    function mergeRequest() {
      return {
        ...item(3, {
          title: 'Reduced VAT rate',
          description: 'Closes #2, see !4',
          state: 'merged',
        }),
        web_url: 'https://gitlab.com/acme/shop/-/merge_requests/3',
        merged_at: '2026-01-03T12:00:00Z',
        merge_commit_sha: mergeSha,
        squash_commit_sha: null,
        source_branch: 'feature',
        target_branch: 'main',
      };
    }
    server = await startFakeGitHub((url) =>
      routes[url.pathname]?.(url, { method: 'GET', body: '' }),
    );
    connectProvider(fossil.db, {
      repositoryId,
      provider: 'gitlab',
      owner: '',
      name: 'acme/shop',
      apiUrl: `${server.apiUrl}/api/v4`,
    });
  });

  afterEach(async () => {
    fossil.close();
    await server.close();
    await repo.cleanup();
  });

  const issueId = (number: number) =>
    fossil.db
      .select()
      .from(schema.issues)
      .where(
        and(eq(schema.issues.provider, 'gitlab'), eq(schema.issues.externalId, String(number))),
      )
      .get()?.id ?? 0;
  const edges = (type: 'issue' | 'pull_request' | 'commit', id: number) =>
    outgoingRelations(fossil.db, repositoryId, { type, id }).map(
      (r) =>
        `${r.relation} ${r.targetType} ${r.evidenceType} ${String(r.confidence)} ${r.provenanceJson.method}`,
    );

  it('syncs issues and merge requests and links them with GitLab’s own closing record', async () => {
    const apiUrl = `${server.apiUrl}/api/v4`;
    const result = await runIndex(fossil.db, repo.root, {
      now,
      gitlab: () => new GitLabClient({ apiUrl, token: 'glpat-test', maxRequests: 50 }),
    });

    expect(result.gitlab).toMatchObject({
      project: 'acme/shop',
      sync: { issues: 2, mergeRequests: 1, detailsFetched: 1, stoppedEarly: null },
    });
    expect(server.requests[0]?.headers.authorization).toBe('Bearer glpat-test');
    // GitLab records !3 as closing #2: a fact.
    expect(edges('issue', issueId(2))).toEqual([
      'RESOLVED_BY pull_request FACT 1 gitlab-closes-issues',
    ]);
    // A closing keyword in a commit: derived.
    expect(edges('issue', issueId(1))).toEqual(['RESOLVED_BY commit DERIVED 0.9 closing-keyword']);
    const mr = fossil.db.select().from(schema.pullRequests).get();
    expect(mr?.provider).toBe('gitlab');
    const implemented = edges('pull_request', mr?.id ?? 0).filter((e) =>
      e.startsWith('IMPLEMENTED_BY'),
    );
    expect(implemented.sort()).toEqual([
      'IMPLEMENTED_BY commit FACT 1 merge-commit',
      'IMPLEMENTED_BY commit FACT 1 merge-request-commits',
    ]);
    expect(findCommitBySha(fossil.db, repositoryId, fixSha)).toBeDefined();

    // Offline later: everything stored is still linked.
    const offline = await runIndex(fossil.db, repo.root, { now });
    expect(offline.gitlab).toMatchObject({ sync: null, links: { resolutions: 2 } });
  });

  it('finishes merge requests an interrupted sync left pending, though they are not listed again', async () => {
    const apiUrl = `${server.apiUrl}/api/v4`;
    // Budget for the project, issues and merge request lists only: details are left pending.
    const first = await runIndex(fossil.db, repo.root, {
      now,
      gitlab: () => new GitLabClient({ apiUrl, token: 't', maxRequests: 3 }),
    });
    expect(first.gitlab?.sync?.stoppedEarly).toMatch(/budget/);
    expect(first.gitlab?.links.pullRequestCommits).toBe(0);

    const second = await runIndex(fossil.db, repo.root, {
      now,
      gitlab: () => new GitLabClient({ apiUrl, token: 't', maxRequests: 50 }),
    });
    expect(second.gitlab?.sync?.stoppedEarly).toBeNull();
    expect(server.requests.map((r) => r.url.pathname)).toContain(
      '/api/v4/projects/acme%2Fshop/merge_requests/3',
    );
    expect(second.gitlab?.links).toMatchObject({ pullRequestCommits: 2, resolutions: 2 });
  });

  it('reports a GitLab failure without stopping indexing', async () => {
    const result = await runIndex(fossil.db, repo.root, {
      now,
      gitlab: () =>
        new GitLabClient({
          apiUrl: `${server.apiUrl}/api/v4/missing`,
          token: null,
          maxRequests: 5,
        }),
    });
    expect(result.gitlab?.sync?.stoppedEarly).toMatch(/failed with 404/);
    expect(result.commitsIndexed).toBe(3);
  });
});
