import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { paged, startFakeGitHub, type FakeGitHub, type FakeRoute } from '../testing/index.js';
import {
  GitHubApiError,
  GitHubClient,
  GitHubRateLimitError,
  RequestBudgetExhaustedError,
  validateApiUrl,
} from './client.js';
import { resolveGitHubToken } from './token.js';

const item = z.object({ n: z.number() });

describe('GitHubClient', () => {
  let server: FakeGitHub | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  async function client(route: FakeRoute, maxRequests = 10, token: string | null = 'secret-token') {
    server = await startFakeGitHub(route);
    return new GitHubClient({ apiUrl: server.apiUrl, token, maxRequests });
  }

  it('sends the token and API headers and follows Link pagination', async () => {
    const items = [{ n: 1 }, { n: 2 }, { n: 3 }];
    const github = await client((url) =>
      url.pathname === '/things' ? paged(url, items) : undefined,
    );

    const first = await github.getList('/things', item, { state: 'all' });
    expect(first.items).toEqual([{ n: 1 }, { n: 2 }]);
    expect(first.nextUrl).not.toBeNull();
    const second = await github.getNext(first.nextUrl ?? '', item);
    expect(second).toEqual({ items: [{ n: 3 }], nextUrl: null });

    const [request] = server?.requests ?? [];
    expect(request?.headers.authorization).toBe('Bearer secret-token');
    expect(request?.headers['x-github-api-version']).toBe('2022-11-28');
    expect(request?.url.searchParams.get('per_page')).toBe('100');
    expect(request?.url.searchParams.get('state')).toBe('all');
    expect(github.requestsMade).toBe(2);
  });

  it('omits Authorization when unauthenticated', async () => {
    const github = await client(() => ({ body: [] }), 10, null);
    await github.getList('/things', item);
    expect(server?.requests[0]?.headers.authorization).toBeUndefined();
  });

  it('refuses to follow a pagination link to another host', async () => {
    const github = await client(() => ({ body: [] }));
    await expect(github.getNext('https://evil.example/steal', item)).rejects.toThrow(
      /Refusing to follow a pagination link/,
    );
    expect(server?.requests).toHaveLength(0);
  });

  it('reports primary and secondary rate limits with their reset time', async () => {
    const primary = await client(() => ({
      status: 403,
      headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000' },
      body: { message: 'API rate limit exceeded' },
    }));
    const error = await primary.getList('/things', item).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubRateLimitError);
    expect((error as GitHubRateLimitError).resetAt?.toISOString()).toBe('2027-01-15T08:00:00.000Z');
    await server?.close();

    const secondary = await client(() => ({
      status: 429,
      headers: { 'retry-after': '60' },
      body: {},
    }));
    await expect(secondary.getList('/things', item)).rejects.toBeInstanceOf(GitHubRateLimitError);
  });

  it('explains authentication and access failures without echoing the token', async () => {
    const unauthorized = await client(() => ({ status: 401, body: {} }));
    const error = await unauthorized.getList('/things', item).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(String(error)).toContain('401');
    expect(String(error)).not.toContain('secret-token');
    await server?.close();

    const missing = await client(() => undefined);
    await expect(missing.getList('/repos/a/b', item)).rejects.toThrow(/may be private/);
  });

  it('rejects responses that do not match the expected shape', async () => {
    const github = await client(() => ({ body: [{ n: 'not a number' }] }));
    await expect(github.getList('/things', item)).rejects.toThrow(/Unexpected response shape/);
  });

  it('refuses oversized responses instead of buffering them', async () => {
    server = await startFakeGitHub(() => ({ body: [{ n: 1, padding: 'x'.repeat(5_000) }] }));
    const github = new GitHubClient({
      apiUrl: server.apiUrl,
      token: null,
      maxRequests: 5,
      maxResponseBytes: 1_000,
    });
    await expect(github.getList('/things', item)).rejects.toThrow(/exceeds 1000 bytes/);
  });

  it('stops at the request budget', async () => {
    const github = await client(() => ({ body: [] }), 1);
    await github.getList('/things', item);
    await expect(github.getList('/things', item)).rejects.toBeInstanceOf(
      RequestBudgetExhaustedError,
    );
    expect(server?.requests).toHaveLength(1);
  });
});

describe('validateApiUrl', () => {
  it('requires https except on the local machine', () => {
    expect(validateApiUrl('https://api.github.com').host).toBe('api.github.com');
    expect(validateApiUrl('http://127.0.0.1:8080').port).toBe('8080');
    expect(() => validateApiUrl('http://api.github.com')).toThrow(/must use https/);
    expect(() => validateApiUrl('not a url')).toThrow(/Invalid GitHub API URL/);
  });
});

describe('resolveGitHubToken', () => {
  const noCli = () => Promise.resolve(null);

  it('prefers GITHUB_TOKEN, then GH_TOKEN, then the GitHub CLI', async () => {
    expect(
      await resolveGitHubToken('github.com', { GITHUB_TOKEN: 'a', GH_TOKEN: 'b' }, noCli),
    ).toEqual({
      token: 'a',
      source: 'GITHUB_TOKEN',
    });
    expect(await resolveGitHubToken('github.com', { GH_TOKEN: ' b ' }, noCli)).toEqual({
      token: 'b',
      source: 'GH_TOKEN',
    });
    expect(
      await resolveGitHubToken('github.com', {}, (host) => Promise.resolve(`cli-${host}`)),
    ).toEqual({ token: 'cli-github.com', source: 'gh auth token' });
    expect(await resolveGitHubToken('github.com', { GITHUB_TOKEN: '  ' }, noCli)).toBeNull();
  });

  it('never offers a github.com token to another host', async () => {
    const env = { GITHUB_TOKEN: 'dotcom', GH_TOKEN: 'dotcom-too' };
    expect(await resolveGitHubToken('evil.example', env, noCli)).toBeNull();
    expect(
      await resolveGitHubToken('git.corp.example', { ...env, GH_ENTERPRISE_TOKEN: 'corp' }, noCli),
    ).toEqual({ token: 'corp', source: 'GH_ENTERPRISE_TOKEN' });
  });

  it('asks the GitHub CLI only about well-formed host names', async () => {
    const asked: string[] = [];
    const cli = (host: string) => {
      asked.push(host);
      return Promise.resolve(null);
    };
    await resolveGitHubToken('--help', {}, cli);
    await resolveGitHubToken('host name', {}, cli);
    await resolveGitHubToken('Git.Corp.Example', {}, cli);
    expect(asked).toEqual(['git.corp.example']);
  });
});
