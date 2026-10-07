import { resolve } from 'node:path';
import { Command, Option } from 'commander';
import {
  describeIndexHeadState,
  indexHeadState,
  runIndex,
  typeCheckingRequested,
  TYPESCRIPT_ENV,
} from '@codefossil/core';
import {
  fileImports,
  findFileByPath,
  forgetGraphSnapshot,
  getIndexStatus,
  importedBy,
  listDependencies,
  listFileSymbols,
  providerCounts,
  getProviderConnection,
} from '@codefossil/db';
import { formatDependencies, formatFileDependencies } from './format-graph.js';
import { formatIndexResult, formatStatus, formatSymbols } from './format.js';
import { formatGitHubIndex, formatGitHubStatus, type GitHubStatus } from './format-github.js';
import { connectGitHub, planGitHubSync } from './github.js';
import { registerGraphCommands } from './graph-commands.js';
import { registerInvestigationCommands } from './investigate-commands.js';
import { registerAiCommands } from './ai-commands.js';
import { registerAnalysisCommands } from './analyze-commands.js';
import { parsePositiveInteger, parseSince } from './options.js';
import { registerDoctorCommand } from './doctor-command.js';
import { registerReportCommand } from './report-command.js';
import { openIndexedWorkspace } from './auto-index.js';
import { registerGcCommand } from './gc-command.js';
import { registerLensCommand } from './lens-command.js';
import { registerMcpCommand } from './mcp-command.js';
import { registerSiteCommand } from './site-command.js';
import { registerServeCommand } from './serve-command.js';
import { CliError, writeJson, type CliIO } from './io.js';
import { VERSION } from './version.js';
import {
  initWorkspace,
  openWorkspace,
  toRepositoryPath,
  withWorkspace,
  type Workspace,
} from './workspace.js';

const DEFAULT_GITHUB_MAX_REQUESTS = 1000;

function gitHubStatus(ws: Workspace): GitHubStatus | null {
  const connection = getProviderConnection(ws.fossil.db, ws.repositoryId, 'github');
  if (!connection) return null;
  const { owner, name, apiUrl, lastSyncedAt } = connection;
  return { owner, name, apiUrl, lastSyncedAt, ...providerCounts(ws.fossil.db, ws.repositoryId) };
}

interface IndexCommandOptions {
  readonly since?: string;
  readonly offline?: boolean;
  readonly githubMaxRequests: string;
  readonly typescript?: boolean;
  readonly json?: boolean;
}

interface ConnectCommandOptions {
  readonly apiUrl?: string;
  readonly verify: boolean;
  readonly json?: boolean;
}

interface GlobalOptions {
  readonly repo?: string;
}

interface JsonOption {
  readonly json?: boolean;
}

/**
 * Build the `codefossil` command. Every command runs headlessly: no prompts, and
 * `--json` gives machine-readable output on stdout.
 */
