import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Option, type Command } from 'commander';
import { entityKey, loadEvidenceRecords, type FossilDb } from '@codefossil/db';
import {
  describeEntities,
  exportGraph,
  HISTORY_ROUTE,
  IMPACT_ROUTE,
  ORIGIN_ROUTE,
  resolveTarget,
  traverse,
  type StepTable,
  type TargetMatch,
} from '@codefossil/query';
import { formatTrace } from './format-trace.js';
import { CliError, writeJson, type CliIO } from './io.js';
import { openWorkspace, toRepositoryPath, withWorkspace, type Workspace } from './workspace.js';

const ROUTES: Readonly<Record<string, { steps: StepTable; title: string }>> = {
  origin: { steps: ORIGIN_ROUTE, title: 'Origin of' },
  history: { steps: HISTORY_ROUTE, title: 'History of' },
  impact: { steps: IMPACT_ROUTE, title: 'What depends on' },
};

const MAX_LISTED_CANDIDATES = 10;

function parseDepth(value: string): number {
  const depth = Number(value);
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 10) {
    throw new CliError(`--depth must be a whole number from 1 to 10, got "${value}".`);
  }
  return depth;
}

/**
 * Resolve a target to exactly one entity. Paths may be given relative to the
 * current directory. No match or several matches is an error that says so —
 * CODEFOSSIL never picks one of several candidates for the user.
 */
export function resolveOne(ws: Workspace, io: CliIO, input: string): TargetMatch {
  let matches = resolveTarget(ws.fossil.db, ws.repositoryId, input);
  const onDisk = resolve(io.cwd, input);
  if (matches.length === 0 && existsSync(onDisk)) {
    matches = resolveTarget(ws.fossil.db, ws.repositoryId, toRepositoryPath(ws.root, onDisk));
  }
  const [only] = matches;
  if (!only) {
    throw new CliError(
      `Nothing in the index matches "${input}". Try a file path, a symbol name, ` +
        '`path:Symbol`, a commit sha, `#123` or `npm:package`.',
    );
  }
  if (matches.length > 1) {
    const listed = matches
      .slice(0, MAX_LISTED_CANDIDATES)
      .map((m) => `  ${m.label}  (${m.how})`)
      .join('\n');
    const more = matches.length > MAX_LISTED_CANDIDATES ? '\n  …' : '';
    throw new CliError(
      `"${input}" matches ${matches.length} entities; be more specific (e.g. path:Symbol):\n${listed}${more}`,
    );
  }
  return only;
}

function traceTarget(
  db: FossilDb,
  ws: Workspace,
  match: TargetMatch,
  route: string,
  depth: number,
) {
  const chosen = ROUTES[route];
  if (!chosen) {
    throw new CliError(`--route must be one of ${Object.keys(ROUTES).join(', ')}.`);
  }
  const result = traverse(db, ws.repositoryId, match.ref, chosen.steps, { maxDepth: depth });
  const refs = [match.ref, ...result.paths.flatMap((p) => p.nodes)];
  const descriptions = describeEntities(db, refs);
  const evidence = loadEvidenceRecords(
    db,
    result.paths.flatMap((p) => p.edges.flatMap((e) => e.provenance.evidenceIds)),
  );
  return { chosen, result, descriptions, evidence };
}

export function registerGraphCommands(program: Command, io: CliIO, repoPath: () => string): void {
  program
    .command('trace')
    .description(
      'Show the evidence chains around a symbol, file, commit, issue or dependency, with the ' +
        'provenance of every link.',
    )
    .argument('<target>', 'symbol, path, path:Symbol, commit sha, #123 or npm:package')
    .addOption(new Option('--route <route>', 'origin, history or impact').default('origin'))
    .option('--depth <n>', 'longest chain to follow', '4')
    .addOption(new Option('--json', 'print the chains as JSON'))
    .action(async (target: string, options: { route: string; depth: string; json?: boolean }) => {
      const depth = parseDepth(options.depth);
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        const match = resolveOne(ws, io, target);
        const { chosen, result, descriptions, evidence } = traceTarget(
          ws.fossil.db,
          ws,
          match,
          options.route,
          depth,
        );
        if (options.json) {
          writeJson(io, {
            target: { ...match, key: entityKey(match.ref) },
            route: options.route,
            ...result,
            labels: Object.fromEntries([...descriptions].map(([key, d]) => [key, d.label])),
            evidence: [...evidence.values()],
          });
          return;
        }
        io.stdout(formatTrace(chosen.title, result, descriptions, evidence));
      });
    });

  program
    .command('export')
    .description('Export the evidence graph (nodes, edges, provenance, evidence) as JSON.')
    .argument('<file>', 'output file, or - for standard output')
    .option('--root <target>', 'export only the neighbourhood of this target')
    .option('--depth <n>', 'hops around --root', '2')
    .action(async (file: string, options: { root?: string; depth: string }) => {
      const depth = parseDepth(options.depth);
      await withWorkspace(openWorkspace(repoPath()), async (ws) => {
        const root = options.root ? resolveOne(ws, io, options.root).ref : undefined;
        const document = exportGraph(ws.fossil.db, ws.repositoryId, {
          repository: { name: ws.root.split('/').at(-1) ?? ws.root, path: ws.root },
          ...(root ? { root, depth } : {}),
        });
        const json = `${JSON.stringify(document, null, 2)}\n`;
        if (file === '-') {
          io.stdout(json);
          return;
        }
        const target = resolve(io.cwd, file);
        await writeFile(target, json, 'utf8');
        const truncated = document.scope.truncated.length > 0 ? ' (truncated)' : '';
        io.stdout(
          `Exported ${document.nodes.length} nodes, ${document.edges.length} edges and ` +
            `${document.evidence.length} evidence records to ${target}${truncated}.\n`,
        );
      });
    });
}
