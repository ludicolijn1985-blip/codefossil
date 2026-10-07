import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  connectProvider,
  IN_MEMORY,
  openDatabase,
  outgoingRelations,
  registerRepository,
  schema,
  type FossilDatabase,
} from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { AzureDevOpsClient, BitbucketClient } from '@codefossil/providers';
import { startFakeGitHub, type FakeGitHub, type FakeRoute } from '@codefossil/providers/testing';
import { and, eq } from 'drizzle-orm';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-10-07T12:00:00.000Z');

interface Fixture {
  repo: FixtureRepo;
  fossil: FossilDatabase;
  repositoryId: number;
  fixSha: string;
  mergeSha: string;
}

/** A feature branch with a fix, merged into main. */
async function mergedHistory(): Promise<Fixture> {
  const repo = await createFixtureRepo();
  const fossil = openDatabase(IN_MEMORY);
  await repo.write('src/vat.ts', 'export const vat = 0.21;\n');
  await repo.commit('Add VAT');
  await repo.git('checkout', '-q', '-b', 'feature');
  await repo.write('src/vat.ts', 'export const vat = 0.09;\n');
  const fixSha = await repo.commit('Reduced rate, fixes #12');
  await repo.git('checkout', '-q', 'main');
  const mergeSha = await repo.merge('feature', 'Merged PR 5: Reduced rate');
  const repositoryId = registerRepository(fossil.db, { path: repo.root, name: 'shop' }).id;
  return { repo, fossil, repositoryId, fixSha, mergeSha };
}

const edges = (f: Fixture, type: 'issue' | 'pull_request', id: number) =>
  outgoingRelations(f.fossil.db, f.repositoryId, { type, id })
    .map(
      (r) =>
        `${r.relation} ${r.targetType} ${r.evidenceType} ${String(r.confidence)} ${r.provenanceJson.method}`,
    )
    .sort();

const pullRequestId = (f: Fixture, provider: string, number: number) =>
  f.fossil.db
    .select()
    .from(schema.pullRequests)
    .where(
      and(
        eq(schema.pullRequests.provider, provider),
        eq(schema.pullRequests.externalId, String(number)),
      ),
    )
    .get();