export function createProgram(io: CliIO): Command {
  const program = new Command('codefossil')
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

  /** The indexed file for a path given on the command line. */
  const indexedFile = (ws: Workspace, path: string) => {
    const relativePath = toRepositoryPath(ws.root, resolve(io.cwd, path));
    const file = findFileByPath(ws.fossil.db, ws.repositoryId, relativePath);
    if (!file) {
      throw new CliError(
        `No indexed history for ${relativePath}. CODEFOSSIL only knows committed files; ` +
          'commit it and run `codefossil index`.',
      );
    }
    return file;
  };

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
            ? `Initialized CODEFOSSIL in ${ws.databasePath}\nNext: run \`codefossil index\`.\n`
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
    .option('--offline', 'do not contact GitHub; stored GitHub data is still linked')
    .option(
      '--github-max-requests <n>',
      'GitHub requests allowed in this run; a larger sync continues next run',
      String(DEFAULT_GITHUB_MAX_REQUESTS),
    )
    .option(
      '--typescript',
      `resolve TypeScript calls with the type checker (slower; may load the repository's own compiler; ${TYPESCRIPT_ENV}=1 makes it the default)`,
    )
    .addOption(new Option('--json', 'print the result as JSON'))
    .action(async (options: IndexCommandOptions) => {
      const since = options.since === undefined ? undefined : parseSince(options.since);
      const maxRequests = parsePositiveInteger(options.githubMaxRequests, '--github-max-requests');
      // Indexing a repository for the first time creates its workspace, as `init` would.
      await withWorkspace(initWorkspace(repoPath()), async (ws) => {
        const plan = await planGitHubSync(ws, io, {
          offline: options.offline === true,
          maxRequests,
        });
        for (const note of plan.notes) io.stderr(`Note: ${note}\n`);
        const typescript = options.typescript === true || typeCheckingRequested();
        // Asked for explicitly: rebuild the call graph now, even if HEAD did not move.
        if (options.typescript) forgetGraphSnapshot(ws.fossil.db, ws.repositoryId);
        const started = performance.now();
        const result = await runIndex(ws.fossil.db, ws.root, {
          ...(since ? { since } : {}),
          ...(plan.factory ? { github: plan.factory } : {}),
          ...(typescript ? { typescript: true } : {}),
        });
        const seconds = ((performance.now() - started) / 1000).toFixed(1);
        if (options.json) {
          writeJson(io, result);
          return;
        }
        io.stdout(formatIndexResult(result, seconds) + formatGitHubIndex(result.github));
      });
    });

  program
    .command('connect')
    .description('Connect the repository to an issue and pull request provider.')
    .command('github')
    .description(
      'Link to a GitHub repository (owner/name, or the origin remote). ' +
        'The token comes from GITHUB_TOKEN, GH_TOKEN or `gh auth login` and is never stored.',
    )
    .argument('[slug]', 'owner/name; defaults to the origin remote')
    .option('--api-url <url>', 'REST API URL (GitHub Enterprise Server: https://host/api/v3)')
    .option('--no-verify', 'save the connection without checking access')
    .addOption(new Option('--json', 'print the connection as JSON'))
    .action(async (slug: string | undefined, options: ConnectCommandOptions) => {
      await withWorkspace(openWorkspace(repoPath()), async (ws) => {
        const connection = await connectGitHub(ws, io, slug, {
          ...(options.apiUrl ? { apiUrl: options.apiUrl } : {}),
          verify: options.verify,
        });
        const { owner, name, apiUrl } = connection;
        if (options.json) {
          writeJson(io, { provider: 'github', owner, name, apiUrl, verified: options.verify });
          return;
        }
        io.stdout(
          `Connected to GitHub repository ${owner}/${name}${options.verify ? '' : ' (not verified)'}.\n` +
            'Next: run `codefossil index` to sync issues and pull requests.\n',
        );
      });
    });

  program
    .command('symbols')
    .description('Show the current symbols of a file and where each one came from.')
    .argument('<path>', 'file path, relative to the current directory')
    .addOption(new Option('--json', 'print the symbols as JSON'))
    .action(async (path: string, options: JsonOption) => {
      await withWorkspace(openIndexedWorkspace(repoPath(), io), (ws) => {
        const file = indexedFile(ws, path);
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
    .command('deps')
    .description(
      "Without a path: the repository's declared dependencies and how many files use each. " +
        'With a path: what the file imports and which files import it.',
    )
    .argument('[path]', 'file path, relative to the current directory')
    .addOption(new Option('--json', 'print the result as JSON'))
    .action(async (path: string | undefined, options: JsonOption) => {
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        if (path === undefined) {
          const dependencies = listDependencies(ws.fossil.db, ws.repositoryId);
          if (options.json) writeJson(io, { dependencies });
          else io.stdout(formatDependencies(dependencies));
          return;
        }
        const file = indexedFile(ws, path);
        const result = {
          path: file.path,
          imports: fileImports(ws.fossil.db, file.id),
          importedBy: importedBy(ws.fossil.db, ws.repositoryId, file.id),
        };
        if (options.json) writeJson(io, result);
        else io.stdout(formatFileDependencies(result.path, result.imports, result.importedBy));
      });
    });

  program
    .command('status')
    .description('Show index health and counts.')
    .addOption(new Option('--json', 'print the status as JSON'))
    .action(async (options: JsonOption) => {
      await withWorkspace(openWorkspace(repoPath()), async (ws) => {
        const status = getIndexStatus(ws.fossil.db, ws.repositoryId);
        if (!status) throw new CliError('Repository is not registered. Run `codefossil init`.');
        const head = await indexHeadState(ws.fossil.db, ws.repositoryId, ws.root);
        if (options.json) {
          writeJson(io, { ...status, head, github: gitHubStatus(ws) });
          return;
        }
        const warning = describeIndexHeadState(head, { includeBehind: true });
        io.stdout(
          formatStatus(status) +
            (warning ? `Warning: ${warning}\n` : '') +
            formatGitHubStatus(gitHubStatus(ws)),
        );
      });
    });

  registerGraphCommands(program, io, repoPath);
  registerInvestigationCommands(program, io, repoPath);
  registerAnalysisCommands(program, io, repoPath);
  registerAiCommands(program, io, repoPath);
  registerReportCommand(program, io, repoPath);
  registerDoctorCommand(program, io, repoPath);
  registerServeCommand(program, io, repoPath);
  registerMcpCommand(program, io, repoPath);
  registerLensCommand(program, io, repoPath);
  registerSiteCommand(program, io, repoPath);
  registerGcCommand(program, io, repoPath);

  return program;
}
