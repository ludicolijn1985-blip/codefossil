import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { Option, type Command } from 'commander';
import {
  getGraphIndexedSha,
  getInvestigation,
  listInvestigations,
  saveInvestigation,
} from '@codefossil/db';
import {
  analyzeImpact,
  buildTimeline,
  investigateWhy,
  parseQuestion,
  resolveTarget,
  type ImpactReport,
  type QuestionKind,
  type TargetMatch,
  type WhyInvestigation,
} from '@codefossil/query';
import {
  formatImpact,
  formatInvestigationList,
  formatTimeline,
  formatWhy,
} from './format-investigation.js';
import { resolveOne } from './graph-commands.js';
import { CliError, writeJson, type CliIO } from './io.js';
import { openWorkspace, toRepositoryPath, withWorkspace, type Workspace } from './workspace.js';

const SUPPORTED_QUESTIONS =
  'CODEFOSSIL answers these questions from evidence:\n' +
  '  why does <target> exist?        (also: what is <target> for?)\n' +
  '  what depends on <target>?       (also: who uses / what breaks if I change <target>)\n' +
  '  history of <path>               (also: what changed in <path>?)\n' +
  'Open-ended questions need the optional AI layer, which is not configured.';

interface AskOptions {
  readonly json?: boolean;
  readonly save: boolean;
  readonly depth?: number;
  readonly question?: string;
}

function parseDepth(value: string): number {
  const depth = Number(value);
  if (!Number.isSafeInteger(depth) || depth < 1 || depth > 10) {
    throw new CliError(`--depth must be a whole number from 1 to 10, got "${value}".`);
  }
  return depth;
}

function save(ws: Workspace, result: WhyInvestigation | ImpactReport): number {
  const evidenceIds =
    result.kind === 'why'
      ? result.evidence.map((e) => e.id)
      : [...result.direct, ...result.transitive].flatMap((d) => d.evidenceIds);
  return saveInvestigation(ws.fossil.db, {
    repositoryId: ws.repositoryId,
    query: result.question,
    kind: result.kind,
    targetKey: result.target.key,
    answer: result.answer,
    confidence: result.confidence,
    classification: result.classification,
    evidenceIds,
    result,
    headSha: getGraphIndexedSha(ws.fossil.db, ws.repositoryId),
  }).id;
}

/** Run one investigation and print it; the shared core of every command and the REPL. */
function answer(
  ws: Workspace,
  io: CliIO,
  kind: QuestionKind,
  match: TargetMatch,
  options: AskOptions,
): void {
  if (kind === 'timeline') {
    if (match.ref.type !== 'file') {
      throw new CliError(
        `A timeline is built for a file; "${match.label}" is a ${match.ref.type}.`,
      );
    }
    const timeline = buildTimeline(ws.fossil.db, ws.repositoryId, match.ref.id);
    if (options.json) writeJson(io, timeline);
    else io.stdout(formatTimeline(timeline));
    return;
  }
  const result =
    kind === 'why'
      ? investigateWhy(ws.fossil.db, ws.repositoryId, match.ref, options.question)
      : analyzeImpact(ws.fossil.db, ws.repositoryId, match.ref, {
          ...(options.depth ? { depth: options.depth } : {}),
          ...(options.question ? { question: options.question } : {}),
        });
  const savedId = options.save ? save(ws, result) : null;
  if (options.json) {
    writeJson(io, { ...result, investigationId: savedId });
    return;
  }
  io.stdout(result.kind === 'why' ? formatWhy(result, savedId) : formatImpact(result, savedId));
}

/** The single entity a question is about, trying its candidate words in order. */
function resolveQuestionTarget(
  ws: Workspace,
  io: CliIO,
  candidates: readonly string[],
): TargetMatch {
  let ambiguous: { word: string; count: number } | null = null;
  for (const word of candidates) {
    let matches = resolveTarget(ws.fossil.db, ws.repositoryId, word);
    const onDisk = resolve(io.cwd, word);
    if (matches.length === 0 && existsSync(onDisk)) {
      try {
        matches = resolveTarget(ws.fossil.db, ws.repositoryId, toRepositoryPath(ws.root, onDisk));
      } catch {
        matches = [];
      }
    }
    const [only] = matches;
    // A more specific word that was ambiguous wins over a later, vaguer match:
    // asking again beats answering about the wrong thing.
    if (only && matches.length === 1 && !ambiguous) return only;
    if (matches.length > 1) ambiguous ??= { word, count: matches.length };
  }
  if (ambiguous) {
    throw new CliError(
      `"${ambiguous.word}" matches ${ambiguous.count} entities; ask again with a path or path:Symbol.`,
    );
  }
  throw new CliError(
    `The question names nothing found in the index (tried: ${candidates.join(', ') || 'no words'}).`,
  );
}

function ask(ws: Workspace, io: CliIO, text: string, options: AskOptions): void {
  const parsed = parseQuestion(text);
  if (!parsed) throw new CliError(SUPPORTED_QUESTIONS);
  const match = resolveQuestionTarget(ws, io, parsed.candidates);
  answer(ws, io, parsed.kind, match, { ...options, question: text });
}

function isInvestigationResult(value: unknown): value is WhyInvestigation | ImpactReport {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    (value.kind === 'why' || value.kind === 'impact')
  );
}

