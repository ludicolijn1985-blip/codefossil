import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createFixtureRepo,
  createSampleHistory,
  type FixtureRepo,
  type SampleHistory,
} from '@codefossil/git/testing';
import { startFakeGitHub, type FakeGitHub } from '@codefossil/providers/testing';
import type { CliIO } from './io.js';
import { runCli } from './run.js';

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

type TokenResolver = NonNullable<CliIO['resolveGitHubToken']>;

/** Tests never see the developer's real GitHub credentials. */
const noToken: TokenResolver = () => Promise.resolve(null);

async function fossilWith(
  cwd: string,
  resolveGitHubToken: TokenResolver,
  ...args: string[]
): Promise<Captured> {
  let stdout = '';
  let stderr = '';
  const io: CliIO = {
    cwd,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    resolveGitHubToken,
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}

function fossil(cwd: string, ...args: string[]): Promise<Captured> {
  return fossilWith(cwd, noToken, ...args);
}

describe('fossil CLI', () => {
  let sample: SampleHistory | undefined;

  beforeEach(async () => {
    sample = await createSampleHistory();
  });

  afterEach(async () => {
    await sample?.repo.cleanup();
  });

  const root = (): string => {
    if (!sample) throw new Error('sample history was not created');
    return sample.repo.root;
  };

  it('init creates a self-ignoring .codefossil directory', async () => {
    const result = await fossil(root(), 'init');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('Initialized CODEFOSSIL');
    expect(existsSync(join(root(), '.codefossil', 'fossil.db'))).toBe(true);
    expect(readFileSync(join(root(), '.codefossil', '.gitignore'), 'utf8')).toContain('*');
    // The working tree stays clean: nothing for the user to commit or ignore.
    expect(await sample?.repo.git('status', '--porcelain')).toBe('');
  });

  it('init is idempotent', async () => {
    await fossil(root(), 'init');
    const again = await fossil(root(), 'init', '--json');
    expect(again.code).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ root: root(), created: false });
  });

  it('init, index and status work end to end from a subdirectory', async () => {
    const subdir = join(root(), 'src');
    await fossil(subdir, 'init');

    const before = await fossil(subdir, 'status');
    expect(before.stdout).toContain('never — run `fossil index`');

    const indexed = await fossil(subdir, 'index');
    expect(indexed).toMatchObject({ code: 0, stderr: '' });
    expect(indexed.stdout).toMatch(
      /^Indexed 6 new commits \(0 already indexed\) and 6 file changes; parsed 3 file versions into 2 symbol versions/,
    );

    const status = await fossil(subdir, 'status');
    expect(status.stdout).toContain('Commits       6');
    expect(status.stdout).toContain('Files         4 (2 current)');
    expect(status.stdout).toContain('13 FACT · 3 DERIVED · 0 INFERRED');
  });

  it('prints machine-readable JSON for headless use', async () => {
    await fossil(root(), 'init');
    const indexed = await fossil(root(), 'index', '--json');
    expect(JSON.parse(indexed.stdout)).toMatchObject({ commitsIndexed: 6, relations: 12 });

    const status = JSON.parse((await fossil(root(), 'status', '--json')).stdout) as {
      counts: { commits: number };
      latestCommit: { sha: string };
    };
    expect(status.counts.commits).toBe(6);
    expect(status.latestCommit.sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('indexes incrementally', async () => {
    await fossil(root(), 'init');
    await fossil(root(), 'index');
    const again = JSON.parse((await fossil(root(), 'index', '--json')).stdout) as {
      commitsIndexed: number;
      commitsSkipped: number;
    };
    expect(again).toMatchObject({ commitsIndexed: 0, commitsSkipped: 6 });
  });

  it('accepts --since and rejects an invalid date', async () => {
    await fossil(root(), 'init');
    const bad = await fossil(root(), 'index', '--since', 'last tuesday');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--since must be an ISO date');

    const good = await fossil(root(), 'index', '--since', '2026-01-01T12:00:00Z', '--json');
    expect(good.code).toBe(0);
    expect((JSON.parse(good.stdout) as { commitsIndexed: number }).commitsIndexed).toBeLessThan(6);
  });

  it('operates on another directory with --repo', async () => {
    const elsewhere = await mkdtemp(join(tmpdir(), 'codefossil-cwd-'));
    try {
      expect((await fossil(elsewhere, '--repo', root(), 'init')).code).toBe(0);
      expect((await fossil(elsewhere, '--repo', root(), 'index')).code).toBe(0);
    } finally {
      await rm(elsewhere, { recursive: true, force: true });
    }
  });

  it('shows the symbol tree of a file with each symbol’s origin', async () => {
    await fossil(root(), 'init');
    await fossil(root(), 'index');

    const result = await fossil(join(root(), 'src'), 'symbols', 'tax/vat.ts');

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('src/tax/vat.ts — 1 symbol');
    expect(result.stdout).toMatch(
      /function {2}calculateVAT {2}L1-2 +2 versions +introduced [0-9a-f]{7} 2026-01-01 "Add VAT calculation"/,
    );
  });

  it('prints symbols as JSON and explains unknown paths', async () => {
    await fossil(root(), 'init');
    await fossil(root(), 'index');

    const json = JSON.parse(
      (await fossil(root(), 'symbols', 'src/tax/vat.ts', '--json')).stdout,
    ) as {
      path: string;
      symbols: { stableKey: string; introducedBy: { sha: string } | null }[];
    };
    expect(json.path).toBe('src/tax/vat.ts');
    expect(json.symbols[0]).toMatchObject({
      stableKey: 'function:calculateVAT',
      introducedBy: { sha: sample?.shas.addVat },
    });

    const missing = await fossil(root(), 'symbols', 'nope.ts');
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('No indexed history for nope.ts');

    const outside = await fossil(root(), 'symbols', '../elsewhere.ts');
    expect(outside.code).toBe(1);
    expect(outside.stderr).toContain('is not a file inside');
  });

  it('refuses a .codefossil symlink planted by the repository', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'codefossil-outside-'));
    try {
      // Junctions need no special privileges on Windows; elsewhere use a dir symlink.
      await symlink(
        outside,
        join(root(), '.codefossil'),
        platform() === 'win32' ? 'junction' : 'dir',
      );

      const result = await fossil(root(), 'init');

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/symbolic link|resolves outside/);
      expect(readdirSync(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('refuses a .codefossil directory committed to the repository', async () => {
    await sample?.repo.write('.codefossil/fossil.db', 'crafted');
    await sample?.repo.commit('Ship a database');

    const result = await fossil(root(), 'init');

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is committed to this repository');
  });

  it('asks for init before index or status', async () => {
    const result = await fossil(root(), 'status');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Run `fossil init` first');
  });
});

describe('fossil deps', () => {
  let repo: FixtureRepo | undefined;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.write('package.json', JSON.stringify({ name: 'shop', dependencies: { zod: '^4' } }));
    await repo.write(
      'src/app.ts',
      "import { vat } from './vat.js';\nimport { z } from 'zod';\nimport pad from 'left-pad';\n",
    );
    await repo.write('src/vat.ts', 'export const vat = 0.21;\n');
    await repo.commit('Shop');
  });

  afterEach(async () => {
    await repo?.cleanup();
  });

  const root = (): string => {
    if (!repo) throw new Error('fixture repo was not created');
    return repo.root;
  };

  it('reports the graph when indexing', async () => {
    await fossil(root(), 'init');
    const indexed = await fossil(root(), 'index');
    expect(indexed.stdout).toContain(
      'Dependency graph (full): 1 file import edge, 1 package dependency edge, 1 declared dependency; 1 import left unresolved.',
    );
  });

  it('lists declared dependencies with their usage', async () => {
    await fossil(root(), 'init');
    await fossil(root(), 'index');
    const result = await fossil(root(), 'deps');
    expect(result.stdout).toMatch(/^1 dependency\n/);
    expect(result.stdout).toMatch(/npm +zod +\^4 +runtime +package\.json +imported by 1 file/);
  });

  it('shows what a file imports, including why an import is unresolved, and who imports it', async () => {
    await fossil(root(), 'init');
    await fossil(root(), 'index');

    const app = await fossil(root(), 'deps', 'src/app.ts');
    expect(app.stdout).toContain('Imports (3)');
    expect(app.stdout).toMatch(/L1 +\.\/vat\.js +→ src\/vat\.ts/);
    expect(app.stdout).toMatch(/L2 +zod +→ npm:zod \(declared dependency\)/);
    expect(app.stdout).toMatch(/L3 +left-pad +✗ unresolved: package left-pad is not declared/);

    const vat = JSON.parse((await fossil(root(), 'deps', 'src/vat.ts', '--json')).stdout) as {
      importedBy: { path: string }[];
    };
    expect(vat.importedBy).toEqual([{ path: 'src/app.ts', confidence: 1 }]);
  });
});

describe('fossil connect github and GitHub sync', () => {
  let repo: FixtureRepo | undefined;
  let server: FakeGitHub | undefined;

  const issue = {
    number: 1,
    title: 'VAT is wrong',
    body: null,
    state: 'closed',
    html_url: 'https://github.com/acme/shop/issues/1',
    created_at: '2026-01-01T09:00:00Z',
    updated_at: '2026-01-01T10:00:00Z',
    closed_at: '2026-01-02T09:00:00Z',
    user: { login: 'ada' },
    labels: ['bug'],
  };

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.git('remote', 'add', 'origin', 'https://github.com/acme/shop.git');
    await repo.write('vat.ts', 'export const vat = 0.21;\n');
    await repo.commit('Fix VAT\n\nFixes #1');
    server = await startFakeGitHub((url) => {
      if (url.pathname === '/repos/acme/shop') {
        return { body: { full_name: 'acme/shop', private: true, default_branch: 'main' } };
      }
      if (url.pathname === '/repos/acme/shop/issues') return { body: [issue] };
      return undefined;
    });
  });

  afterEach(async () => {
    await server?.close();
    await repo?.cleanup();
  });

  const root = (): string => repo?.root ?? '';
  const apiUrl = (): string => server?.apiUrl ?? '';
  const withToken = (token: string | null) => () =>
    Promise.resolve(token ? { token, source: 'GITHUB_TOKEN' as const } : null);

  it('connects after verifying access with the resolved token, and syncs on index', async () => {
    await fossil(root(), 'init');
    const connected = await fossilWith(
      root(),
      withToken('test-token'),
      'connect',
      'github',
      'acme/shop',
      '--api-url',
      apiUrl(),
    );
    expect(connected).toMatchObject({ code: 0, stderr: '' });
    expect(connected.stdout).toContain('Connected to GitHub repository acme/shop.');
    expect(server?.requests[0]?.headers.authorization).toBe('Bearer test-token');

    const indexed = await fossilWith(root(), withToken('test-token'), 'index');
    expect(indexed.stdout).toContain('GitHub acme/shop: synced 1 issue and 0 pull requests');
    expect(indexed.stdout).toContain('1 issue resolution');

    const status = await fossil(root(), 'status');
    expect(status.stdout).toMatch(/GitHub +acme\/shop — 1 issue, 0 pull requests; last synced 20/);
  });

  it('derives the repository from the origin remote and can skip verification', async () => {
    await fossil(root(), 'init');
    const result = await fossil(root(), 'connect', 'github', '--no-verify', '--json');
    expect(JSON.parse(result.stdout)).toEqual({
      provider: 'github',
      owner: 'acme',
      name: 'shop',
      apiUrl: 'https://api.github.com',
      verified: false,
    });
  });

  it('never lets a repository remote choose where a token is sent', async () => {
    await repo?.git('remote', 'set-url', 'origin', 'https://evil.example/acme/shop.git');
    await fossil(root(), 'init');
    const asked: string[] = [];
    const result = await fossilWith(
      root(),
      (host) => {
        asked.push(host);
        return Promise.resolve({ token: 'secret', source: 'GITHUB_TOKEN' });
      },
      'connect',
      'github',
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('points at evil.example, not github.com');
    expect(result.stderr).toContain('--api-url');
    expect(asked).toEqual([]);
  });

  it('refuses insecure API URLs and explains failed verification', async () => {
    await fossil(root(), 'init');
    const insecure = await fossil(
      root(),
      'connect',
      'github',
      'acme/shop',
      '--api-url',
      'http://example.com',
    );
    expect(insecure.code).toBe(1);
    expect(insecure.stderr).toContain('must use https');

    const missing = await fossilWith(
      root(),
      withToken('t'),
      'connect',
      'github',
      'acme/other',
      '--api-url',
      apiUrl(),
    );
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('--no-verify');
  });

  it('stays offline on request and warns when syncing without a token', async () => {
    await fossil(root(), 'init');
    await fossil(root(), 'connect', 'github', 'acme/shop', '--api-url', apiUrl(), '--no-verify');

    const offline = await fossilWith(root(), withToken('t'), 'index', '--offline');
    expect(offline.stdout).toContain('GitHub acme/shop: offline');
    expect(server?.requests).toHaveLength(0);

    const anonymous = await fossilWith(root(), withToken(null), 'index');
    expect(anonymous.stderr).toContain('No GitHub token found');
    expect(server?.requests[0]?.headers.authorization).toBeUndefined();

    const bad = await fossil(root(), 'index', '--github-max-requests', 'lots');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--github-max-requests must be a positive whole number');
  });
});

describe('fossil CLI outside a repository', () => {
  let plain: string;

  beforeEach(async () => {
    plain = await mkdtemp(join(tmpdir(), 'codefossil-plain-'));
  });

  afterEach(async () => {
    await rm(plain, { recursive: true, force: true });
  });

  it('fails clearly when not inside a Git repository', async () => {
    const result = await fossil(plain, 'init');
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/is not inside a Git repository/);
  });

  it('rejects unknown commands with a non-zero exit code', async () => {
    const result = await fossil(plain, 'excavate');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("unknown command 'excavate'");
  });

  it('prints its version', async () => {
    const result = await fossil(plain, '--version');
    expect(result).toMatchObject({ code: 0, stdout: '0.1.0\n' });
  });
});
