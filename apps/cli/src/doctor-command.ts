import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Option, type Command } from 'commander';
import { loadAiConfig } from '@codefossil/ai';
import {
  findRepositoryByPath,
  getGraphIndexedSha,
  getIndexStatus,
  IN_MEMORY,
  openDatabase,
} from '@codefossil/db';
import { openGitRepository, runGit } from '@codefossil/git';
import { SymbolExtractor, type GrammarId } from '@codefossil/parser';
import { CliError, writeJson, type CliIO } from './io.js';
import { DATABASE_FILE, WORKSPACE_DIR } from './workspace.js';

export interface Check {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

const MIN_NODE: readonly [number, number] = [22, 12];
const SAMPLES: readonly (readonly [GrammarId, string])[] = [
  ['typescript', 'export function f(a: number): number { return a; }'],
  ['tsx', 'export const A = () => <div />;'],
  ['javascript', 'export function f() {}'],
  ['python', 'def f():\n    pass\n'],
  ['go', 'package p\nfunc F() {}\n'],
  ['rust', 'pub fn f() {}'],
];

function nodeCheck(): Check {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    name: 'Node.js',
    ok,
    detail: `${process.versions.node}${ok ? '' : ` — ${MIN_NODE.join('.')} or newer is required`}`,
  };
}

async function gitCheck(cwd: string): Promise<Check> {
  try {
    const version = (await runGit(cwd, ['--version'])).trim();
    return { name: 'Git', ok: true, detail: version };
  } catch {
    return { name: 'Git', ok: false, detail: 'git is not on the PATH' };
  }
}

function databaseCheck(): Check {
  try {
    openDatabase(IN_MEMORY).close();
    return { name: 'SQLite', ok: true, detail: 'native driver loads; migrations apply' };
  } catch (error) {
    return {
      name: 'SQLite',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

async function parserCheck(): Promise<Check> {
  const extractor = new SymbolExtractor();
  const failed: string[] = [];
  try {
    for (const [grammar, source] of SAMPLES) {
      try {
        const result = await extractor.extract(source, grammar);
        if (!result || result.symbols.length === 0) failed.push(grammar);
      } catch {
        failed.push(grammar);
      }
    }
  } finally {
    await extractor.dispose();
  }
  return {
    name: 'Parsers',
    ok: failed.length === 0,
    detail:
      failed.length === 0 ? SAMPLES.map(([g]) => g).join(', ') : `failed: ${failed.join(', ')}`,
  };
}

/** Where the current directory stands: repository, index freshness, AI layer. */
async function repositoryChecks(cwd: string): Promise<Check[]> {
  let git;
  try {
    git = await openGitRepository(cwd);
  } catch {
    return [
      {
        name: 'Repository',
        ok: true,
        detail: 'not inside a Git repository (nothing to check here)',
      },
    ];
  }
  const directory = join(git.root, WORKSPACE_DIR);
  const databasePath = join(directory, DATABASE_FILE);
  if (!existsSync(databasePath)) {
    return [
      { name: 'Repository', ok: true, detail: git.root },
      { name: 'Index', ok: true, detail: 'none yet; the first question creates it' },
    ];
  }
  const checks: Check[] = [{ name: 'Repository', ok: true, detail: git.root }];
  const fossil = openDatabase(databasePath);
  try {
    const repository = findRepositoryByPath(fossil.db, git.root);
    const status = repository ? getIndexStatus(fossil.db, repository.id) : undefined;
    if (!repository || !status) {
      checks.push({
        name: 'Index',
        ok: false,
        detail: 'the database describes no repository; run `codefossil init`',
      });
    } else {
      const fresh = getGraphIndexedSha(fossil.db, repository.id) === git.headSha;
      checks.push({
        name: 'Index',
        ok: true,
        detail:
          `${String(status.counts.commits)} commits, ${String(status.counts.currentFiles)} files, ` +
          `indexed ${status.repository.indexedAt ?? 'never'}${fresh ? '' : ' — behind HEAD; the next question catches up'}`,
      });
    }
  } finally {
    fossil.close();
  }
  try {
    const ai = loadAiConfig(directory);
    checks.push({
      name: 'AI layer',
      ok: true,
      detail: ai ? `${ai.provider} ${ai.model}${ai.allowCloud ? ' (cloud allowed)' : ''}` : 'off',
    });
  } catch (error) {
    checks.push({
      name: 'AI layer',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return checks;
}

export async function runChecks(cwd: string): Promise<Check[]> {
  return [
    nodeCheck(),
    await gitCheck(cwd),
    databaseCheck(),
    await parserCheck(),
    ...(await repositoryChecks(cwd)),
  ];
}

export function registerDoctorCommand(program: Command, io: CliIO, repoPath: () => string): void {
  program
    .command('doctor')
    .description(
      'Check Node.js, Git, the database driver, the parsers and this repository’s index.',
    )
    .addOption(new Option('--json', 'print the checks as JSON'))
    .action(async (options: { json?: boolean }) => {
      const checks = await runChecks(repoPath());
      if (options.json) writeJson(io, checks);
      else {
        const width = Math.max(...checks.map((c) => c.name.length));
        io.stdout(
          checks.map((c) => `${c.ok ? '✓' : '✗'} ${c.name.padEnd(width)}  ${c.detail}`).join('\n') +
            '\n',
        );
      }
      const failed = checks.filter((c) => !c.ok).length;
      if (failed > 0)
        throw new CliError(`${String(failed)} check${failed === 1 ? '' : 's'} failed.`);
    });
}
