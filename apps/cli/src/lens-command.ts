import { resolve } from 'node:path';
import { Option, type Command } from 'commander';
import { buildFileStories, issueReference, type SymbolStory } from '@codefossil/analyzers';
import { findFileByPath } from '@codefossil/db';
import { openIndexedWorkspace } from './auto-index.js';
import { CliError, writeJson, type CliIO } from './io.js';
import { toRepositoryPath, withWorkspace } from './workspace.js';

/** One line of history per symbol, as an editor shows it above the definition. */
export interface LensEntry {
  readonly qualifiedName: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  /** The introducing commit, followed back through copies; null before the indexed history. */
  readonly born: {
    readonly sha: string;
    readonly date: string;
    readonly subject: string;
    readonly author: string;
    readonly level: string;
    readonly issues: readonly string[];
  } | null;
  /** Where the code lived before it was copied into this file. */
  readonly copiedFrom: string | null;
  readonly changes: number;
  readonly fixes: number;
  readonly authors: number;
  readonly callers: number;
  readonly lastChange: {
    readonly sha: string;
    readonly date: string;
    readonly subject: string;
  } | null;
}

export interface FileLens {
  readonly path: string;
  readonly headSha: string | null;
  readonly symbols: readonly LensEntry[];
}

function lensEntry(story: SymbolStory): LensEntry {
  const born = story.events.find((e) => e.kind === 'introduced');
  const changes = story.events.filter((e) => e.kind === 'changed');
  const last = changes.at(-1);
  return {
    qualifiedName: story.symbol.qualifiedName,
    kind: story.symbol.kind,
    startLine: story.symbol.startLine,
    endLine: story.symbol.endLine,
    born:
      born && story.introduction
        ? {
            sha: born.sha,
            date: born.committedAt.slice(0, 10),
            subject: born.subject,
            author: born.authorName,
            level: story.introduction.level,
            issues: born.discussions.map((d) => issueReference(d)),
          }
        : null,
    copiedFrom: story.copiedFrom[0]?.path ?? null,
    changes: changes.length,
    fixes: story.fixes,
    authors: story.authors,
    callers: story.callers,
    lastChange: last
      ? { sha: last.sha, date: last.committedAt.slice(0, 10), subject: last.subject }
      : null,
  };
}

const plural = (n: number, noun: string, many = `${noun}s`) =>
  `${String(n)} ${n === 1 ? noun : many}`;

/** "born 2011 · 78 changes · 17 fixes · 64 callers", as the editor lens shows it. */
export function lensTitle(entry: LensEntry): string {
  return [
    entry.born ? `born ${entry.born.date.slice(0, 4)}` : 'born before the indexed history',
    ...(entry.copiedFrom ? ['moved'] : []),
    plural(entry.changes, 'change'),
    ...(entry.fixes > 0 ? [plural(entry.fixes, 'fix', 'fixes')] : []),
    ...(entry.callers > 0 ? [plural(entry.callers, 'caller')] : []),
  ].join(' · ');
}

export function registerLensCommand(program: Command, io: CliIO, repoPath: () => string): void {
  program
    .command('lens')
    .description(
      'Summarise the history of every function, class and method in a file, one line each ' +
        '(for editor integrations).',
    )
    .argument('<path>', 'file path, relative to the current directory')
    .addOption(new Option('--json', 'print the result as JSON'))
    .action(async (path: string, options: { readonly json?: boolean }) => {
      await withWorkspace(openIndexedWorkspace(repoPath(), io), (ws) => {
        const relative = toRepositoryPath(ws.root, resolve(io.cwd, path));
        const file = findFileByPath(ws.fossil.db, ws.repositoryId, relative);
        if (!file) throw new CliError(`No indexed history for ${relative}.`);
        const stories = buildFileStories(ws.fossil.db, ws.repositoryId, file.id);
        const lens: FileLens = {
          path: relative,
          headSha: stories[0]?.repository.headSha ?? null,
          // Variables and properties are mostly import bindings and constants: noise above code.
          symbols: stories
            .filter((story) => !['variable', 'property'].includes(story.symbol.kind))
            .map(lensEntry),
        };
        if (options.json) {
          writeJson(io, lens);
          return;
        }
        io.stdout(
          lens.symbols
            .map((s) => `${String(s.startLine).padStart(5)}  ${s.qualifiedName}  ${lensTitle(s)}\n`)
            .join('') || `No symbols in ${relative}.\n`,
        );
      });
    });
}
