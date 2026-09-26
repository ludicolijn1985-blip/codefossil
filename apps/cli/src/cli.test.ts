import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSampleHistory, type SampleHistory } from '@codefossil/git/testing';
import type { CliIO } from './io.js';
import { runCli } from './run.js';

interface Captured {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function fossil(cwd: string, ...args: string[]): Promise<Captured> {
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
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
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
