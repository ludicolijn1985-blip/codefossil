import type { AnalysisCommit, CommitDiscussion } from '@codefossil/db';
import { issueReference, type EvidenceLevel } from '@codefossil/shared';

/** Why a commit is counted as defect-related, and how sure that reading is. */
export interface DefectSignal {
  readonly reason: string;
  readonly level: EvidenceLevel;
  readonly confidence: number;
  readonly evidenceIds: readonly number[];
}

const BUG_LABEL = /\b(bug|defect|regression|crash|incident)\b/i;
const REVERT = /^Revert "|This reverts commit [0-9a-f]{7,}/im;
const CONVENTIONAL_FIX = /^(?:fix|hotfix|bugfix)(?:\([^)]*\))?!?:/i;
const FIX_WORDS = /\b(?:fix(?:es|ed)?|bug(?:fix)?|hotfix|crash(?:es|ed)?|regression|broken)\b/i;
/**
 * Fixes to prose, formatting, tooling or dependency versions are not defects
 * in the code: `fix(deps): bump qs`, `Fix an incorrect @api jsdoc`.
 */
const NOT_A_DEFECT =
  /\b(?:typos?|spelling|lint(?:ing)?|format(?:ting)?|docs?|documentation|jsdoc|comments?|readme|changelog|whitespace|bump(?:s|ed)?|deps|dev-?deps|dependenc(?:y|ies)|dependabot|renovate)\b|^(?:fix|hotfix|bugfix)\((?:deps|deps-dev|dev-?deps|ci|build|docs?|tests?|lint|release|chore|types|refactor|style|perf)\)/i;

/** Confidence of each heuristic; a label on a resolved issue is the strongest reading. */
export const DEFECT_CONFIDENCE = {
  revert: 0.7,
  /** A commit naming a Jira or Linear bug ticket by key: most such commits work on the bug. */
  bugTicket: 0.7,
  conventionalFix: 0.6,
  fixWords: 0.5,
} as const;

function strongest(signals: readonly DefectSignal[]): DefectSignal | undefined {
  return [...signals].sort((a, b) => b.confidence - a.confidence)[0];
}

/**
 * Classify commits as defect-related from what the history records: an issue
 * labelled as a bug that the commit resolves (DERIVED — the link and the label
 * are recorded), a revert, or fix wording in the subject (INFERRED — words are
 * a hint, not proof). Commits without a signal are absent from the result.
 */
export function classifyDefects(
  commits: readonly AnalysisCommit[],
  discussions: readonly CommitDiscussion[],
  commitEvidence: ReadonlyMap<string, number>,
): Map<number, DefectSignal> {
  const resolvedBugs = new Map<number, CommitDiscussion[]>();
  for (const discussion of discussions) {
    if (discussion.relation !== 'RESOLVED_BY' || discussion.type !== 'issue') continue;
    if (!discussion.labels.some((label) => BUG_LABEL.test(label))) continue;
    resolvedBugs.set(discussion.commitId, [
      ...(resolvedBugs.get(discussion.commitId) ?? []),
      discussion,
    ]);
  }

  // Tracker issues are linked by the key a commit names, not by a closing keyword.
  const bugTickets = new Map<number, CommitDiscussion[]>();
  for (const discussion of discussions) {
    if (discussion.relation !== 'REFERENCES' || discussion.type !== 'issue') continue;
    if (discussion.provider !== 'jira' && discussion.provider !== 'linear') continue;
    if (!discussion.labels.some((label) => BUG_LABEL.test(label))) continue;
    bugTickets.set(discussion.commitId, [
      ...(bugTickets.get(discussion.commitId) ?? []),
      discussion,
    ]);
  }

  const result = new Map<number, DefectSignal>();
  for (const commit of commits) {
    const own = commitEvidence.get(commit.sha);
    const cite = (extra: readonly number[] = []) => [...(own === undefined ? [] : [own]), ...extra];
    const signals: DefectSignal[] = (resolvedBugs.get(commit.id) ?? []).map((issue) => ({
      reason: `resolves issue ${issueReference(issue)}, labelled ${issue.labels.filter((l) => BUG_LABEL.test(l)).join(', ')}`,
      level: issue.level === 'INFERRED' ? 'INFERRED' : 'DERIVED',
      confidence: issue.confidence,
      evidenceIds: cite(issue.evidenceIds),
    }));
    for (const ticket of bugTickets.get(commit.id) ?? []) {
      signals.push({
        reason: `names ${ticket.provider === 'jira' ? 'Jira' : 'Linear'} bug ${issueReference(ticket)}`,
        level: 'INFERRED',
        confidence: DEFECT_CONFIDENCE.bugTicket,
        evidenceIds: cite(ticket.evidenceIds),
      });
    }
    if (REVERT.test(`${commit.subject}\n${commit.body}`)) {
      signals.push({
        reason: 'reverts an earlier change',
        level: 'INFERRED',
        confidence: DEFECT_CONFIDENCE.revert,
        evidenceIds: cite(),
      });
    } else if (!NOT_A_DEFECT.test(commit.subject)) {
      if (CONVENTIONAL_FIX.test(commit.subject)) {
        signals.push({
          reason: 'subject is marked as a fix',
          level: 'INFERRED',
          confidence: DEFECT_CONFIDENCE.conventionalFix,
          evidenceIds: cite(),
        });
      } else {
        const words = FIX_WORDS.exec(commit.subject);
        if (words) {
          signals.push({
            reason: `subject says "${words[0]}"`,
            level: 'INFERRED',
            confidence: DEFECT_CONFIDENCE.fixWords,
            evidenceIds: cite(),
          });
        }
      }
    }
    const best = strongest(signals);
    if (best) result.set(commit.id, best);
  }
  return result;
}
