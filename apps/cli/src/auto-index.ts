import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  describeIndexHeadState,
  indexHeadState,
  runIndex,
  typeCheckingRequested,
} from '@codefossil/core';
import { openGitRepository } from '@codefossil/git';
import { formatIndexResult } from './format.js';
import type { CliIO } from './io.js';
import { initWorkspace, openWorkspace, type Workspace } from './workspace.js';

/** Set to `0` to make query commands use the index exactly as it is. */
export const AUTO_INDEX_ENV = 'CODEFOSSIL_AUTO_INDEX';

const autoIndexEnabled = () => process.env[AUTO_INDEX_ENV] !== '0';

/**
 * Open the workspace for a question, bringing the index up to date first:
 * the first question in a repository creates and fills the index, later
 * ones add only commits made since, and drop commits HEAD's history no
 * longer contains (after a reset, rebase or checkout). Always offline —
 * GitHub is synced by `codefossil index` alone. Progress goes to stderr so
 * stdout stays clean.
 */
export async function openIndexedWorkspace(cwd: string, io: CliIO): Promise<Workspace> {
  if (!autoIndexEnabled()) return warnIfDiverged(await openWorkspace(cwd), io);
  const git = await openGitRepository(cwd);
  const firstRun = !existsSync(join(git.root, '.codefossil', 'fossil.db'));
  const ws = firstRun ? await initWorkspace(cwd) : await openWorkspace(cwd);
  try {
    const state = await indexHeadState(ws.fossil.db, ws.repositoryId, ws.root);
    const stale = git.headSha !== null && state.freshness !== 'current';
    if (firstRun || stale) {
      io.stderr(
        firstRun
          ? `First use in ${ws.root}: indexing its history into .codefossil/ (once; later runs add only new commits). ` +
              `It ignores itself in git; delete it any time, or set ${AUTO_INDEX_ENV}=0 to turn this off.\n`
          : state.freshness === 'behind'
            ? 'Indexing new commits…\n'
            : "HEAD left the indexed history; updating the index to HEAD's history…\n",
      );
      const started = performance.now();
      const result = await runIndex(
        ws.fossil.db,
        ws.root,
        typeCheckingRequested() ? { typescript: true } : {},
      );
      io.stderr(
        formatIndexResult(result, ((performance.now() - started) / 1000).toFixed(1)) + '\n',
      );
    }
    return ws;
  } catch (error) {
    ws.fossil.close();
    throw error;
  }
}

/** With automatic indexing off, say so when answers may cite commits outside HEAD's history. */
async function warnIfDiverged(ws: Workspace, io: CliIO): Promise<Workspace> {
  try {
    const warning = describeIndexHeadState(
      await indexHeadState(ws.fossil.db, ws.repositoryId, ws.root),
    );
    if (warning) io.stderr(`Warning: ${warning}\n`);
    return ws;
  } catch (error) {
    ws.fossil.close();
    throw error;
  }
}
