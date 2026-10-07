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
import { graphDocumentSchema } from '@codefossil/query';
import type { CliIO } from './io.js';
import { runCli } from './run.js';
import { VERSION } from './version.js';

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
    // Tests never see the developer's tracker credentials either.
    env: {},
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
    expect(before.stdout).toContain('never — run `codefossil index`');

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

  it('owners covers the whole repository for . at the root', async () => {
    await fossil(root(), 'index');
    const all = JSON.parse((await fossil(root(), 'owners', '.', '--json')).stdout) as {
      scope: unknown;
    };
    expect(all.scope).toBeNull();
    const scoped = JSON.parse((await fossil(root(), 'owners', 'src', '--json')).stdout) as {
      scope: unknown;
    };
    expect(scoped.scope).toBe('src');
  });

  it('gc trims the parse cache and compacts the index', async () => {
    await fossil(root(), 'index');
    const result = await fossil(root(), 'gc', '--max-cache', '0', '--json');
    expect(result.code).toBe(0);
    const gc = JSON.parse(result.stdout) as { cacheEntriesRemoved: number; bytesAfter: number };
    expect(gc.cacheEntriesRemoved).toBeGreaterThan(0);
    expect(gc.bytesAfter).toBeGreaterThan(0);
    expect((await fossil(root(), 'gc', '--max-cache', 'many')).code).not.toBe(0);
    // Answers still work after compaction.
    expect((await fossil(root(), 'status')).code).toBe(0);
  });

  it('connects GitLab projects, implying only gitlab.com', async () => {
    await fossil(root(), 'init');
    const ok = await fossil(root(), 'connect', 'gitlab', 'acme/sub/shop', '--no-verify', '--json');
    expect(JSON.parse(ok.stdout)).toEqual({
      provider: 'gitlab',
      project: 'acme/sub/shop',
      apiUrl: 'https://gitlab.com/api/v4',
      verified: false,
    });
    expect((await fossil(root(), 'connect', 'gitlab')).stderr).toContain('not a GitLab URL');
    expect((await fossil(root(), 'connect', 'gitlab', 'shop', '--no-verify')).stderr).toContain(
      'not a group/name project path',
    );
    expect(
      (
        await fossil(
          root(),
          'connect',
          'gitlab',
          'a/b',
          '--api-url',
          'http://gitlab.example',
          '--no-verify',
        )
      ).stderr,
    ).toMatch(/https/);
    const index = await fossil(root(), 'index', '--offline');
    expect(index.stdout).toContain('GitLab acme/sub/shop: offline, linked stored data');
  });

  it('connects Jira and Linear, validating the site and project keys', async () => {
    await fossil(root(), 'init');
    const jira = await fossil(
      root(),
      'connect',
      'jira',
      'https://acme.atlassian.net/',
      '--projects',
      'proj, ops',
      '--json',
    );
    expect(JSON.parse(jira.stdout)).toEqual({
      provider: 'jira',
      apiUrl: 'https://acme.atlassian.net',
      projects: ['PROJ', 'OPS'],
    });
    expect((await fossil(root(), 'connect', 'jira', 'http://acme.example')).stderr).toMatch(
      /https/,
    );
    expect(
      (await fossil(root(), 'connect', 'jira', 'https://a.example', '--projects', 'a-b')).stderr,
    ).toMatch(/Not a project key/);
    expect((await fossil(root(), 'connect', 'linear')).code).toBe(0);

    // Without credentials both stay offline and say so; indexing still succeeds.
    const index = await fossil(root(), 'index');
    expect(index.code).toBe(0);
    expect(index.stderr).toContain('No JIRA_API_TOKEN set');
    expect(index.stderr).toContain('No LINEAR_API_KEY set');
    expect(index.stdout).toContain('Jira: offline, 0 references linked.');
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

  it('asks for init before status', async () => {
    const result = await fossil(root(), 'status');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Run `codefossil init` first');
  });

  it('creates the workspace when index runs first', async () => {
    const result = await fossil(root(), 'index', '--offline');
    expect(result.code).toBe(0);
    expect(existsSync(join(root(), '.codefossil', 'fossil.db'))).toBe(true);
    expect((await fossil(root(), 'status')).code).toBe(0);
  });
});

