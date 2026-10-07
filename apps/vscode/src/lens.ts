/**
 * The `lens` result of `codefossil` (one line of history per symbol), and
 * how the editor shows it. Kept free of the `vscode` module so it can be
 * tested on its own.
 */
export interface LensEntry {
  readonly qualifiedName: string;
  readonly kind: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly born: {
    readonly sha: string;
    readonly date: string;
    readonly subject: string;
    readonly author: string;
    readonly level: string;
    readonly issues: readonly string[];
  } | null;
  readonly copiedFrom: string | null;
  /** Absent from codefossil 0.2.0, which reported every lineage as a move. */
  readonly lineage?: 'copied' | 'renamed' | 'moved' | null;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isEntry = (value: unknown): value is LensEntry =>
  isRecord(value) &&
  typeof value.qualifiedName === 'string' &&
  typeof value.kind === 'string' &&
  typeof value.startLine === 'number' &&
  typeof value.endLine === 'number' &&
  typeof value.changes === 'number' &&
  typeof value.fixes === 'number' &&
  typeof value.callers === 'number';

/** Parse the JSON `codefossil lens` prints; null when it is not a lens. */
export function parseLens(text: string): FileLens | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || typeof value.path !== 'string' || !Array.isArray(value.symbols)) {
    return null;
  }
  return {
    path: value.path,
    headSha: typeof value.headSha === 'string' ? value.headSha : null,
    symbols: value.symbols.filter(isEntry),
  };
}

const plural = (n: number, noun: string, many = `${noun}s`) =>
  `${String(n)} ${n === 1 ? noun : many}`;

/** "born 2011 · moved · 78 changes · 17 fixes · 64 callers". */
export function lensTitle(entry: LensEntry): string {
  return [
    entry.born ? `born ${entry.born.date.slice(0, 4)}` : 'born before the indexed history',
    ...(entry.copiedFrom ? [entry.lineage ?? 'moved'] : []),
    plural(entry.changes, 'change'),
    ...(entry.fixes > 0 ? [plural(entry.fixes, 'fix', 'fixes')] : []),
    ...(entry.callers > 0 ? [plural(entry.callers, 'caller')] : []),
  ].join(' · ');
}

/** Repository text is untrusted: no markdown, links or HTML may get through. */
export function escapeMarkdown(text: string): string {
  return text.replace(/[\r\n]+/g, ' ').replace(/[\\`*_{}[\]()<>#+\-.!|~&]/g, (c) => `\\${c}`);
}

/** The hover over a symbol: where it came from and what happened to it since. */
export function hoverMarkdown(entry: LensEntry): string {
  const lines = [
    `**${escapeMarkdown(entry.qualifiedName)}** · ${escapeMarkdown(lensTitle(entry))}`,
    '',
  ];
  if (entry.born) {
    const issues =
      entry.born.issues.length > 0 ? ` (${entry.born.issues.map(escapeMarkdown).join(', ')})` : '';
    lines.push(
      `Born ${entry.born.date} in \`${entry.born.sha.slice(0, 7)}\` — ${escapeMarkdown(entry.born.subject)}${issues}, by ${escapeMarkdown(entry.born.author)} · ${entry.born.level}`,
    );
  } else {
    lines.push('Its origin lies before the indexed history.');
  }
  if (entry.copiedFrom)
    lines.push(
      '',
      `${entry.lineage === 'renamed' ? 'Renamed in' : entry.lineage === 'copied' ? 'Copied here from' : 'Moved here from'} \`${entry.copiedFrom.replace(/`/g, '')}\`.`,
    );
  if (entry.lastChange) {
    lines.push(
      '',
      `Last changed ${entry.lastChange.date} in \`${entry.lastChange.sha.slice(0, 7)}\` — ${escapeMarkdown(entry.lastChange.subject)}`,
    );
  }
  lines.push('', '_Fixes are recognised from commit wording and reverts, so most are inferences._');
  return lines.join('\n');
}

/** The symbol whose lines contain `line` (1-based), innermost first. */
export function symbolAt(lens: FileLens, line: number): LensEntry | null {
  let best: LensEntry | null = null;
  for (const entry of lens.symbols) {
    if (entry.startLine > line || entry.endLine < line) continue;
    if (!best || entry.endLine - entry.startLine < best.endLine - best.startLine) best = entry;
  }
  return best;
}
