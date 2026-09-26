import { isAbsolute, relative, resolve } from 'node:path';
import { Command, Option } from 'commander';
import { z } from 'zod';
import { runIndex } from '@codefossil/core';
import { findFileByPath, getIndexStatus, listFileSymbols } from '@codefossil/db';
import { formatIndexResult, formatStatus, formatSymbols } from './format.js';
import { CliError, writeJson, type CliIO } from './io.js';
import { VERSION } from './version.js';
import { initWorkspace, openWorkspace, type Workspace } from './workspace.js';

const sinceSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

function parseSince(value: string): Date {
  const result = sinceSchema.safeParse(value);
  if (!result.success) {
    throw new CliError(`--since must be an ISO date such as 2025-01-01, got "${value}".`);
  }
  return new Date(result.data);
}

/** Convert an absolute path to the forward-slash, root-relative form git and the index use. */
function toRepositoryPath(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new CliError(`${absolutePath} is not a file inside ${root}.`);
  }
  return rel.replaceAll('\\', '/');
}

interface GlobalOptions {
  readonly repo?: string;
}

interface JsonOption {
  readonly json?: boolean;
}

/** Run `action` with an open workspace and always close the database afterwards. */
async function withWorkspace<W extends Workspace, T>(
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

/**
 * Build the `fossil` command. Every command runs headlessly: no prompts, and
 * `--json` gives machine-readable output on stdout.
 */
export function createProgram(io: CliIO): Command {
  const program = new Command('fossil')
    .description('Evidence-first software archaeology for Git repositories.')
    .version(VERSION)
    .option('-r, --repo <path>', 'repository to operate on (default: current directory)')
    .configureOutput({
      writeOut: (text) => {
        io.stdout(text);
      },
      writeErr: (text) => {
        io.stderr(text);
      },
    })
    .exitOverride()
    .showHelpAfterError();

  const repoPath = (): string => {
    const { repo } = program.opts<GlobalOptions>();
    return repo ? resolve(io.cwd, repo) : io.cwd;
  };

  program
    .command('init')
    .description('Create .codefossil/ in the repository and register it.')
    .addOption(new Option('--json', 'print the result as JSON'))
    .action(async (options: JsonOption) => {
      await withWorkspace(initWorkspace(repoPath()), (ws) => {
        if (options.json) {
          writeJson(io, { root: ws.root, database: ws.databasePath, created: ws.created });
          return;
        }
        io.stdout(
          ws.created
            ? `Initialized CODEFOSSIL in ${ws.databasePath}\nNext: run \`fossil index\`.\n`
            : `CODEFOSSIL is already initialized in ${ws.databasePath}\n`,
        );
      });
    });

  program
    .command('index')
    .description('Index Git history into the local evidence database.')
    .option(
      '--since <date>',
      'only index commits since this ISO date (e.g. 2025-01-01); earlier history is not recorded',
    )
    .addOption(new Option('--json', 'print the result as JSON'))
    .action(async (options: JsonOption & { since?: string }) => {
      const since = options.since === undefined ? undefined : parseSince(options.since);
      await withWorkspace(openWorkspace(repoPath()), async (ws) => {
        const started = performance.now();
        const result = await runIndex(ws.fossil.db, ws.root, since ? { since } : {});
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        if (options.json) {
          writeJson(io, result);
          return;
        }
        io.stdout(formatIndexResult(result, seconds));
      });
    });

  program
    .command('symbols')
    .description('Show the current symbols of a file and where each one came from.')
    .argument('<path>', 'file path, relative to the current directory')
    .addOption(new Option('--json', 'print the symbols as JSON'))
    .action(async (path: string, options: JsonOption) => {
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        const relativePath = toRepositoryPath(ws.root, resolve(io.cwd, path));
        const file = findFileByPath(ws.fossil.db, ws.repositoryId, relativePath);
        if (!file) {
          throw new CliError(
            `No indexed history for ${relativePath}. CODEFOSSIL only knows committed files; ` +
              'commit it and run `fossil index`.',
          );
        }
        const symbols = listFileSymbols(ws.fossil.db, file.id);
        if (options.json) {
          writeJson(io, {
            path: file.path,
            language: file.language,
            deleted: file.deletedAt !== null,
            symbols,
          });
          return;
        }
        io.stdout(formatSymbols(file.path, file.deletedAt, symbols));
      });
    });

  program
    .command('status')
    .description('Show index health and counts.')
    .addOption(new Option('--json', 'print the status as JSON'))
    .action(async (options: JsonOption) => {
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        const status = getIndexStatus(ws.fossil.db, ws.repositoryId);
        if (!status) throw new CliError('Repository is not registered. Run `fossil init`.');
        if (options.json) {
          writeJson(io, status);
          return;
        }
        io.stdout(formatStatus(status));
      });
    });

  return program;
}
