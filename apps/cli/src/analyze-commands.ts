import { Option, type Command } from 'commander';
import {
  analyzeDeadIntent,
  analyzeFixedSymbols,
  analyzeFossils,
  analyzeHotspots,
  DEFAULT_DEAD_INTENT_LIMIT,
  DEFAULT_FOSSIL_LIMIT,
  DEFAULT_HOTSPOT_LIMIT,
  DEFAULT_STALE_DAYS,
  type FossilOrder,
  type HotspotOrder,
} from '@codefossil/analyzers';
import {
  formatDeadIntent,
  formatFixedSymbols,
  formatFossils,
  formatHotspots,
} from './format-analysis.js';
import { CliError, writeJson, type CliIO } from './io.js';
import { parsePositiveInteger, parseSince } from './options.js';
import { openIndexedWorkspace } from './auto-index.js';
import { withWorkspace } from './workspace.js';

interface HotspotCommandOptions {
  readonly since?: string;
  readonly limit: string;
  readonly tests?: boolean;
  readonly generated?: boolean;
  readonly allFiles?: boolean;
  readonly symbols?: boolean;
  readonly order: HotspotOrder;
  readonly json?: boolean;
}

interface FossilCommandOptions {
  readonly limit: string;
  readonly order: FossilOrder;
  readonly tests?: boolean;
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
    .option('--all-files', 'also rank documentation, configuration and other non-code files')
    .option('--symbols', 'rank functions, methods and classes by the fix commits that changed them')
    .addOption(
      new Option('--order <by>', 'rank by hotspot score or by risk')
        .choices(['hotspot', 'risk'])
        .default('hotspot'),
    )
    .addOption(new Option('--json', 'print the result as JSON'))
    .action(async (options: HotspotCommandOptions) => {
      const since = options.since === undefined ? undefined : parseSince(options.since);
      const limit = parsePositiveInteger(options.limit, '--limit');
      if (
        options.symbols &&
        (since || options.generated || options.allFiles || options.order !== 'hotspot')
      ) {
        throw new CliError('--symbols takes --limit, --tests and --json only.');
      }
      await withWorkspace(openIndexedWorkspace(repoPath(), io), (ws) => {
        if (options.symbols) {
          const fixed = analyzeFixedSymbols(ws.fossil.db, ws.repositoryId, {
            limit,
            includeTests: options.tests === true,
          });
          if (options.json) writeJson(io, fixed);
          else io.stdout(formatFixedSymbols(fixed));
          return;
        }
        const report = analyzeHotspots(ws.fossil.db, ws.repositoryId, {
          ...(since ? { since: since.toISOString() } : {}),
          limit,
          includeTests: options.tests === true,
          includeGenerated: options.generated === true,
          includeNonCode: options.allFiles === true,
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
      await withWorkspace(openIndexedWorkspace(repoPath(), io), (ws) => {
        const report = analyzeDeadIntent(ws.fossil.db, ws.repositoryId, {
          limit,
          staleDays,
          ...(io.now ? { now: io.now() } : {}),
        });
        if (options.json) writeJson(io, report);
        else io.stdout(formatDeadIntent(report));
      });
    });

  program
    .command('fossils')
    .description(
      'Show the oldest code still present and its story: when each symbol was introduced, by whom, ' +
        'and what changed since. Only origins the indexed history establishes are dated.',
    )
    .option('--limit <n>', 'symbols to show', String(DEFAULT_FOSSIL_LIMIT))
    .addOption(
      new Option('--order <by>', 'oldest introduction first, or longest without a change first')
        .choices(['introduced', 'untouched'])
        .default('introduced'),
    )
    .option('--tests', 'include tests, examples, docs, fixtures and benchmarks')
    .addOption(new Option('--json', 'print the result as JSON'))
    .action(async (options: FossilCommandOptions) => {
      const limit = parsePositiveInteger(options.limit, '--limit');
      await withWorkspace(openIndexedWorkspace(repoPath(), io), (ws) => {
        const report = analyzeFossils(ws.fossil.db, ws.repositoryId, {
          limit,
          order: options.order,
          includeTests: options.tests === true,
        });
        if (options.json) writeJson(io, report);
        else io.stdout(formatFossils(report));
      });
    });
}
