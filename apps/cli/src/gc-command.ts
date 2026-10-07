import { statSync } from 'node:fs';
import { join } from 'node:path';
import { Option, type Command } from 'commander';
import { MAX_PARSE_CACHE_ROWS } from '@codefossil/core';
import { trimParseCache } from '@codefossil/db';
import { extractionVersion } from '@codefossil/parser';
import { writeJson, type CliIO } from './io.js';
import { DATABASE_FILE, openWorkspace, withWorkspace, WORKSPACE_DIR } from './workspace.js';

const MIB = 1024 * 1024;

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

export interface GcResult {
  readonly cacheEntriesRemoved: number;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
}

/**
 * Shrink the index: drop cached parse results of other extraction versions
 * and beyond the cache limit, then compact the database file. Nothing an
 * answer cites is removed.
 */
export function registerGcCommand(program: Command, io: CliIO, repoPath: () => string): void {
  program
    .command('gc')
    .description('Shrink the index: drop stale parse-cache entries and compact the database.')
    .addOption(
      new Option('--max-cache <entries>', 'parse results to keep')
        .default(MAX_PARSE_CACHE_ROWS)
        .argParser((value) => {
          const parsed = Number(value);
          if (!Number.isInteger(parsed) || parsed < 0) {
            throw new Error('--max-cache must be a whole number of entries');
          }
          return parsed;
        }),
    )
    .addOption(new Option('--json', 'print the result as JSON'))
    .action(async (options: { readonly maxCache: number; readonly json?: boolean }) => {
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        const path = join(ws.root, WORKSPACE_DIR, DATABASE_FILE);
        const before = sizeOf(path) + sizeOf(`${path}-wal`);
        const removed = trimParseCache(
          ws.fossil.db,
          ws.repositoryId,
          extractionVersion(),
          options.maxCache,
        );
        ws.fossil.sqlite.pragma('wal_checkpoint(TRUNCATE)');
        ws.fossil.sqlite.exec('VACUUM');
        const result: GcResult = {
          cacheEntriesRemoved: removed,
          bytesBefore: before,
          bytesAfter: sizeOf(path) + sizeOf(`${path}-wal`),
        };
        if (options.json) {
          writeJson(io, result);
          return;
        }
        io.stdout(
          `Removed ${String(removed)} parse-cache entr${removed === 1 ? 'y' : 'ies'}; ` +
            `index ${(result.bytesBefore / MIB).toFixed(1)} MiB → ${(result.bytesAfter / MIB).toFixed(1)} MiB.\n`,
        );
      });
    });
}
