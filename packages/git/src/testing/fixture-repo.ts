import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** First commit timestamp; each later commit is one hour after the previous one. */
const EPOCH = Date.parse('2026-01-01T09:00:00Z');
const HOUR_MS = 60 * 60 * 1000;

/**
 * A throwaway Git repository with deterministic authors and dates, isolated
 * from the user's global Git configuration.
 */
export interface FixtureRepo {
  /** Working tree root (real path, forward slashes as git reports it). */
  readonly root: string;
  git(...args: string[]): Promise<string>;
  write(path: string, content: string | Uint8Array): Promise<void>;
  remove(path: string): Promise<void>;
  /** `git mv`, creating the destination directory first. */
  move(from: string, to: string): Promise<void>;
  /** Stage everything and commit. Returns the new commit SHA. */
  commit(message: string): Promise<string>;
  /** Merge `branch` into the current branch with a merge commit. Returns its SHA. */
  merge(branch: string, message: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function createFixtureRepo(): Promise<FixtureRepo> {
  const root = (await realpath(await mkdtemp(join(tmpdir(), 'codefossil-fixture-')))).replaceAll(
    '\\',
    '/',
  );
  let commitCount = 0;

  const git = async (...args: string[]): Promise<string> => {
    const date = new Date(EPOCH + commitCount * HOUR_MS).toISOString();
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: join(root, '.git-test-config-absent'),
        GIT_AUTHOR_NAME: 'Ada Lovelace',
        GIT_AUTHOR_EMAIL: 'ada@example.com',
        GIT_COMMITTER_NAME: 'Ada Lovelace',
        GIT_COMMITTER_EMAIL: 'ada@example.com',
        GIT_AUTHOR_DATE: date,
        GIT_COMMITTER_DATE: date,
      },
    });
    return stdout;
  };

  await git('init', '-q', '-b', 'main');
  await git('config', 'core.autocrlf', 'false');
  await git('config', 'commit.gpgsign', 'false');

  return {
    root,
    git,
    async write(path, content) {
      const target = join(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    },
    async remove(path) {
      await rm(join(root, path));
    },
    async move(from, to) {
      await mkdir(dirname(join(root, to)), { recursive: true });
      await git('mv', from, to);
    },
    async commit(message) {
      await git('add', '-A');
      await git('commit', '-q', '--allow-empty', '-m', message);
      commitCount++;
      return (await git('rev-parse', 'HEAD')).trim();
    },
    async merge(branch, message) {
      await git('merge', '-q', '--no-ff', '-m', message, branch);
      commitCount++;
      return (await git('rev-parse', 'HEAD')).trim();
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    },
  };
}

export interface SampleHistory {
  readonly repo: FixtureRepo;
  /** Commit SHAs keyed by a short name, in the order they were created. */
  readonly shas: {
    readonly addVat: string;
    readonly reducedRate: string;
    readonly moveToTax: string;
    readonly addLogo: string;
    readonly removeReadme: string;
    readonly merge: string;
  };
}

/**
 * A small but representative history: additions, a modification with a body
 * that references an issue, a rename, a binary file on a side branch, a
 * deletion and a merge commit.
 */
export async function createSampleHistory(): Promise<SampleHistory> {
  const repo = await createFixtureRepo();

  await repo.write('README.md', '# Shop\n');
  await repo.write('src/payment/vat.ts', 'export const calculateVAT = (n: number) => n * 0.21;\n');
  const addVat = await repo.commit('Add VAT calculation');

  await repo.write(
    'src/payment/vat.ts',
    [
      'export const calculateVAT = (n: number, reduced = false) =>',
      '  n * (reduced ? 0.09 : 0.21);',
      '',
    ].join('\n'),
  );
  const reducedRate = await repo.commit(
    'Handle reduced VAT rate\n\nWorkaround for legacy invoices.\nFixes #12',
  );

  await repo.move('src/payment/vat.ts', 'src/tax/vat.ts');
  const moveToTax = await repo.commit('Move VAT into tax module');

  await repo.git('checkout', '-q', '-b', 'feature/logo');
  await repo.write('assets/logo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const addLogo = await repo.commit('Add logo');

  await repo.git('checkout', '-q', 'main');
  await repo.remove('README.md');
  const removeReadme = await repo.commit('Remove README');

  const merge = await repo.merge('feature/logo', 'Merge branch feature/logo');

  return { repo, shas: { addVat, reducedRate, moveToTax, addLogo, removeReadme, merge } };
}
