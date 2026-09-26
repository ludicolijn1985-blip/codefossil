import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative } from 'node:path';
import {
  findRepositoryByPath,
  openDatabase,
  registerRepository,
  type FossilDatabase,
} from '@codefossil/db';
import {
  isPathTracked,
  NotAGitRepositoryError,
  openGitRepository,
  type GitRepository,
} from '@codefossil/git';
import { CliError } from './io.js';

export const WORKSPACE_DIR = '.codefossil';
export const DATABASE_FILE = 'fossil.db';

/** Every file CODEFOSSIL (or SQLite on its behalf) creates inside the workspace. */
const WORKSPACE_FILES = [
  '.gitignore',
  DATABASE_FILE,
  `${DATABASE_FILE}-wal`,
  `${DATABASE_FILE}-shm`,
  `${DATABASE_FILE}-journal`,
];

export interface Workspace {
  readonly root: string;
  readonly databasePath: string;
  readonly repositoryId: number;
  readonly fossil: FossilDatabase;
}

async function openGit(cwd: string): Promise<GitRepository> {
  try {
    return await openGitRepository(cwd);
  } catch (error) {
    if (error instanceof NotAGitRepositoryError) {
      throw new CliError(`${cwd} is not inside a Git repository.`);
    }
    throw error;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

/**
 * Refuse to use a workspace the repository itself controls. A malicious
 * repository could commit `.codefossil` (or files inside it) as symlinks so
 * that writing our database or `.gitignore` overwrites files elsewhere on
 * disk, or commit a crafted database for us to open.
 */
async function assertSafeWorkspace(root: string): Promise<void> {
  const directory = join(root, WORKSPACE_DIR);
  if (await isPathTracked(root, WORKSPACE_DIR)) {
    throw new CliError(
      `${directory} is committed to this repository. CODEFOSSIL will not use a workspace ` +
        'whose contents come from the repository.',
    );
  }
  for (const path of [directory, ...WORKSPACE_FILES.map((file) => join(directory, file))]) {
    if (await isSymlink(path)) {
      throw new CliError(`${path} is a symbolic link. Refusing to write through it.`);
    }
  }
  if (existsSync(directory)) {
    const expected = join(await realpath(root), WORKSPACE_DIR);
    if ((await realpath(directory)) !== expected) {
      throw new CliError(`${directory} resolves outside the repository. Refusing to use it.`);
    }
  }
}

/**
 * Create `.codefossil/` in the repository root and register the repository.
 * The directory ignores itself, so the user's `.gitignore` is never touched.
 * Safe to run more than once.
 */
export async function initWorkspace(cwd: string): Promise<Workspace & { created: boolean }> {
  const git = await openGit(cwd);
  const directory = join(git.root, WORKSPACE_DIR);
  const databasePath = join(directory, DATABASE_FILE);

  await assertSafeWorkspace(git.root);
  const created = !existsSync(databasePath);
  await mkdir(directory, { recursive: true });
  await assertSafeWorkspace(git.root);
  await writeFile(join(directory, '.gitignore'), '# Created by CODEFOSSIL\n*\n');

  const fossil = openDatabase(databasePath);
  try {
    const repository = registerRepository(fossil.db, {
      path: git.root,
      name: basename(git.root),
      remoteUrl: git.remoteUrl,
      defaultBranch: git.currentBranch,
    });
    return { root: git.root, databasePath, repositoryId: repository.id, fossil, created };
  } catch (error) {
    fossil.close();
    throw error;
  }
}

/** Convert an absolute path to the forward-slash, root-relative form git and the index use. */
export function toRepositoryPath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new CliError(`${absolutePath} is not a file inside ${root}.`);
  }
  return rel.replaceAll('\\', '/');
}

/** Run `action` with an open workspace and always close the database afterwards. */
export async function withWorkspace<W extends Workspace, T>(
  workspace: Promise<W>,
  action: (ws: W) => Promise<T> | T,
): Promise<T> {
  const ws = await workspace;
  try {
    return await action(ws);
  } finally {
    ws.fossil.close();
  }
}

/** Open the workspace of an initialized repository. */
export async function openWorkspace(cwd: string): Promise<Workspace> {
  const { root } = await openGit(cwd);
  const databasePath = join(root, WORKSPACE_DIR, DATABASE_FILE);
  await assertSafeWorkspace(root);
  if (!existsSync(databasePath)) {
    throw new CliError(`CODEFOSSIL is not initialized in ${root}. Run \`fossil init\` first.`);
  }
  const fossil = openDatabase(databasePath);
  const repository = findRepositoryByPath(fossil.db, root);
  if (!repository) {
    fossil.close();
    throw new CliError(
      `The database in ${databasePath} does not describe ${root}. Run \`fossil init\` again.`,
    );
  }
  return { root, databasePath, repositoryId: repository.id, fossil };
}