function show(ws: Workspace, io: CliIO, id: number, json: boolean): void {
  const row = getInvestigation(ws.fossil.db, ws.repositoryId, id);
  if (!row) throw new CliError(`No investigation #${id}.`);
  if (json) {
    writeJson(io, row);
    return;
  }
  const result = row.resultJson;
  const header = `Investigation #${row.id} from ${row.createdAt} (index at ${row.headSha?.slice(0, 7) ?? 'unknown HEAD'}); later history may change the answer.\n\n`;
  if (!isInvestigationResult(result)) {
    io.stdout(`${header}${row.answer}\n`);
    return;
  }
  try {
    io.stdout(
      header + (result.kind === 'why' ? formatWhy(result, null) : formatImpact(result, null)),
    );
  } catch {
    // Stored by an older version in another shape: the answer text is still valid.
    io.stdout(`${header}${row.answer}\n(The full stored result could not be displayed.)\n`);
  }
}

const REPL_HELP =
  'Commands: why <target> · impact <target> · timeline <path> · list · show <id> · help · exit\n' +
  'Or ask a question, e.g. "why does calculateVAT exist?"\n';

async function repl(ws: Workspace, io: CliIO): Promise<void> {
  if (!io.readLines) throw new CliError('Interactive input is not available.');
  const prompt = () => {
    if (io.interactive) io.stdout('fossil> ');
  };
  if (io.interactive) io.stdout(`Investigating ${ws.root}. ${REPL_HELP}`);
  prompt();
  for await (const raw of io.readLines()) {
    const line = raw.trim();
    if (line === 'exit' || line === 'quit') break;
    try {
      const [command = '', ...rest] = line.split(/\s+/);
      const argument = rest.join(' ');
      if (line === '') {
        // nothing to do
      } else if (command === 'help') {
        io.stdout(REPL_HELP);
      } else if (command === 'list') {
        io.stdout(formatInvestigationList(listInvestigations(ws.fossil.db, ws.repositoryId)));
      } else if (command === 'show' && /^\d+$/.test(argument)) {
        show(ws, io, Number(argument), false);
      } else if (
        (command === 'why' || command === 'impact' || command === 'timeline') &&
        argument
      ) {
        answer(ws, io, command, resolveOne(ws, io, argument), { save: true });
      } else {
        ask(ws, io, line, { save: true });
      }
    } catch (error) {
      // One failed question must not end the session.
      const message = error instanceof Error ? error.message : String(error);
      io.stderr(error instanceof CliError ? `${message}\n` : `Unexpected error: ${message}\n`);
    }
    prompt();
  }
}

export function registerInvestigationCommands(
  program: Command,
  io: CliIO,
  repoPath: () => string,
): void {
  const json = () => new Option('--json', 'print the result as JSON');
  const noSave = () => new Option('--no-save', 'do not record the investigation');

  program
    .command('why')
    .description('Explain why a symbol, file, commit, issue or dependency exists, from evidence.')
    .argument('<target>', 'symbol, path, path:Symbol, commit sha, #123 or npm:package')
    .addOption(json())
    .addOption(noSave())
    .action(async (target: string, options: AskOptions) => {
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        answer(ws, io, 'why', resolveOne(ws, io, target), options);
      });
    });

  program
    .command('impact')
    .description('Show what depends on a symbol, file or dependency, directly and transitively.')
    .argument('<target>', 'symbol, path, path:Symbol or npm:package')
    .option('--depth <n>', 'longest import chain to follow', '5')
    .addOption(json())
    .addOption(noSave())
    .action(async (target: string, options: AskOptions & { depth: string }) => {
      const depth = parseDepth(options.depth);
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        answer(ws, io, 'impact', resolveOne(ws, io, target), { ...options, depth });
      });
    });

  program
    .command('timeline')
    .description('Show every change to a file, across renames, with pull requests and issues.')
    .argument('<path>', 'file path')
    .addOption(json())
    .action(async (path: string, options: { json?: boolean }) => {
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        answer(ws, io, 'timeline', resolveOne(ws, io, path), { ...options, save: false });
      });
    });

  program
    .command('query')
    .description('Ask a question in plain words, e.g. "Why does calculateVAT exist?".')
    .argument('<question>', 'the question, quoted')
    .addOption(json())
    .addOption(noSave())
    .action(async (question: string, options: AskOptions) => {
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        ask(ws, io, question, options);
      });
    });

  program
    .command('investigate')
    .description(
      'Investigate interactively (reads commands from standard input), or review past investigations.',
    )
    .option('--list', 'list saved investigations')
    .option('--show <id>', 'show a saved investigation as it was answered')
    .addOption(json())
    .action(async (options: { list?: boolean; show?: string; json?: boolean }) => {
      await withWorkspace(openWorkspace(repoPath()), async (ws) => {
        if (options.list) {
          const rows = listInvestigations(ws.fossil.db, ws.repositoryId);
          if (options.json) writeJson(io, rows);
          else io.stdout(formatInvestigationList(rows));
          return;
        }
        if (options.show !== undefined) {
          if (!/^\d+$/.test(options.show))
            throw new CliError('--show needs an investigation number.');
          show(ws, io, Number(options.show), options.json === true);
          return;
        }
        await repl(ws, io);
      });
    });
}