describe('codefossil deps', () => {
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
      'Dependency graph (full): 1 file import edge, 1 package dependency edge, 1 declared dependency; 1 import left unresolved; 0 call edges from 0 call sites.',
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

describe('codefossil connect github and GitHub sync', () => {
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

describe('codefossil trace and export', () => {
  let sample: SampleHistory | undefined;

  beforeEach(async () => {
    sample = await createSampleHistory();
    await sample.repo.write('src/tax/helpers.ts', 'export function calculateVAT() {}\n');
    await sample.repo.commit('Add a second calculateVAT');
    await fossil(sample.repo.root, 'init');
    await fossil(sample.repo.root, 'index');
  });

  afterEach(async () => {
    await sample?.repo.cleanup();
  });

  const root = (): string => sample?.repo.root ?? '';

  it('traces the origin of a symbol with provenance and evidence', async () => {
    const result = await fossil(root(), 'trace', 'src/tax/vat.ts:calculateVAT');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('Origin of function calculateVAT (src/tax/vat.ts:1)');
    expect(result.stdout).toMatch(
      /→ introduced by [0-9a-f]{7} Add VAT calculation +\[DERIVED 1\.00 · symbol-indexer@0\.1\.0 first-indexed-version\]/,
    );
    expect(result.stdout).toMatch(/evidence: src\/payment\/vat\.ts@[0-9a-f]{40}#L1-L1/);
  });

  it('asks for a more specific target when a name is ambiguous', async () => {
    const result = await fossil(root(), 'trace', 'calculateVAT');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"calculateVAT" matches 2 entities');
    expect(result.stderr).toContain('function calculateVAT (src/tax/helpers.ts:1)');
  });

  it('accepts paths relative to the current directory and other routes', async () => {
    const history = await fossil(
      join(root(), 'src', 'tax'),
      'trace',
      'vat.ts',
      '--route',
      'history',
    );
    expect(history.stdout).toContain('History of src/tax/vat.ts');
    expect(history.stdout).toContain('modified by');

    const bad = await fossil(root(), 'trace', 'src/tax/vat.ts', '--route', 'sideways');
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('--route must be one of origin, history, impact');

    const missing = await fossil(root(), 'trace', 'noSuchThing');
    expect(missing.stderr).toContain('Nothing in the index matches "noSuchThing"');
  });

  it('exports a valid graph document to a file or stdout', async () => {
    const written = await fossil(root(), 'export', 'graph.json');
    expect(written.stdout).toMatch(/^Exported \d+ nodes, \d+ edges and \d+ evidence records to /);
    const document: unknown = JSON.parse(readFileSync(join(root(), 'graph.json'), 'utf8'));
    expect(graphDocumentSchema.safeParse(document).success).toBe(true);

    const piped = await fossil(root(), 'export', '-', '--root', 'src/tax/vat.ts', '--depth', '1');
    const scoped = graphDocumentSchema.parse(JSON.parse(piped.stdout));
    expect(scoped.scope).toMatchObject({ depth: 1 });
    expect(scoped.nodes.some((n) => n.label === 'src/tax/vat.ts')).toBe(true);
  });
});

describe('codefossil why, impact, timeline, query and investigate', () => {
  let sample: SampleHistory | undefined;

  beforeEach(async () => {
    sample = await createSampleHistory();
    await fossil(sample.repo.root, 'init');
    await fossil(sample.repo.root, 'index');
  });

  afterEach(async () => {
    await sample?.repo.cleanup();
  });

  const root = (): string => sample?.repo.root ?? '';

  async function session(lines: string[]): Promise<Captured> {
    let stdout = '';
    let stderr = '';
    const code = await runCli(['investigate'], {
      cwd: root(),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      resolveGitHubToken: noToken,
      // eslint-disable-next-line @typescript-eslint/require-await
      readLines: async function* () {
        yield* lines;
      },
    });
    return { code, stdout, stderr };
  }

  it('explains why, with statements, evidence and a saved investigation', async () => {
    const result = await fossil(root(), 'why', 'calculateVAT');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('Why does function calculateVAT (src/tax/vat.ts:1) exist?');
    expect(result.stdout).toMatch(/It was introduced in commit [0-9a-f]{7} "Add VAT calculation"/);
    expect(result.stdout).toContain('Confidence 1.00 · DERIVED');
    expect(result.stdout).toMatch(/Evidence\n {2}\[\d+\] ast_node/);
    expect(result.stdout).toContain('Saved as investigation #1');
  });

  it('answers in the API.md JSON shape', async () => {
    const result = await fossil(root(), 'why', 'src/tax/vat.ts', '--json', '--no-save');
    const answer = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(answer).toMatchObject({
      classification: 'FACT',
      confidence: 1,
      investigationId: null,
      related: [],
    });
    expect(typeof answer.answer).toBe('string');
    expect(answer.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'commit', reason: 'creating commit' }),
      ]),
    );
  });

  it('shows impact and a timeline across a rename', async () => {
    const impact = await fossil(root(), 'impact', 'src/tax/vat.ts', '--no-save');
    expect(impact.stdout).toContain('Nothing in the index depends on src/tax/vat.ts.');

    const timeline = await fossil(root(), 'timeline', 'src/tax/vat.ts');
    expect(timeline.stdout).toContain(
      'Timeline of src/tax/vat.ts (formerly src/payment/vat.ts) — 3 changes',
    );
    expect(timeline.stdout).toMatch(/renamed +src\/payment\/vat\.ts → src\/tax\/vat\.ts/);
    expect(timeline.stdout).toContain('symbols: calculateVAT');

    const notAFile = await fossil(root(), 'timeline', 'calculateVAT');
    expect(notAFile.stderr).toContain('A timeline is built for a file');
  });

  it('answers recognized questions and says which questions it can answer', async () => {
    const why = await fossil(root(), 'query', 'Why does calculateVAT exist?');
    expect(why.stdout).toContain('It was introduced in commit');
    const history = await fossil(root(), 'query', 'what changed in src/tax/vat.ts?');
    expect(history.stdout).toContain('Timeline of src/tax/vat.ts');

    const open = await fossil(root(), 'query', 'Summarize the architecture');
    expect(open.code).toBe(1);
    expect(open.stderr).toContain('Open-ended questions need the optional AI layer');
  });

  it('asks again rather than answering about a vaguer word when the subject is ambiguous', async () => {
    await sample?.repo.write('src/tax/helpers.ts', 'export function calculateVAT() {}\n');
    await sample?.repo.commit('Second calculateVAT');
    await fossil(root(), 'index');

    const result = await fossil(root(), 'query', 'Why does calculateVAT use README.md?');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('"calculateVAT" matches 2 entities');
  });

  it('runs an investigation session from input lines and keeps going after errors', async () => {
    const result = await session([
      'why calculateVAT',
      'what depends on nothingHere?',
      'list',
      'exit',
      'why this is never read',
    ]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('It was introduced in commit');
    expect(result.stderr).toContain('The question names nothing found in the index');
    expect(result.stdout).toMatch(/#1 +\d{4}-\d{2}-\d{2} [\d:]+ +why +1\.00 DERIVED +Why does/);

    const shown = await fossil(root(), 'investigate', '--show', '1');
    expect(shown.stdout).toMatch(/^Investigation #1 from .*later history may change the answer/);
    expect(shown.stdout).toContain('It was introduced in commit');
  });
});

describe('codefossil hotspots and dead-intent', () => {
  let sample: SampleHistory | undefined;

  beforeEach(async () => {
    sample = await createSampleHistory();
    await sample.repo.write(
      'src/tax/vat.ts',
      'export const calculateVAT = (n: number) => n * 0.21;\n',
    );
    await sample.repo.commit('fix: drop the reduced rate');
    await fossil(sample.repo.root, 'init');
    await fossil(sample.repo.root, 'index');
  });

  afterEach(async () => {
    await sample?.repo.cleanup();
  });

  const root = (): string => sample?.repo.root ?? '';

  it('shows hotspots with both scores and their components', async () => {
    const result = await fossil(root(), 'hotspots', '--limit', '1');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('1. src/tax/vat.ts');
    expect(result.stdout).toMatch(/hotspot \d\.\d\d = change 1\.00 × churn/);
    expect(result.stdout).toContain('× untested');
    expect(result.stdout).toContain('fix: drop the reduced rate  — subject is marked as a fix');

    const json = await fossil(root(), 'hotspots', '--order', 'risk', '--json');
    expect(JSON.parse(json.stdout)).toMatchObject({ orderBy: 'risk' });
  });

  it('validates hotspot options', async () => {
    expect((await fossil(root(), 'hotspots', '--limit', '0')).stderr).toContain(
      '--limit must be a positive whole number',
    );
    expect((await fossil(root(), 'hotspots', '--since', 'soon')).stderr).toContain(
      '--since must be an ISO date',
    );
    expect((await fossil(root(), 'hotspots', '--order', 'size')).code).not.toBe(0);
  });

  it('lists dead-intent candidates as inferences with their signals', async () => {
    const result = await fossil(root(), 'dead-intent');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toMatch(
      /1\. \w+ calculateVAT \(src\/tax\/vat\.ts:1\) {3}INFERRED 0\.\d\d/,
    );
    expect(result.stdout).toContain('changed by');
    expect(result.stdout).toContain('says "Workaround": Workaround for legacy invoices.');

    const json = JSON.parse((await fossil(root(), 'dead-intent', '--json')).stdout) as {
      candidates: { classification: string }[];
    };
    expect(json.candidates.every((c) => c.classification === 'INFERRED')).toBe(true);
  });
});

describe('automatic indexing', () => {
  let sample: SampleHistory | undefined;

  beforeEach(async () => {
    sample = await createSampleHistory();
  });

  afterEach(async () => {
    delete process.env.CODEFOSSIL_AUTO_INDEX;
    await sample?.repo.cleanup();
  });

  const root = (): string => sample?.repo.root ?? '';

  it('answers the first question in a repository without init or index', async () => {
    const result = await fossil(root(), 'why', 'calculateVAT', '--json', '--no-save');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('First use in');
    expect(result.stderr).toContain('Indexed');
    expect(JSON.parse(result.stdout)).toMatchObject({ kind: 'why' });
    expect(await sample?.repo.git('status', '--porcelain')).toBe('');
  });

  it('adds only new commits on later questions, and stays quiet when up to date', async () => {
    await fossil(root(), 'hotspots');
    const quiet = await fossil(root(), 'hotspots');
    expect(quiet.stderr).toBe('');
    await sample?.repo.write(
      'src/tax/vat.ts',
      'export const calculateVAT = (n: number) => n * 0.2;\n',
    );
    await sample?.repo.commit('Lower the rate');
    const later = await fossil(root(), 'timeline', 'src/tax/vat.ts');
    expect(later.stderr).toContain('Indexing new commits');
    expect(later.stderr).toContain('Indexed 1 new commit');
    expect(later.stdout).toContain('Lower the rate');
  });

  it('doctor checks the toolchain and reports the index state', async () => {
    const before = await fossil(root(), 'doctor');
    expect(before.code).toBe(0);
    expect(before.stdout).toMatch(/✓ Parsers +typescript, tsx, javascript, python, go, rust/);
    expect(before.stdout).toContain('none yet; the first question creates it');
    await fossil(root(), 'hotspots');
    const checks = JSON.parse((await fossil(root(), 'doctor', '--json')).stdout) as {
      name: string;
      ok: boolean;
      detail: string;
    }[];
    expect(checks.every((c) => c.ok)).toBe(true);
    expect(checks.find((c) => c.name === 'Index')?.detail).toMatch(/^\d+ commits/);
  });

  /** Index a commit on a branch, then leave the branch and delete it. */
  const indexAbandonedCommit = async () => {
    const repo = sample?.repo;
    if (!repo) throw new Error('sample history was not created');
    await repo.git('checkout', '-q', '-b', 'demo-pr');
    await repo.write(
      'src/tax/vat.ts',
      'export const calculateVAT = (n: number) => n * 0.19; // demo\n',
    );
    await repo.commit('demo: try a lower rate');
    const before = await fossil(root(), 'why', 'calculateVAT', '--no-save');
    expect(before.stdout).toContain('demo: try a lower rate');
    await repo.git('checkout', '-q', 'main');
    await repo.git('branch', '-q', '-D', 'demo-pr');
  };

  it('drops commits HEAD no longer contains before answering', async () => {
    await indexAbandonedCommit();
    const after = await fossil(root(), 'why', 'calculateVAT', '--no-save');
    expect(after.code).toBe(0);
    expect(after.stderr).toContain('HEAD left the indexed history');
    expect(after.stderr).toContain("Removed 1 commit that HEAD's history no longer contains");
    expect(after.stdout).not.toContain('demo: try a lower rate');
    expect(after.stdout).toContain('most recently in commit');
    expect(after.stdout).toContain('Handle reduced VAT rate');
  });

  it('warns when automatic indexing is off and HEAD left the indexed history', async () => {
    await indexAbandonedCommit();
    process.env.CODEFOSSIL_AUTO_INDEX = '0';
    const result = await fossil(root(), 'why', 'calculateVAT', '--no-save');
    expect(result.stderr).toMatch(
      /Warning: The index was built at [0-9a-f]{7}, which is not in the history of HEAD/,
    );
    const report = await fossil(root(), 'report');
    expect(report.stdout).toContain('> **Warning:** The index was built at');
    const status = await fossil(root(), 'status', '--json');
    expect(JSON.parse(status.stdout)).toMatchObject({ head: { freshness: 'diverged' } });
  });

  it('can be turned off to use the index exactly as it is', async () => {
    process.env.CODEFOSSIL_AUTO_INDEX = '0';
    const result = await fossil(root(), 'why', 'calculateVAT');
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('Run `codefossil init` first');
  });
});

describe('codefossil report', () => {
  let sample: SampleHistory | undefined;

  beforeEach(async () => {
    sample = await createSampleHistory();
    await sample.repo.write(
      'src/tax/vat.ts',
      'export const calculateVAT = (n: number) => n * 0.21;\n',
    );
    await sample.repo.write('src/checkout.ts', "import { calculateVAT } from './tax/vat.js';\n");
    await sample.repo.commit('fix: | injected <b>row</b> for @someone');
    await fossil(sample.repo.root, 'init');
    await fossil(sample.repo.root, 'index');
  });

  afterEach(async () => {
    await sample?.repo.cleanup();
  });

  const root = (): string => sample?.repo.root ?? '';

  it('writes a markdown report a CI job can post', async () => {
    const result = await fossil(root(), 'report', '--limit', '3');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout.startsWith('<!-- codefossil-report -->\n## CODEFOSSIL report')).toBe(true);
    expect(result.stdout).toContain('### Historical hotspots');
    expect(result.stdout).toContain('| 1 | `src/tax/vat.ts` |');
    expect(result.stdout).toContain('### Dead-intent candidates (INFERRED)');
    expect(result.stdout).not.toContain('Files changed since');
  });

  it('reports the files changed since a base, with their dependents', async () => {
    const result = await fossil(root(), 'report', '--base', 'HEAD~1');
    expect(result.stdout).toContain('### Files changed since `HEAD~1` (2)');
    expect(result.stdout).toMatch(/\| `src\/tax\/vat\.ts` \| #\d+ · \d+ commits, 1 defect \|/);
    expect(result.stdout).toContain('1 direct, 0 transitive e.g. `src/checkout.ts`');
    const json = JSON.parse(
      (await fossil(root(), 'report', '--base', 'HEAD~1', '--json')).stdout,
    ) as {
      changedTotal: number;
    };
    expect(json.changedTotal).toBe(2);
  });

  it('warns first about changed code that earlier fixes touched, with their text defused', async () => {
    await sample?.repo.write(
      'src/tax/vat.ts',
      'export const calculateVAT = (n: number) => Math.round(n * 21) / 100;\n',
    );
    await sample?.repo.commit('Round VAT');

    const result = await fossil(root(), 'report', '--base', 'HEAD~1');

    const warning = result.stdout.indexOf('### ⚠️ Changed code that broke before');
    expect(warning).toBeGreaterThan(0);
    expect(warning).toBeLessThan(result.stdout.indexOf('### Files changed since'));
    expect(result.stdout).toContain('`calculateVAT` (function) in `src/tax/vat.ts:1`');
    expect(result.stdout).toContain('**1 earlier fix**');
    // The fix commit's subject is repository text: no table break, no HTML, no notification.
    expect(result.stdout).toContain('fix: \\| injected \\<b\\>row\\</b\\> for @​someone');
    // The repository-wide sections fold away under the change.
    expect(result.stdout).toContain(
      '<summary>Repository hotspots and dead-intent candidates</summary>',
    );
  });

  it('lists the functions a change touches, with what happened to them', async () => {
    await sample?.repo.write(
      'src/tax/rates.ts',
      'export function reducedRate() {\n  return 0.09;\n}\n',
    );
    await sample?.repo.commit('Add reduced rate');

    const result = await fossil(root(), 'report', '--base', 'HEAD~1');

    expect(result.stdout).toContain('### Functions this change touches (1)');
    expect(result.stdout).toContain('| `reducedRate` `src/tax/rates.ts:1` | new | — |');
    expect(result.stdout).toContain('No current coverage report');
  });

  it('says so when no changed symbol has earlier fixes', async () => {
    const result = await fossil(root(), 'report', '--base', 'HEAD~1');
    expect(result.stdout).toContain(
      'No changed function or class has earlier fixes in its history',
    );
  });

  it('refuses bases that are options or not commits', async () => {
    expect((await fossil(root(), 'report', '--base=--output=/tmp/x')).stderr).toContain(
      '--base must be a revision',
    );
    expect((await fossil(root(), 'report', '--base', 'no-such-branch')).stderr).toContain(
      'is not a commit in this repository',
    );
    expect((await fossil(root(), 'report', '--base', 'a..b')).stderr).toContain(
      'is not a commit in this repository',
    );
  });
});

describe('codefossil ai, ask and why --summarize', () => {
  let sample: SampleHistory | undefined;
  const prompts: string[] = [];

  /** Cites the first evidence id it is shown; contacts nothing. */
  const fakeProvider: NonNullable<CliIO['createAiProvider']> = (config) => ({
    name: config.provider,
    model: config.model,
    cloud: false,
    complete(request) {
      prompts.push(request.prompt);
      const id = Number(/"id": (\d+)/.exec(request.prompt)?.[1]);
      const output = request.schema.parse({
        answer: 'The evidence ties it to legacy invoices.',
        unanswerable: false,
        claims: [
          { text: 'Legacy invoices needed it.', evidenceIds: [id], confidence: 0.9 },
          { text: 'Made up.', evidenceIds: [424242], confidence: 0.9 },
        ],
        caveats: [],
      });
      return Promise.resolve({ output, model: config.model });
    },
  });

  async function run(...args: string[]): Promise<Captured> {
    let stdout = '';
    let stderr = '';
    const code = await runCli(args, {
      cwd: root(),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      resolveGitHubToken: noToken,
      createAiProvider: fakeProvider,
    });
    return { code, stdout, stderr };
  }

  beforeEach(async () => {
    prompts.length = 0;
    sample = await createSampleHistory();
    await fossil(sample.repo.root, 'init');
    await fossil(sample.repo.root, 'index');
  });

  afterEach(async () => {
    await sample?.repo.cleanup();
  });

  const root = (): string => sample?.repo.root ?? '';

  it('is off until configured, and says so instead of guessing', async () => {
    expect((await run('ai', 'status')).stdout).toContain('The AI layer is off');
    const ask = await run('ask', 'Why the legacy invoices?');
    expect(ask.code).not.toBe(0);
    expect(ask.stderr).toContain('The AI layer is off');
    expect(prompts).toHaveLength(0);
    expect((await run('query', 'tell me a story')).stderr).toContain('codefossil ask');
  });

  it('refuses a cloud provider without explicit agreement, and never stores a key', async () => {
    const refused = await run('ai', 'configure', '--provider', 'anthropic');
    expect(refused.stderr).toContain('--allow-cloud');
    expect(existsSync(join(root(), '.codefossil', 'ai.json'))).toBe(false);

    const agreed = await run('ai', 'configure', '--provider', 'anthropic', '--allow-cloud');
    expect(agreed.stdout).toContain('evidence is sent to the provider');
    expect(agreed.stdout).toContain('none are stored');
    expect(JSON.parse(readFileSync(join(root(), '.codefossil', 'ai.json'), 'utf8'))).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5',
      allowCloud: true,
      includeSource: false,
    });
    expect((await run('ai', 'off')).stdout).toContain('AI layer off');
    expect((await run('ai', 'status', '--json')).stdout).toContain('"configured": false');
  });

  it('answers open questions from gathered evidence, dropping claims it cannot tie to it', async () => {
    await run('ai', 'configure', '--provider', 'ollama');
    const result = await run('ask', 'Why the legacy invoices workaround?');
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(result.stdout).toContain('AI answer (ollama llama3.1, local) · INFERRED 0.60');
    expect(result.stdout).toContain('Legacy invoices needed it.');
    expect(result.stdout).not.toContain('Made up.');
    expect(result.stdout).toContain('1 claim dropped');
    expect(prompts[0]).toContain('<untrusted_evidence>');

    const nothing = await run('ask', 'What about quantum teleportation?');
    expect(nothing.stderr).toContain('the model was not asked');
  });

  it('adds a summary to why without changing the deterministic answer', async () => {
    await run('ai', 'configure', '--provider', 'ollama');
    const plain = await run('why', 'calculateVAT', '--no-save');
    const summarized = await run('why', 'calculateVAT', '--no-save', '--summarize');
    expect(summarized.stdout.startsWith(plain.stdout)).toBe(true);
    expect(summarized.stdout).toContain('AI answer (ollama');
    const json = JSON.parse(
      (await run('why', 'calculateVAT', '--no-save', '--summarize', '--json')).stdout,
    ) as {
      kind: string;
      summary: { classification: string };
    };
    expect(json).toMatchObject({ kind: 'why', summary: { classification: 'INFERRED' } });
    // Source excerpts (symbol signatures) are withheld by default.
    const shown = prompts.flatMap((prompt) => {
      const block = /<untrusted_evidence>\n([\s\S]*)\n<\/untrusted_evidence>/.exec(prompt)?.[1];
      return JSON.parse(block ?? '[]') as { type: string; excerpt: string | null }[];
    });
    const ast = shown.filter((e) => e.type === 'ast_node');
    expect(ast.length).toBeGreaterThan(0);
    expect(ast.every((e) => e.excerpt === null)).toBe(true);
  });
});

describe('codefossil serve', () => {
  let sample: SampleHistory | undefined;

  beforeEach(async () => {
    sample = await createSampleHistory();
    await fossil(sample.repo.root, 'init');
    await fossil(sample.repo.root, 'index');
  });

  afterEach(async () => {
    await sample?.repo.cleanup();
  });

  it('serves the API on a loopback port until closed', async () => {
    let server: { url: string; close: () => Promise<void> } | undefined;
    let stdout = '';
    const code = await runCli(['serve', '--port', '0'], {
      cwd: sample?.repo.root ?? '',
      stdout: (text) => {
        stdout += text;
      },
      stderr: () => undefined,
      resolveGitHubToken: noToken,
      onServe: (started) => {
        server = started;
      },
    });
    try {
      expect(code).toBe(0);
      expect(stdout).toMatch(/listening on http:\/\/127\.0\.0\.1:\d+\. Press Ctrl\+C to stop\./);
      const health = await fetch(`${server?.url ?? ''}/health`);
      expect(await health.json()).toEqual({ data: { status: 'ok', version: '0.1.0' } });
      const repositories = await fetch(`${server?.url ?? ''}/api/repositories`);
      expect(((await repositories.json()) as { data: unknown[] }).data).toHaveLength(1);
    } finally {
      await server?.close();
    }
  });

  it('offers a cloud AI provider only when network access is allowed', async () => {
    await fossil(
      sample?.repo.root ?? '',
      'ai',
      'configure',
      '--provider',
      'anthropic',
      '--allow-cloud',
    );
    let server: { url: string; close: () => Promise<void> } | undefined;
    let stderr = '';
    await runCli(['serve', '--port', '0'], {
      cwd: sample?.repo.root ?? '',
      stdout: () => undefined,
      stderr: (text) => {
        stderr += text;
      },
      resolveGitHubToken: noToken,
      onServe: (started) => {
        server = started;
      },
    });
    try {
      expect(stderr).toContain('start with --allow-network to offer it');
      const status = await fetch(`${server?.url ?? ''}/api/ai`);
      expect(await status.json()).toEqual({ data: { enabled: false } });
    } finally {
      await server?.close();
    }
  });

  it('refuses to listen beyond this machine', async () => {
    const result = await fossil(sample?.repo.root ?? '', 'serve', '--host', '0.0.0.0');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--host must be a loopback address');
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
    expect(result).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
  });
});

describe('codefossil fossils and copied code', () => {
  let repo: FixtureRepo | undefined;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    const parse = 'export function parse(s: string) {\n  return s.trim();\n}\n';
    const helper = 'export function helper() {\n  return 1;\n}\n';
    await repo.write('src/old.ts', `${parse}\n${helper}`);
    await repo.commit('Add parser and helper');
    await repo.write('src/old.ts', helper);
    await repo.write('src/new.ts', parse);
    await repo.commit('Move the parser');
  });

  afterEach(async () => {
    await repo?.cleanup();
  });

  const root = (): string => repo?.root ?? '';

  it('lists the oldest code with its origin and where it was copied', async () => {
    const result = await fossil(root(), 'fossils');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('The oldest code still here, oldest introduction first');
    expect(result.stdout).toMatch(
      /function parse {2}src\/new\.ts:1\n {5}introduced \d{4}-\d{2}-\d{2} in [0-9a-f]{7} "Add parser and helper"/,
    );
    expect(result.stdout).toMatch(
      /copied here from src\/old\.ts on \d{4}-\d{2}-\d{2} in [0-9a-f]{7} "Move the parser"/,
    );
    expect(result.stdout).toContain('unchanged since it was copied here');
  });

  it('explains copied code through its original, at the copy’s confidence', async () => {
    // The removed copy in src/old.ts still matches the name; the one defined at HEAD wins.
    const result = await fossil(root(), 'why', 'parse', '--no-save');
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      'It was copied, with identical content, from function parse in src/old.ts',
    );
    expect(result.stdout).toContain('That code was introduced in commit');
    expect(result.stdout).toContain('Confidence 0.90');
  });
});

