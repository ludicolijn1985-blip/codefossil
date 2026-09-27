import { Option, type Command } from 'commander';
import {
  analyzeDeadIntent,
  analyzeHotspots,
  DEFAULT_DEAD_INTENT_LIMIT,
  DEFAULT_HOTSPOT_LIMIT,
  DEFAULT_STALE_DAYS,
  type HotspotOrder,
} from '@codefossil/analyzers';
import { formatDeadIntent, formatHotspots } from './format-analysis.js';
import { writeJson, type CliIO } from './io.js';
import { parsePositiveInteger, parseSince } from './options.js';
import { openWorkspace, withWorkspace } from './workspace.js';

interface HotspotCommandOptions {
  readonly since?: string;
  readonly limit: string;
  readonly tests?: boolean;
  readonly generated?: boolean;
  readonly order: HotspotOrder;
  readonly json?: boolean;
}

interface DeadIntentCommandOptions {
  readonly limit: string;
  readonly staleDays: string;
  readonly json?: boolean;
}

export function registerAnalysisCommands(
  program: Command,
  io: CliIO,
  repoPath: () => string,
): void {
  program
    .command('hotspots')
    .description('Show historical change hotspots with their risk components.')
    .option('--since <date>', 'only count changes since this ISO date (e.g. 2025-01-01)')
    .option('--limit <n>', 'files to show', String(DEFAULT_HOTSPOT_LIMIT))
    .option('--tests', 'include test files')
    .option('--generated', 'include lockfiles, build output and generated files')
    .addOption(
      new Option('--order <by>', 'rank by hotspot score or by risk')
        .choices(['hotspot', 'risk'])
        .default('hotspot'),
    )
    .addOption(new Option('--json', 'print the result as JSON'))
    .action(async (options: HotspotCommandOptions) => {
      const since = options.since === undefined ? undefined : parseSince(options.since);
      const limit = parsePositiveInteger(options.limit, '--limit');
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        const report = analyzeHotspots(ws.fossil.db, ws.repositoryId, {
          ...(since ? { since: since.toISOString() } : {}),
          limit,
          includeTests: options.tests === true,
          includeGenerated: options.generated === true,
          orderBy: options.order,
        });
        if (options.json) writeJson(io, report);
        else io.stdout(formatHotspots(report));
      });
    });

  program
    .command('dead-intent')
    .description(
      'Show compatibility and workaround code whose reason may be gone (candidates only).',
    )
    .option('--limit <n>', 'candidates to show', String(DEFAULT_DEAD_INTENT_LIMIT))
    .option(
      '--stale-days <n>',
      'days without change before silence counts as a signal',
      String(DEFAULT_STALE_DAYS),
    )
    .addOption(new Option('--json', 'print the result as JSON'))
    .action(async (options: DeadIntentCommandOptions) => {
      const limit = parsePositiveInteger(options.limit, '--limit');
      const staleDays = parsePositiveInteger(options.staleDays, '--stale-days');
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        const report = analyzeDeadIntent(ws.fossil.db, ws.repositoryId, {
          limit,
          staleDays,
          ...(io.now ? { now: io.now() } : {}),
        });
        if (options.json) writeJson(io, report);
        else io.stdout(formatDeadIntent(report));
      });
    });
}
