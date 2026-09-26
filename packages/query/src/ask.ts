import { getGraphIndexedSha, saveInvestigation, type FossilDb } from '@codefossil/db';
import type { ImpactReport } from './impact.js';
import { parseQuestion, type QuestionKind } from './question.js';
import { resolveTarget, type TargetMatch } from './resolve-target.js';
import type { WhyInvestigation } from './why.js';

export type QuestionResolution =
  | { readonly status: 'ok'; readonly kind: QuestionKind; readonly match: TargetMatch }
  | { readonly status: 'unsupported' }
  | {
      readonly status: 'ambiguous';
      readonly word: string;
      readonly matches: readonly TargetMatch[];
    }
  | { readonly status: 'not_found'; readonly tried: readonly string[] };

/**
 * Work out what a plain-words question asks about. Candidate words are tried
 * from most to least specific; if a more specific word is ambiguous the
 * question is ambiguous — it is never answered about a vaguer word instead.
 * `fallback` lets callers resolve words another way (e.g. as paths on disk).
 */
export function resolveQuestion(
  db: FossilDb,
  repositoryId: number,
  question: string,
  fallback?: (word: string) => TargetMatch[],
): QuestionResolution {
  const parsed = parseQuestion(question);
  if (!parsed) return { status: 'unsupported' };
  for (const word of parsed.candidates) {
    let matches = resolveTarget(db, repositoryId, word);
    if (matches.length === 0 && fallback) matches = fallback(word);
    const [only] = matches;
    if (matches.length > 1) return { status: 'ambiguous', word, matches };
    if (only) return { status: 'ok', kind: parsed.kind, match: only };
  }
  return { status: 'not_found', tried: parsed.candidates };
}

/** Record an investigation with the evidence its answer rests on; returns its id. */
export function recordInvestigation(
  db: FossilDb,
  repositoryId: number,
  result: WhyInvestigation | ImpactReport,
): number {
  const evidenceIds =
    result.kind === 'why'
      ? result.evidence.map((e) => e.id)
      : [...result.direct, ...result.transitive].flatMap((d) => d.evidenceIds);
  return saveInvestigation(db, {
    repositoryId,
    query: result.question,
    kind: result.kind,
    targetKey: result.target.key,
    answer: result.answer,
    confidence: result.confidence,
    classification: result.classification,
    evidenceIds,
    result,
    headSha: getGraphIndexedSha(db, repositoryId),
  }).id;
}

export const SUPPORTED_QUESTIONS =
  'CODEFOSSIL answers these questions from evidence:\n' +
  '  why does <target> exist?        (also: what is <target> for?)\n' +
  '  what depends on <target>?       (also: who uses / what breaks if I change <target>)\n' +
  '  history of <path>               (also: what changed in <path>?)\n' +
  'Open-ended questions need the optional AI layer, which is not configured.';
