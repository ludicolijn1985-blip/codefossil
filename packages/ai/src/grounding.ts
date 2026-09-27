import { commitEvidenceIds, commitsMentioning, type FossilDb } from '@codefossil/db';
import { investigateWhy, resolveTarget, type WhyInvestigation } from '@codefossil/query';
import type { EvidenceKind, EvidenceLevel } from '@codefossil/shared';

/** One piece of evidence the model may cite, by its id in the evidence table. */
export interface GroundingEvidence {
  readonly id: number;
  readonly type: EvidenceKind;
  readonly locator: string;
  /** Null when there is none, or when it is source code the user did not allow to be sent. */
  readonly excerpt: string | null;
}

/** A statement CODEFOSSIL already established deterministically. */
export interface GroundingStatement {
  readonly text: string;
  readonly level: EvidenceLevel;
  readonly confidence: number;
  readonly evidenceIds: readonly number[];
}

/** Everything the model is shown: nothing outside this reaches it. */
export interface Grounding {
  readonly question: string;
  readonly targets: readonly string[];
  readonly statements: readonly GroundingStatement[];
  readonly evidence: readonly GroundingEvidence[];
  /** No AI claim may be more certain than this. */
  readonly ceiling: number;
}

export interface GroundingOptions {
  /** Send symbol signatures (source excerpts); off unless the user allowed it. */
  readonly includeSource: boolean;
}

export const MAX_EVIDENCE = 40;
export const MAX_EXCERPT = 600;
const MAX_TARGETS = 4;
const MAX_MATCHES_PER_WORD = 3;
const MAX_KEYWORDS = 8;
const MAX_COMMITS = 10;
const MIN_WORD = 3;
/** Evidence types whose excerpt is source code. */
const SOURCE_TYPES: ReadonlySet<EvidenceKind> = new Set(['ast_node']);

const STOP_WORDS = new Set(
  (
    'about after also and any are because been before being but can could did does doing ' +
    'each for from had has have how into its just more most not now only other our out over ' +
    'should some such than that the their them then there these they this those through too ' +
    'under until very was were what when where which while who whom why will with would you your ' +
    'code file files function exist exists change changed changes still used uses use'
  ).split(' '),
);

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > MAX_EXCERPT ? `${trimmed.slice(0, MAX_EXCERPT - 1)}…` : trimmed;
}

function evidenceItem(
  item: { id: number; type: EvidenceKind; locator: string; excerpt: string | null },
  options: GroundingOptions,
): GroundingEvidence {
  const withheld = SOURCE_TYPES.has(item.type) && !options.includeSource;
  return {
    id: item.id,
    type: item.type,
    locator: item.locator,
    excerpt: withheld || item.excerpt === null ? null : clip(item.excerpt),
  };
}

/** Words of a question worth looking up, most specific (longest) first. */
export function questionKeywords(question: string): string[] {
  const words = question
    .split(/[\s,;:!?()"'`]+/)
    .map((word) => word.replace(/^[.]+|[.]+$/g, ''))
    .filter((word) => word.length >= MIN_WORD && !STOP_WORDS.has(word.toLowerCase()));
  return [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, MAX_KEYWORDS);
}

/** Ground a summary in one deterministic why-investigation, and nothing else. */
export function groundingFromWhy(why: WhyInvestigation, options: GroundingOptions): Grounding {
  return {
    question: why.question,
    targets: [why.target.label],
    statements: why.statements.map((s) => ({
      text: s.text,
      level: s.level,
      confidence: s.confidence,
      evidenceIds: s.evidenceIds,
    })),
    evidence: why.evidence.map((e) => evidenceItem(e, options)),
    ceiling: why.confidence,
  };
}

/**
 * Gather evidence for an open question deterministically: why-investigations
 * of the entities the question names (skipping words that match too many),
 * and commits whose messages use its words. Null when the index holds
 * nothing related — the model is then not asked at all.
 */
export function gatherGrounding(
  db: FossilDb,
  repositoryId: number,
  question: string,
  options: GroundingOptions,
): Grounding | null {
  const keywords = questionKeywords(question);
  const targets = new Map<string, WhyInvestigation>();
  for (const word of keywords) {
    if (targets.size >= MAX_TARGETS) break;
    const matches = resolveTarget(db, repositoryId, word);
    if (matches.length === 0 || matches.length > MAX_MATCHES_PER_WORD) continue;
    for (const match of matches) {
      const key = `${match.ref.type}:${String(match.ref.id)}`;
      if (targets.size < MAX_TARGETS && !targets.has(key)) {
        targets.set(key, investigateWhy(db, repositoryId, match.ref));
      }
    }
  }

  const statements: GroundingStatement[] = [];
  const evidence = new Map<number, GroundingEvidence>();
  for (const why of targets.values()) {
    for (const s of why.statements) {
      statements.push({
        text: s.text,
        level: s.level,
        confidence: s.confidence,
        evidenceIds: s.evidenceIds,
      });
    }
    for (const e of why.evidence) evidence.set(e.id, evidenceItem(e, options));
  }

  const commitEvidence = commitEvidenceIds(db, repositoryId);
  for (const commit of commitsMentioning(db, repositoryId, keywords, MAX_COMMITS)) {
    const id = commitEvidence.get(commit.sha);
    if (id === undefined || evidence.has(id)) continue;
    evidence.set(id, {
      id,
      type: 'commit',
      locator: commit.sha,
      excerpt: clip(`${commit.subject}\n\n${commit.body}`),
    });
  }

  if (evidence.size === 0) return null;
  return {
    question,
    targets: [...targets.values()].map((why) => why.target.label),
    statements,
    evidence: [...evidence.values()].slice(0, MAX_EVIDENCE),
    ceiling: 1,
  };
}
