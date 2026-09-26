export type QuestionKind = 'why' | 'impact' | 'timeline';

export interface ParsedQuestion {
  readonly kind: QuestionKind;
  /** Possible targets, most likely first: quoted text, then remaining words. */
  readonly candidates: readonly string[];
}

const PATTERNS: readonly (readonly [QuestionKind, RegExp])[] = [
  [
    'impact',
    /\b(?:what|who|which)\b.*\b(?:depends?|uses?|imports?|breaks?|affected)\b|\bimpact of\b|\bwhat breaks\b/i,
  ],
  [
    'timeline',
    /\b(?:history|timeline|evolution) of\b|\bwhat changed in\b|\bhow (?:did|has)\b.*\bchange|\bwhen (?:was|were|did)\b.*\bchang/i,
  ],
  ['why', /\bwhy\b|\bwhat is .* for\b|\breason for\b|\bpurpose of\b/i],
];

const STOP_WORDS = new Set(
  (
    'a an and are breaks break by change changed changes code depend depends did do does ' +
    'evolution exist exists file for function history how i if impact import imports in is it ' +
    'its module need needed of on purpose reason still the there this timeline to use used ' +
    'uses was we were what when which who why class method still here affected'
  ).split(' '),
);

/**
 * Recognize the questions CODEFOSSIL can answer deterministically — why
 * something exists, what depends on it, how it changed — and pull out what
 * they are about. Anything else is left unanswered rather than guessed at;
 * open-ended questions need the optional AI layer.
 */
export function parseQuestion(text: string): ParsedQuestion | null {
  const kind = PATTERNS.find(([, pattern]) => pattern.test(text))?.[0];
  if (!kind) return null;
  const quoted = [...text.matchAll(/[`'"]([^`'"]+)[`'"]/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  const words = text
    .replace(/[`'"]([^`'"]+)[`'"]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^[(]+|[?.,!:;)]+$/g, ''))
    .filter((word) => word.length > 0 && !STOP_WORDS.has(word.toLowerCase()));
  // Longer words are more specific (paths, qualified names) and are tried first.
  const ranked = [...words].sort((a, b) => b.length - a.length);
  return { kind, candidates: [...new Set([...quoted, ...ranked])] };
}