describe('Bitbucket sync and linking', () => {
  let f: Fixture;
  let server: FakeGitHub;

  beforeEach(async () => {
    f = await mergedHistory();
    const base = '/2.0/repositories/acme/shop';
    const pr = (id: number, fields: Record<string, unknown>) => ({
      id,
      title: `PR ${String(id)}`,
      description: '',
      state: 'OPEN',
      author: { display_name: 'Ada' },
      created_on: '2026-01-01T09:00:00.000000+00:00',
      updated_on: `2026-01-0${String(id)}T10:00:00.000000+00:00`,
      merge_commit: null,
      source: { branch: { name: 'feature' } },
      destination: { branch: { name: 'main' } },
      links: { html: { href: `https://bitbucket.org/acme/shop/pull-requests/${String(id)}` } },
      ...fields,
    });
    const routes: Record<string, FakeRoute> = {
      [`${base}/pullrequests`]: (url) => {
        if (url.searchParams.has('q')) return { body: { values: [] } };
        return url.searchParams.get('page') === '2'
          ? { body: { values: [pr(2, {})] } }
          : {
              body: {
                // Bitbucket abbreviates merge commit hashes.
                values: [
                  pr(1, { state: 'MERGED', merge_commit: { hash: f.mergeSha.slice(0, 12) } }),
                ],
                next: `${server.apiUrl}${base}/pullrequests?page=2`,
              },
            };
      },
      [`${base}/pullrequests/1/commits`]: () => ({ body: { values: [{ hash: f.fixSha }] } }),
      // The source branch of #2 is gone: no commit list.
      [`${base}/pullrequests/2/commits`]: () => undefined,
    };
    server = await startFakeGitHub((url) =>
      routes[url.pathname]?.(url, { method: 'GET', body: '' }),
    );
    connectProvider(f.fossil.db, {
      repositoryId: f.repositoryId,
      provider: 'bitbucket',
      owner: 'acme',
      name: 'shop',
      apiUrl: `${server.apiUrl}/2.0`,
    });
  });

  afterEach(async () => {
    f.fossil.close();
    await server.close();
    await f.repo.cleanup();
  });

  it('follows pages, expands abbreviated merge commits and dates the merge by its commit', async () => {
    const result = await runIndex(f.fossil.db, f.repo.root, {
      now,
      hosts: (connection) =>
        new BitbucketClient({
          apiUrl: connection.apiUrl,
          workspace: connection.owner,
          repository: connection.name,
          authorization: 'Bearer bb-test',
          maxRequests: 20,
        }),
    });
    expect(result.hosts).toMatchObject([
      {
        provider: 'bitbucket',
        repository: 'acme/shop',
        sync: { pullRequests: 2, detailsFetched: 2, stoppedEarly: null },
        links: { pullRequestCommits: 2 },
      },
    ]);
    expect(server.requests[0]?.headers.authorization).toBe('Bearer bb-test');
    const merged = pullRequestId(f, 'bitbucket', 1);
    expect(merged?.mergeCommitSha).toBe(f.mergeSha);
    expect(merged?.mergedAt).not.toBeNull();
    // Built locally from the repository and number, never taken from the response.
    expect(merged?.url).toBe('https://bitbucket.org/acme/shop/pull-requests/1');
    expect(edges(f, 'pull_request', merged?.id ?? 0)).toEqual([
      'IMPLEMENTED_BY commit FACT 1 merge-commit',
      'IMPLEMENTED_BY commit FACT 1 pull-request-commits',
    ]);

    // Next run: nothing changed since the cursor.
    const again = await runIndex(f.fossil.db, f.repo.root, {
      now,
      hosts: (connection) =>
        new BitbucketClient({
          apiUrl: connection.apiUrl,
          workspace: connection.owner,
          repository: connection.name,
          authorization: null,
          maxRequests: 20,
        }),
    });
    expect(again.hosts[0]?.sync).toMatchObject({ pullRequests: 0, requests: 1 });
    expect(server.requests.at(-1)?.url.searchParams.get('q')).toMatch(/^updated_on >= 2026-01-02/);
  });
});

