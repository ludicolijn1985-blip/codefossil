import { afterEach, describe, expect, it } from 'vitest';
import { startFakeGitHub, type FakeGitHub, type FakeRoute } from '../testing/index.js';
import { trackerKeys } from './http.js';
import { JiraClient } from './jira.js';
import { LinearClient } from './linear.js';

describe('trackerKeys', () => {
  it('finds keys of known projects only', () => {
    expect(
      trackerKeys(
        'PROJ-12: fix crash, see OPS-3 and UTF-8, SHA-256, PROJ-12 again',
        new Set(['PROJ', 'OPS']),
      ),
    ).toEqual(['PROJ-12', 'OPS-3']);
    expect(trackerKeys('proj-12 PROJ-0 PROJ-12345678', new Set(['PROJ']))).toEqual([]);
  });
});

describe('tracker clients', () => {
  let server: FakeGitHub | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  const start = async (route: FakeRoute) => {
    server = await startFakeGitHub(route);
    return server.apiUrl;
  };

  it('reads Jira projects and issues, falling back to the v3 search', async () => {
    const url = await start((u, request) => {
      if (u.pathname === '/rest/api/2/project') return { body: [{ key: 'PROJ' }, { key: 'OPS' }] };
      if (u.pathname === '/rest/api/2/search') return { status: 410, body: {} };
      if (u.pathname === '/rest/api/3/search/jql' && request.method === 'POST') {
        const { jql } = JSON.parse(request.body) as { jql: string };
        expect(jql).toBe('key in (PROJ-12,OPS-3)');
        return {
          body: {
            issues: [
              {
                key: 'PROJ-12',
                fields: {
                  summary: 'Checkout crashes',
                  description: {
                    type: 'doc',
                    content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Steps' }] }],
                  },
                  issuetype: { name: 'Bug' },
                  status: { statusCategory: { key: 'done' } },
                  labels: ['payments'],
                  created: '2026-01-01T10:00:00.000+0000',
                  updated: '2026-01-02T10:00:00.000+0000',
                  resolutiondate: '2026-01-02T10:00:00.000+0000',
                },
              },
            ],
          },
        };
      }
      return undefined;
    });
    const jira = new JiraClient({
      url,
      token: 'secret',
      email: 'ada@example.com',
      maxRequests: 10,
    });

    expect(await jira.projectKeys()).toEqual(['PROJ', 'OPS']);
    // A key that is not a key never reaches the query.
    const issues = await jira.issues(['PROJ-12', 'OPS-3', 'bad key) OR (1=1']);
    expect(issues).toEqual([
      {
        key: 'PROJ-12',
        title: 'Checkout crashes',
        body: 'Steps',
        state: 'closed',
        url: `${url}/browse/PROJ-12`,
        labels: ['payments', 'type:Bug'],
        createdAt: '2026-01-01T10:00:00.000+0000',
        updatedAt: '2026-01-02T10:00:00.000+0000',
        closedAt: '2026-01-02T10:00:00.000+0000',
      },
    ]);
    const auth = server?.requests[0]?.headers.authorization;
    expect(auth).toBe(`Basic ${Buffer.from('ada@example.com:secret').toString('base64')}`);
  });

  it('sends a Jira token as a bearer token without an email', async () => {
    const url = await start(() => ({ body: [] }));
    await new JiraClient({ url, token: 'pat', maxRequests: 10 }).projectKeys();
    expect(server?.requests[0]?.headers.authorization).toBe('Bearer pat');
  });

  it('reads Linear teams and issues, skipping keys that name no issue', async () => {
    const url = await start((_u, request) => {
      const { query, variables } = JSON.parse(request.body) as {
        query: string;
        variables: Record<string, string>;
      };
      if (query.includes('teams'))
        return { body: { data: { teams: { nodes: [{ key: 'ENG' }] } } } };
      expect(variables).toEqual({ k0: 'ENG-3', k1: 'ENG-404' });
      return {
        body: {
          data: {
            i0: {
              identifier: 'ENG-3',
              title: 'Rounding bug',
              description: null,
              url: 'https://linear.app/acme/issue/ENG-3',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-03T00:00:00.000Z',
              completedAt: '2026-01-03T00:00:00.000Z',
              canceledAt: null,
              state: { type: 'completed' },
              labels: { nodes: [{ name: 'Bug' }] },
            },
            i1: null,
          },
          errors: [{ message: 'Entity not found' }],
        },
      };
    });
    const linear = new LinearClient({ apiKey: 'lin_api_x', url, maxRequests: 10 });

    expect(await linear.projectKeys()).toEqual(['ENG']);
    expect(
      (await linear.issues(['ENG-3', 'ENG-404'])).map((i) => [i.key, i.state, i.labels]),
    ).toEqual([['ENG-3', 'closed', ['Bug']]]);
    expect(server?.requests[0]?.headers.authorization).toBe('lin_api_x');
  });

  it('refuses plain HTTP to anything but the local machine, and keeps to its budget', async () => {
    expect(
      () => new LinearClient({ apiKey: 'k', url: 'http://example.com/graphql', maxRequests: 1 }),
    ).toThrow(/https/);
    const url = await start(() => ({ body: [] }));
    const jira = new JiraClient({ url, token: 't', maxRequests: 1 });
    await jira.projectKeys();
    await expect(jira.projectKeys()).rejects.toThrow(/budget/);
  });
});
