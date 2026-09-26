import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NotAGitRepositoryError, openGitRepository, redactUrlCredentials } from './repository.js';
import { createFixtureRepo, type FixtureRepo } from './testing/index.js';

describe('openGitRepository', () => {
  let repo: FixtureRepo | undefined;
  let plainDir: string | undefined;

  afterEach(async () => {
    await repo?.cleanup();
    repo = undefined;
    if (plainDir) await rm(plainDir, { recursive: true, force: true });
    plainDir = undefined;
  });

  it('reads an empty repository without failing', async () => {
    repo = await createFixtureRepo();
    expect(await openGitRepository(repo.root)).toEqual({
      root: repo.root,
      currentBranch: 'main',
      headSha: null,
      remoteUrl: null,
    });
  });

  it('resolves the root from a subdirectory and reads HEAD', async () => {
    repo = await createFixtureRepo();
    await repo.write('src/index.ts', 'export {};\n');
    const sha = await repo.commit('Initial commit');
    const opened = await openGitRepository(join(repo.root, 'src'));
    expect(opened.root).toBe(repo.root);
    expect(opened.headSha).toBe(sha);
  });

  it('reports a detached HEAD as having no current branch', async () => {
    repo = await createFixtureRepo();
    const sha = await repo.commit('Initial commit');
    await repo.git('checkout', '-q', '--detach', sha);
    expect((await openGitRepository(repo.root)).currentBranch).toBeNull();
  });

  it('never exposes credentials embedded in the origin URL', async () => {
    repo = await createFixtureRepo();
    await repo.git('remote', 'add', 'origin', 'https://user:ghp_secret@github.com/acme/shop.git');
    expect((await openGitRepository(repo.root)).remoteUrl).toBe('https://github.com/acme/shop.git');
  });

  it('throws NotAGitRepositoryError outside a repository', async () => {
    plainDir = await mkdtemp(join(tmpdir(), 'codefossil-plain-'));
    await expect(openGitRepository(plainDir)).rejects.toBeInstanceOf(NotAGitRepositoryError);
  });

  it('throws NotAGitRepositoryError for a missing directory', async () => {
    await expect(
      openGitRepository(join(tmpdir(), 'codefossil-does-not-exist')),
    ).rejects.toBeInstanceOf(NotAGitRepositoryError);
  });
});

describe('redactUrlCredentials', () => {
  it.each([
    ['https://token@github.com/a/b.git', 'https://github.com/a/b.git'],
    ['https://u:p@example.com/x', 'https://example.com/x'],
    ['https://github.com/a/b.git', 'https://github.com/a/b.git'],
    ['git@github.com:a/b.git', 'git@github.com:a/b.git'],
    // Unparseable as a URL (space in host) but still credential-bearing.
    ['https://user:tok en@exa mple.com/x', 'https://exa mple.com/x'],
  ])('%s -> %s', (input, expected) => {
    expect(redactUrlCredentials(input)).toBe(expected);
  });
});