describe('codefossil impact with callers', () => {
  let repo: FixtureRepo | undefined;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.write('src/tax.ts', 'export function rate() {\n  return 0.21;\n}\n');
    await repo.write(
      'src/cart.ts',
      "import { rate } from './tax.js';\nexport function total(n: number) {\n  return n * rate();\n}\n",
    );
    await repo.write(
      'test/cart.test.ts',
      "import { total } from '../src/cart.js';\nexport function check() {\n  return total(1);\n}\n",
    );
    await repo.commit('Shop');
  });

  afterEach(async () => {
    await repo?.cleanup();
  });

  it('lists direct and indirect callers before the importing files', async () => {
    const result = await fossil(repo?.root ?? '', 'impact', 'rate', '--no-save');

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      '1 caller calls it directly and 1 through other calls (1 in tests). 1 file imports the file that defines it directly and 1 transitively (1 of them tests).',
    );
    expect(result.stdout).toMatch(
      /Callers \(1\)\n {2}function total \(src\/cart\.ts:2\) {2}\(DERIVED 0\.95\)/,
    );
    expect(result.stdout).toMatch(
      /Indirect callers \(1\)\n {2}function check \(test\/cart\.test\.ts:2\) \[test\] {2}via function total/,
    );
    expect(result.stdout.indexOf('Callers (1)')).toBeLessThan(result.stdout.indexOf('Direct (1)'));
  });
});

