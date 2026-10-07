import { Option, type Command } from 'commander';
import { buildReport } from '@codefossil/analyzers';
import { describeIndexHeadState, indexHeadState } from '@codefossil/core';
import { changedPaths, commitsBetween, GitError, runGitOptional } from '@codefossil/git';
import { formatReportMarkdown } from './format-report.js';
import { CliError, writeJson, type CliIO } from './io.js';
import { parsePositiveInteger } from './options.js';
import { openIndexedWorkspace } from './auto-index.js';
import { withWorkspace, type Workspace } from './workspace.js';

interface ReportOptions {
  readonly base?: string;
  readonly limit: string;
  readonly json?: boolean;
}

interface BranchChanges {
  readonly paths: readonly string[];
  readonly commits: readonly string[];
}

/**
 * Paths and commits on this branch since it left `base` (like `git diff base...HEAD`).
 * The base is resolved to a commit first, so it can never be read as an option.
 */
async function changedSince(ws: Workspace, base: string): Promise<BranchChanges> {
  if (base.startsWith('-')) throw new CliError(`--base must be a revision, got "${base}".`);
  let commit: string | undefined;
  try {
    commit = (
      await runGitOptional(ws.root, [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${base}^{commit}`,
      ])
    )?.trim();
  } catch (error) {
    if (!(error instanceof GitError)) throw error;
  }
  if (!commit) {
    throw new CliError(
      `--base ${base} is not a commit in this repository (in CI, fetch it first, e.g. with fetch-depth: 0).`,
    );
  }
  const mergeBase = (await runGitOptional(ws.root, ['merge-base', commit, 'HEAD']))?.trim();
  if (!mergeBase) throw new CliError(`${base} shares no history with HEAD.`);
  const paths = await changedPaths(ws.root, mergeBase, 'HEAD');
  const commits = await commitsBetween(ws.root, mergeBase, 'HEAD');
  if (!paths || !commits) throw new CliError(`Could not list the changes since ${base}.`);
  return { paths: [...paths], commits };
}

export function registerReportCommand(program: Command, io: CliIO, repoPath: () => string): void {
  program
    .command('report')
    .description(
      'Write a Markdown report: index status, hotspots, dead-intent candidates and, with --base, ' +
        'the history and dependents of every file changed since that revision (for CI summaries).',
    )
    .option(
      '--base <revision>',
      'report on files changed since this revision (merge base with HEAD)',
    )
    .option('--limit <n>', 'hotspots to list', '10')
    .addOption(new Option('--json', 'print the report as JSON'))
    .action(async (options: ReportOptions) => {
      const limit = parsePositiveInteger(options.limit, '--limit');
      await withWorkspace(openIndexedWorkspace(repoPath(), io), async (ws) => {
        const changed =
          options.base === undefined ? undefined : await changedSince(ws, options.base);
        const head = await indexHeadState(ws.fossil.db, ws.repositoryId, ws.root);
        const report = buildReport(ws.fossil.db, ws.repositoryId, {
          hotspotLimit: limit,
          indexWarning: describeIndexHeadState(head, { includeBehind: true }),
          ...(options.base !== undefined && changed
            ? { base: options.base, changedPaths: changed.paths, changedCommits: changed.commits }
            : {}),
          ...(io.now ? { now: io.now() } : {}),
        });
        if (options.json) writeJson(io, report);
        else io.stdout(formatReportMarkdown(report));
      });
    });
}