describe('Azure Repos sync and linking', () => {
  let f: Fixture;
  let server: FakeGitHub;
  let reads: string[];

  beforeEach(async () => {
    f = await mergedHistory();
    reads = [];
    const base = '/acme/Shop%20Project/_apis';
    const repoPath = `${base}/git/repositories/shop`;
    const pr = (id: number, fields: Record<string, unknown>) => ({
      pullRequestId: id,
      title: `PR ${String(id)}`,
      description: '',
      status: 'active',
      createdBy: { displayName: 'Ada' },
      creationDate: '2026-01-01T09:00:00Z',
      closedDate: null,
      lastMergeCommit: null,
      sourceRefName: 'refs/heads/feature',
      targetRefName: 'refs/heads/main',
      ...fields,
    });
    const completed = () =>
      pr(5, {
        status: 'completed',
        closedDate: '2026-01-03T12:00:00Z',
        lastMergeCommit: { commitId: f.mergeSha },
        description: 'Implements the reduced rate',
      });
    const workItem = (id: number, type: string, state: string) => ({
      id,
      fields: {
        'System.Title': `Item ${String(id)}`,
        'System.State': state,
        'System.WorkItemType': type,
        'System.CreatedDate': '2026-01-01T08:00:00Z',
        'System.ChangedDate': '2026-01-03T13:00:00Z',
        'System.Tags': 'tax; vat',
      },
    });
    const routes: Record<string, FakeRoute> = {
      [repoPath]: () => ({ body: { id: 'repo-guid' } }),
      [`${repoPath}/pullrequests`]: () => ({ body: { value: [completed(), pr(4, {})] } }),
      [`${repoPath}/pullrequests/4`]: () => ({ body: pr(4, {}) }),
      [`${repoPath}/pullRequests/5/commits`]: () => ({ body: { value: [{ commitId: f.fixSha }] } }),
      [`${repoPath}/pullRequests/4/commits`]: () => ({ body: { value: [] } }),
      [`${repoPath}/pullRequests/5/workitems`]: () => ({ body: { value: [{ id: '11' }] } }),
      [`${repoPath}/pullRequests/4/workitems`]: () => ({ body: { value: [{ id: '12' }] } }),
      [`${base}/wit/workitems`]: (url) => ({
        body: {
          value:
            url.searchParams.get('ids') === '11'
              ? [workItem(11, 'Bug', 'Closed')]
              : [workItem(12, 'Task', 'Active')],
        },
      }),
    };
    server = await startFakeGitHub((url) => {
      reads.push(url.pathname);
      return routes[url.pathname]?.(url, { method: 'GET', body: '' });
    });
    connectProvider(f.fossil.db, {
      repositoryId: f.repositoryId,
      provider: 'azure',
      owner: 'Shop Project',
      name: 'shop',
      apiUrl: `${server.apiUrl}/acme`,
    });
  });

  afterEach(async () => {
    f.fossil.close();
    await server.close();
    await f.repo.cleanup();
  });

  const client =
    (token: string | null) => (connection: { apiUrl: string; owner: string; name: string }) =>
      new AzureDevOpsClient({
        apiUrl: connection.apiUrl,
        project: connection.owner,
        repository: connection.name,
        token,
        maxRequests: 30,
      });

  const workItemId = (number: number) =>
    f.fossil.db
      .select()
      .from(schema.issues)
      .where(and(eq(schema.issues.provider, 'azure'), eq(schema.issues.externalId, String(number))))
      .get();

  it('links pull requests to commits and work items, telling recorded links from readings', async () => {
    const result = await runIndex(f.fossil.db, f.repo.root, { now, hosts: client('pat') });
    expect(result.hosts[0]).toMatchObject({
      provider: 'azure',
      repository: 'Shop Project/shop',
      sync: { pullRequests: 2, workItems: 2, detailsFetched: 2, stoppedEarly: null },
    });
    expect(server.requests[0]?.headers.authorization).toBe(
      `Basic ${Buffer.from(':pat').toString('base64')}`,
    );
    const bug = workItemId(11);
    expect(bug).toMatchObject({ state: 'closed', labelsJson: ['tax', 'vat', 'type:Bug'] });
    expect(bug?.url).toBe(`${server.apiUrl}/acme/Shop%20Project/_workitems/edit/11`);
    // Linked to the completed PR and closed: resolved, as a reading.
    expect(edges(f, 'issue', bug?.id ?? 0)).toEqual([
      'RESOLVED_BY pull_request DERIVED 0.8 azure-linked-work-item',
    ]);
    // "fixes #12" in a commit that landed.
    expect(edges(f, 'issue', workItemId(12)?.id ?? 0)).toEqual([
      'RESOLVED_BY commit DERIVED 0.9 closing-keyword',
    ]);
    // The open PR's link to #12 is recorded as it is: a reference.
    expect(edges(f, 'pull_request', pullRequestId(f, 'azure', 4)?.id ?? 0)).toEqual([
      'REFERENCES issue FACT 1 azure-linked-work-item',
    ]);
    const completed = pullRequestId(f, 'azure', 5);
    expect(completed).toMatchObject({ state: 'merged', mergedAt: '2026-01-03T12:00:00Z' });
    expect(edges(f, 'pull_request', completed?.id ?? 0)).toEqual([
      'IMPLEMENTED_BY commit FACT 1 merge-commit',
      'IMPLEMENTED_BY commit FACT 1 pull-request-commits',
    ]);
  });

  it('re-reads pull requests still open, since Azure lists by creation', async () => {
    await runIndex(f.fossil.db, f.repo.root, { now, hosts: client(null) });
    reads = [];
    const again = await runIndex(f.fossil.db, f.repo.root, { now, hosts: client(null) });
    expect(again.hosts[0]?.sync).toMatchObject({ pullRequests: 1, stoppedEarly: null });
    expect(reads).toContain('/acme/Shop%20Project/_apis/git/repositories/shop/pullrequests/4');
  });
});