describe('codefossil why --html', () => {
  let repo: FixtureRepo | undefined;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.write('src/tax.ts', 'export function rate() {\n  return 0.21;\n}\n');
    await repo.commit('Add rate');
    await repo.write('src/tax.ts', 'export function rate() {\n  return 0.09;\n}\n');
    await repo.commit('fix: <img src=x onerror=alert(1)> wrong rate for @someone');
  });

  afterEach(async () => {
    await repo?.cleanup();
  });

  it('writes a self-contained page with every piece of repository text escaped', async () => {
    const root = repo?.root ?? '';
    const result = await fossil(root, 'why', 'rate', '--no-save', '--html', 'rate.html');
    expect(result.code).toBe(0);
    expect(result.stderr).toContain('rate.html');

    const html = readFileSync(join(root, 'rate.html'), 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<h1>rate</h1>');
    expect(html).toContain('fix: &#60;img src=x onerror=alert(1)&#62; wrong rate');
    expect(html).not.toContain('<img');
    expect(html).not.toMatch(
      /<script|<link|https?:\/\/(?!github\.com\/ludicolijn1985-blip\/codefossil)/,
    );
    expect(html).toContain('class="badge fix-badge"');
    expect(html).toMatch(/Most commits by Ada Lovelace \(\d+\)\./);
  });

  it('draws only symbols', async () => {
    const result = await fossil(repo?.root ?? '', 'why', 'src/tax.ts', '--html', 'tax.html');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('--html draws the history of a symbol');
  });
});

