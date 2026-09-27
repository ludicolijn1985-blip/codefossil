import type { Runtime, Version } from '@codefossil/graph';

/**
 * Deterministic readings of commit, issue and pull-request text. They find
 * words, not intent: a match says the text uses workaround language, never
 * that the code is a workaround.
 */

const WORKAROUND_PATTERNS: readonly RegExp[] = [
  /\bwork[- ]?arounds?\b/i,
  /\bhack(?:s|y|ish)?\b/i,
  /\bkludge\b/i,
  /\btemporar(?:y|ily)\b/i,
  /\bcompat(?:ibility|ible)?\b/i,
  /\bpolyfills?\b/i,
  /\bshims?\b/i,
  /\blegacy\b/i,
  /\bdeprecat(?:e|ed|es|ion)\b/i,
  /\bbackport(?:s|ed)?\b/i,
  /\bmonkey[- ]?patch(?:es|ed)?\b/i,
  /\bremove (?:this |it )?(?:once|when|after)\b/i,
  /\bfor (?:older|old) (?:versions?|browsers|clients|releases)\b/i,
];

const EXCERPT_LENGTH = 160;

export interface TextMatch {
  /** The matched words. */
  readonly phrase: string;
  /** The line the words appear on, trimmed to a readable length. */
  readonly excerpt: string;
}

function lineAround(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  const end = text.indexOf('\n', index);
  const line = text.slice(start, end === -1 ? undefined : end).trim();
  return line.length > EXCERPT_LENGTH ? `${line.slice(0, EXCERPT_LENGTH - 1)}…` : line;
}

/**
 * Wording that takes a workaround away rather than adding one: "remove
 * deprecated createServer()", "drop the legacy shim".
 */
const REMOVAL =
  /\b(?:remov(?:e|es|ed|ing)|drop(?:s|ped|ping)?|delet(?:e|es|ed|ing)|clean(?:s|ed)? up|get(?:ting)? rid of|no longer|kill(?:s|ed)?|revert(?:s|ed)?)\b/i;

export interface WorkaroundMatch extends TextMatch {
  /** Whether the words are on the first line (a commit subject, an issue or PR title). */
  readonly inFirstLine: boolean;
}

/**
 * The first workaround or compatibility wording in the text, or null. A match
 * on a line that removes something ("remove deprecated …") does not count.
 */
export function workaroundLanguage(text: string): WorkaroundMatch | null {
  const firstLineEnd = text.indexOf('\n') === -1 ? text.length : text.indexOf('\n');
  let first: { index: number; phrase: string } | null = null;
  for (const pattern of WORKAROUND_PATTERNS) {
    const global = new RegExp(pattern.source, `${pattern.flags}g`);
    for (const match of text.matchAll(global)) {
      const lineStart = text.lastIndexOf('\n', match.index - 1) + 1;
      if (REMOVAL.test(text.slice(lineStart, match.index))) continue;
      if (!first || match.index < first.index) first = { index: match.index, phrase: match[0] };
      break;
    }
  }
  return first
    ? {
        phrase: first.phrase,
        excerpt: lineAround(text, first.index),
        inFirstLine: first.index < firstLineEnd,
      }
    : null;
}

export interface VersionReference {
  readonly runtime: Runtime;
  readonly major: number;
  /** Null when the text names only a major version (`Node 14`, `Python 3`). */
  readonly minor: number | null;
  readonly phrase: string;
}

const VERSION_PATTERNS: readonly (readonly [Runtime, RegExp])[] = [
  ['node', /\bnode(?:\.?js)?\s*v?(\d{1,2})(?:\.(\d{1,2}))?(?:\.x)?\b/gi],
  ['python', /\bpython\s*(\d)(?:\.(\d{1,2}))?\b/gi],
  ['go', /\bgo\s*(1)\.(\d{1,2})\b/gi],
  ['rust', /\brustc?\s*(1)\.(\d{1,3})\b/gi],
];

/** Runtime versions the text names, e.g. `Node 14`, `Python 2.7`, `Go 1.20`. */
export function versionReferences(text: string): VersionReference[] {
  return VERSION_PATTERNS.flatMap(([runtime, pattern]) =>
    [...text.matchAll(pattern)].map((match) => ({
      runtime,
      major: Number(match[1]),
      minor: match[2] === undefined ? null : Number(match[2]),
      phrase: match[0],
    })),
  );
}

/**
 * Whether a referenced version is older than the oldest the project supports.
 * `Python 3` against `>=3.10` is not older: a bare major version names the
 * whole series.
 */
export function isBelowMinimum(reference: VersionReference, minimum: Version): boolean {
  if (reference.major !== minimum.major) return reference.major < minimum.major;
  return reference.minor !== null && reference.minor < minimum.minor;
}

export interface Deadline extends TextMatch {
  /** The last moment the stated deadline covers, as an ISO date. */
  readonly date: string;
}

const DEADLINE =
  /\b(?:until|till|before|after|by|remove (?:in|after|by|on)|expires?(?: on)?|deadline)\s+(\d{4}-\d{2}(?:-\d{2})?|Q[1-4]\s+\d{4}|\d{4})\b/gi;
const EARLIEST_YEAR = 2000;
const LATEST_YEAR = 2100;

/** End of the period a written date names: a year, a month, a quarter or a day. */
function endOf(written: string): Date | null {
  const quarter = /^Q([1-4])\s+(\d{4})$/i.exec(written);
  const parts = quarter
    ? [Number(quarter[2]), Number(quarter[1]) * 3]
    : written.split('-').map(Number);
  const year = parts[0];
  const month = parts[1];
  const day = parts[2];
  if (year === undefined || year < EARLIEST_YEAR || year > LATEST_YEAR) return null;
  if (month === undefined) return new Date(Date.UTC(year, 11, 31));
  if (month < 1 || month > 12) return null;
  if (day === undefined) return new Date(Date.UTC(year, month, 0));
  return new Date(Date.UTC(year, month - 1, day));
}

/** Dates the text sets as a deadline ("until 2024-06", "remove after Q1 2025"). */
export function deadlines(text: string): Deadline[] {
  return [...text.matchAll(DEADLINE)].flatMap((match) => {
    const date = endOf(match[1] ?? '');
    return date
      ? [
          {
            phrase: match[0],
            excerpt: lineAround(text, match.index),
            date: date.toISOString().slice(0, 10),
          },
        ]
      : [];
  });
}
