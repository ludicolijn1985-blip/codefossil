import { loadEvidenceRecords, type FossilDb } from '@codefossil/db';
import type { EvidenceKind, EvidenceLevel } from '@codefossil/shared';
import { weakestLevel } from './traverse.js';

/**
 * One claim in an answer, with its own evidence. An answer is never more
 * certain than its least certain statement.
 */
export interface Statement {
  readonly text: string;
  /** What the statement establishes, e.g. `introducing commit`; cited as the evidence's reason. */
  readonly role: string;
  readonly level: EvidenceLevel;
  /** Confidence of the statement including the chain it depends on. */
  readonly confidence: number;
  readonly evidenceIds: readonly number[];
}

export interface EvidenceCitation {
  readonly id: number;
  readonly type: EvidenceKind;
  readonly locator: string;
  readonly excerpt: string | null;
  /** Why the evidence is cited: the roles of the statements resting on it. */
  readonly reason: string;
}

export interface RelatedEntity {
  readonly key: string;
  readonly label: string;
  /** How it relates, e.g. `mentioned by the introducing commit`. */
  readonly relation: string;
}

export interface Conclusion {
  readonly answer: string;
  readonly confidence: number;
  readonly classification: EvidenceLevel;
  readonly statements: readonly Statement[];
  readonly evidence: readonly EvidenceCitation[];
}

/** Combine statements into an answer whose certainty is that of its weakest statement. */
export function conclude(db: FossilDb, statements: readonly Statement[]): Conclusion {
  const reasons = new Map<number, Set<string>>();
  for (const statement of statements) {
    for (const id of statement.evidenceIds) {
      reasons.set(id, (reasons.get(id) ?? new Set()).add(statement.role));
    }
  }
  const records = loadEvidenceRecords(db, [...reasons.keys()]);
  const evidence = [...reasons].flatMap(([id, roles]) => {
    const record = records.get(id);
    return record
      ? [
          {
            id,
            type: record.type,
            locator: record.locator,
            excerpt: record.excerpt,
            reason: [...roles].join('; '),
          },
        ]
      : [];
  });
  return {
    answer: statements.map((s) => s.text).join(' '),
    confidence: statements.length === 0 ? 0 : Math.min(...statements.map((s) => s.confidence)),
    classification: weakestLevel(statements.map((s) => s.level)),
    statements,
    evidence,
  };
}

/** `2026-01-02T10:00:00.000Z` → `2026-01-02`. */
export const day = (iso: string): string => iso.slice(0, 10);

/** The first paragraph of a commit message body, collapsed to one line and capped. */
export function firstParagraph(body: string, max = 240): string {
  const paragraph = (body.split(/\n\s*\n/)[0] ?? '').replace(/\s+/g, ' ').trim();
  return paragraph.length > max ? `${paragraph.slice(0, max - 1)}…` : paragraph;
}