describe('codefossil lens', () => {
  let repo: FixtureRepo | undefined;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.write(
      'src/tax.ts',
      "import { round } from './round.js';\nexport function rate() {\n  return round(0.21);\n}\n",
    );
    await repo.write('src/round.ts', 'export function round(n: number) {\n  return n;\n}\n');
    await repo.commit('Add tax (#3)');
    await repo.write(
      'src/round.ts',
      'export function round(n: number) {\n  return Math.round(n);\n}\n',
    );
    await repo.commit('fix: round properly');
  });

  afterEach(async () => {
    await repo?.cleanup();
  });

  it('summarises every function of a file in one line', async () => {
    const root = repo?.root ?? '';
    const text = await fossil(root, 'lens', join(root, 'src/round.ts'));
    expect(text.stdout).toMatch(
      /^ +1 {2}round {2}born \d{4} · 1 change · 1 fix · 1 caller · mostly Ada Lovelace\n$/,
    );

    const json = JSON.parse((await fossil(root, 'lens', 'src/tax.ts', '--json')).stdout) as {
      path: string;
      symbols: {
        qualifiedName: string;
        born: { subject: string; issues: string[] } | null;
        owner: { author: string; share: number; active: boolean } | null;
      }[];
    };
    expect(json.path).toBe('src/tax.ts');
    expect(json.symbols.map((s) => s.qualifiedName)).toEqual(['rate']);
    expect(json.symbols[0]?.born?.subject).toBe('Add tax (#3)');
    expect(json.symbols[0]?.owner).toMatchObject({
      author: 'Ada Lovelace',
      share: 1,
      active: true,
    });
  });
});

