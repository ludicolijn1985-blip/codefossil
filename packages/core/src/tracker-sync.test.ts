import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  commitDiscussions,
  connectProvider,
  IN_MEMORY,
  openDatabase,
  registerRepository,
  schema,
  type FossilDatabase,
} from '@codefossil/db';
import { createFixtureRepo, type FixtureRepo } from '@codefossil/git/testing';
import { TrackerApiError, type TrackerClient, type TrackerIssue } from '@codefossil/providers';
import { runIndex } from './run-index.js';

const now = () => new Date('2026-10-07T12:00:00.000Z');

const bug: TrackerIssue = {
  key: 'PROJ-12',
  title: 'Checkout crashes',
  body: '',
  state: 'closed',
  url: 'https://acme.atlassian.net/browse/PROJ-12',
  labels: ['type:Bug'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  closedAt: '2026-01-02T00:00:00.000Z',
};

/** A tracker that knows PROJ and answers from a fixed list, recording what it was asked. */
function fakeTracker(issues: readonly TrackerIssue[], fail = false) {
  const asked: string[][] = [];
  const client: TrackerClient = {
    provider: 'jira',
    requestsMade: 0,
    projectKeys: () =>
      fail ? Promise.reject(new TrackerApiError('down', 503)) : Promise.resolve(['PROJ']),
    issues: (keys) => {
      asked.push([...keys]);
      return Promise.resolve(issues.filter((issue) => keys.includes(issue.key)));
    },
  };
  return { client, asked };
}

describe('Jira and Linear links', () => {
  let repo: FixtureRepo;
  let fossil: FossilDatabase;
  let repositoryId: number;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    fossil = openDatabase(IN_MEMORY);
    await repo.write('src/cart.ts', 'export const total = 1;\n');
    await repo.commit('PROJ-12: handle empty cart');
    await repo.write('src/cart.ts', 'export const total = 2;\n');
    await repo.commit('Support UTF-8 and SHA-256 names (OPS-4)');
    repositoryId = registerRepository(fossil.db, { path: repo.root, name: 'shop' }).id;
    connectProvider(fossil.db, {
      repositoryId,
      provider: 'jira',
      owner: '',
      name: '',
      apiUrl: 'https://acme.atlassian.net',
    });
  });

  afterEach(async () => {
    fossil.close();
    await repo.cleanup();
  });

  it('reads issues of known projects named in commits, links them and reads bug tickets as fixes', async () => {
    const { client, asked } = fakeTracker([bug]);
    const result = await runIndex(fossil.db, repo.root, { now, trackers: () => client });

    // Only PROJ is a project: UTF-8, SHA-256 and OPS-4 are never asked for.
    expect(asked).toEqual([['PROJ-12']]);
    expect(result.trackers).toEqual([
      {
        provider: 'jira',
        sync: { provider: 'jira', projects: 1, issues: 1, requests: 0, stoppedEarly: null },
        links: { references: 1 },
      },
    ]);
    const stored = fossil.db.select().from(schema.issues).all();
    expect(stored.map((i) => [i.provider, i.externalId, i.state])).toEqual([
      ['jira', 'PROJ-12', 'closed'],
    ]);

    // The commit names the issue: a reference (DERIVED), carrying the issue's labels for analyzers.
    expect(
      commitDiscussions(fossil.db, repositoryId).map((d) => [
        d.provider,
        d.number,
        d.relation,
        d.level,
        d.labels,
      ]),
    ).toEqual([['jira', 'PROJ-12', 'REFERENCES', 'DERIVED', ['type:Bug']]]);

    // Offline later: the stored issue is still linked; nothing is asked again within a week.
    const offline = await runIndex(fossil.db, repo.root, { now });
    expect(offline.trackers[0]).toMatchObject({ sync: null, links: { references: 1 } });
    await runIndex(fossil.db, repo.root, { now, trackers: () => client });
    // Nothing new to read: the tracker is not asked for issues at all.
    expect(asked).toHaveLength(1);
  });

  it('reports a tracker failure without stopping indexing', async () => {
    const { client } = fakeTracker([bug], true);
    const result = await runIndex(fossil.db, repo.root, { now, trackers: () => client });
    expect(result.trackers[0]?.sync?.stoppedEarly).toBe('down');
    expect(result.commitsIndexed).toBe(2);
  });
});