describe('codefossil site', () => {
  let repo: FixtureRepo | undefined;

  beforeEach(async () => {
    repo = await createFixtureRepo();
    await repo.write('src/tax.ts', 'export function rate() {\n  return 0.21;\n}\n');
    await repo.commit('Add rate <script>alert(1)</script>');
    await repo.write('src/tax.ts', 'export function rate() {\n  return 0.09;\n}\n');
    await repo.commit('fix: wrong rate');
  });

  afterEach(async () => {
    await repo?.cleanup();
  });

  it('writes an overview whose every link leads to a written page', async () => {
    const root = repo?.root ?? '';
    const result = await fossil(root, 'site', 'out', '--name', 'acme/shop');
    expect(result.code).toBe(0);

    const index = readFileSync(join(root, 'out', 'index.html'), 'utf8');
    expect(index).toContain('<h1>acme/shop</h1>');
    expect(index).toContain('Fixed most often');
    expect(index).not.toContain('<script>');
    const links = [...index.matchAll(/href="(stories\/[^"]+)"/g)].map((m) => m[1] ?? '');
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(existsSync(join(root, 'out', link))).toBe(true);
    const page = readFileSync(join(root, 'out', links[0] ?? ''), 'utf8');
    expect(page).toContain('href="../index.html"');
  });
});
