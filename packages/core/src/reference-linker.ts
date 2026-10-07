import {
  commitEvidenceIds,
  deleteRelationsByProducer,
  externalIdsByNumber,
  findCommitBySha,
  findEvidenceId,
  foreignReference,
  listCommitMessages,
  listPullRequests,
  pullRequestCommitShas,
  recordRelation,
  type CommitMessage,
  type FossilDb,
  type PullRequestRow,
} from '@codefossil/db';
import { parseReferences, type TextReference } from '@codefossil/providers';
import { GITHUB_CLOSING_METHOD, type EntityRef, type RelationInput } from '@codefossil/shared';

export const GITHUB_LINKER_PRODUCER = 'github-linker@0.2.0';
/** Earlier versions, whose links are replaced on every run. */
const LEGACY_PRODUCERS = ['github-linker@0.1.0'];

/**
 * A closing keyword closes the issue only when the change reaches the default
 * branch, which the index cannot confirm for every pull request or commit.
 */
const CLOSING_KEYWORD_CONFIDENCE = 0.9;

/** `git revert` writes this line; the sha may be abbreviated. */
const REVERT_MARKER = /This reverts commit ([0-9a-f]{7,64})/gi;

export interface LinkResult {
  readonly pullRequestCommits: number;
  readonly resolutions: number;
  readonly references: number;
}

type Draft = Omit<RelationInput, 'repositoryId' | 'provenance'> & {
  readonly method: string;
  readonly evidenceId: number | undefined;
  readonly details?: Record<string, unknown>;
};

interface Lookups {
  readonly issues: ReadonlyMap<number, number>;
  readonly pullRequests: ReadonlyMap<number, number>;
  /** Issues of other repositories, by `foreignReference`. */
  readonly foreignIssues: ReadonlyMap<string, number>;
  /** Commits undone by a later `git revert`. */
  readonly reverted: ReadonlySet<string>;
}

/**
 * Rebuild the links between GitHub records and history from stored data:
 * - `pull_request IMPLEMENTED_BY commit` (FACT): commits GitHub lists for the
 *   PR, and the merge commit of a merged PR, when they exist locally.
 * - `issue RESOLVED_BY pull_request` (FACT, 1): GitHub records the merged PR as
 *   closing the issue (its closing issue references, fetched with a token) —
 *   unless the PR was reverted. When those references are known they replace
 *   the PR's closing keywords, which then count as mentions.
 * - `issue RESOLVED_BY pull_request|commit` (DERIVED, 0.9): a closing keyword
 *   (`Fixes #12`) in a merged PR or in a commit message — unless that change
 *   was reverted, or is itself a revert.
 * - `pull_request|commit REFERENCES issue|pull_request` (DERIVED, 1): any other
 *   mention of a number that is a synced issue or pull request.
 *
 * Issues of other repositories (`other/repo#12`) are linked the same way once
 * synced. References that match no synced record produce no link.
 */
export function linkGitHubReferences(
  db: FossilDb,
  repositoryId: number,
  slug: { readonly owner: string; readonly name: string },
  observedAt: string,
): LinkResult {
  return db.transaction((tx) => {
    for (const producer of [GITHUB_LINKER_PRODUCER, ...LEGACY_PRODUCERS]) {
      deleteRelationsByProducer(tx, repositoryId, producer);
    }
    const commits = listCommitMessages(tx, repositoryId);
    const lookups: Lookups = {
      ...externalIdsByNumber(tx, repositoryId),
      reverted: revertedShas(commits),
    };
    const evidence = commitEvidenceIds(tx, repositoryId);

    const drafts: Draft[] = [];
    for (const pullRequest of listPullRequests(tx, repositoryId, 'github')) {
      drafts.push(...pullRequestDrafts(tx, repositoryId, slug, pullRequest, lookups));
    }
    for (const commit of commits) {
      const text = `${commit.subject}\n${commit.body}`;
      const references = parseReferences(text, slug.owner, slug.name);
      const isRevert = /This reverts commit/i.test(text);
      const undone = isRevert || lookups.reverted.has(commit.sha);
      drafts.push(
        ...referenceDrafts(
          { type: 'commit', id: commit.id },
          references,
          lookups,
          !undone,
          evidence.get(commit.sha),
          undone ? { reverted: !isRevert, revert: isRevert } : undefined,
        ),
      );
    }
    return writeDrafts(tx, repositoryId, drafts, observedAt);
  });
}

function writeDrafts(
  db: FossilDb,
  repositoryId: number,
  drafts: readonly Draft[],
  observedAt: string,
): LinkResult {
  const result = { pullRequestCommits: 0, resolutions: 0, references: 0 };
  for (const { method, evidenceId, details, ...relation } of drafts) {
    recordRelation(db, {
      ...relation,
      repositoryId,
      provenance: {
        producer: GITHUB_LINKER_PRODUCER,
        method,
        evidenceIds: evidenceId === undefined ? [] : [evidenceId],
        observedAt,
        ...(details ? { details } : {}),
      },
    });
    if (relation.relation === 'IMPLEMENTED_BY') result.pullRequestCommits++;
    else if (relation.relation === 'RESOLVED_BY') result.resolutions++;
    else result.references++;
  }
  return result;
}

/** Full shas of commits that a later commit reverts. */
export function revertedShas(commits: readonly CommitMessage[]): Set<string> {
  const reverted = new Set<string>();
  for (const commit of commits) {
    for (const [, sha = ''] of commit.body.matchAll(REVERT_MARKER)) {
      const needle = sha.toLowerCase();
      const target = commits.find((c) => c.sha === needle || c.sha.startsWith(needle));
      if (target) reverted.add(target.sha);
    }
  }
  return reverted;
}

function pullRequestDrafts(
  db: FossilDb,
  repositoryId: number,
  slug: { readonly owner: string; readonly name: string },
  pullRequest: PullRequestRow,
  lookups: Lookups,
): Draft[] {
  const source = { type: 'pull_request', id: pullRequest.id } as const;
  const evidenceId = pullRequest.url
    ? findEvidenceId(db, repositoryId, 'pull_request', pullRequest.url)
    : undefined;
  const drafts: Draft[] = [];

  const shas = new Map(
    pullRequestCommitShas(db, pullRequest.id).map((sha) => [sha, 'pull-request-commits']),
  );
  // For open pull requests GitHub reports a *test* merge commit that never
  // lands in history, so the merge commit only counts once the PR is merged.
  if (pullRequest.mergedAt && pullRequest.mergeCommitSha) {
    shas.set(pullRequest.mergeCommitSha, shas.get(pullRequest.mergeCommitSha) ?? 'merge-commit');
  }
  for (const [sha, method] of shas) {
    const commit = findCommitBySha(db, repositoryId, sha);
    if (!commit) continue; // not in the indexed history (e.g. a squashed branch)
    drafts.push({
      source,
      relation: 'IMPLEMENTED_BY',
      target: { type: 'commit', id: commit.id },
      evidenceType: 'FACT',
      confidence: 1,
      method,
      evidenceId,
    });
  }

  const reverted =
    pullRequest.mergeCommitSha !== null && lookups.reverted.has(pullRequest.mergeCommitSha);
  const landed = pullRequest.mergedAt !== null && !reverted;
  const details = reverted ? { reverted: true } : undefined;
  const closing = closingRefDrafts(source, pullRequest, slug, lookups, landed, evidenceId, details);
  const references = parseReferences(
    `${pullRequest.title}\n${pullRequest.body}`,
    slug.owner,
    slug.name,
  )
    .filter((ref) => ref.repo !== null || String(ref.number) !== pullRequest.externalId)
    .filter((ref) => !closing.covered.has(referenceKey(ref)))
    // GitHub's own closing references, when known, decide what the PR closes.
    .map((ref) => (pullRequest.closingRefsJson === null ? ref : { ...ref, closing: false }));
  drafts.push(
    ...closing.drafts,
    ...referenceDrafts(source, references, lookups, landed, evidenceId, details),
  );
  return drafts;
}

const referenceKey = (ref: { readonly repo: string | null; readonly number: number }): string =>
  ref.repo === null ? `#${String(ref.number)}` : foreignReference(ref.repo, ref.number);

/** The issue a reference names, if it is synced. */
function issueFor(
  lookups: Lookups,
  ref: { readonly repo: string | null; readonly number: number },
): number | undefined {
  return ref.repo === null
    ? lookups.issues.get(ref.number)
    : lookups.foreignIssues.get(foreignReference(ref.repo, ref.number));
}

/**
 * Links from the issues GitHub records as closed by a pull request. They are
 * FACT: GitHub reports the link, nothing is read from text. A PR that did not
 * land (reverted) only references them.
 */
function closingRefDrafts(
  source: EntityRef,
  pullRequest: PullRequestRow,
  slug: { readonly owner: string; readonly name: string },
  lookups: Lookups,
  landed: boolean,
  evidenceId: number | undefined,
  details: Record<string, unknown> | undefined,
): { drafts: Draft[]; covered: Set<string> } {
  const self = `${slug.owner}/${slug.name}`.toLowerCase();
  const drafts: Draft[] = [];
  const covered = new Set<string>();
  for (const closing of pullRequest.closingRefsJson ?? []) {
    const ref = { repo: closing.repo === self ? null : closing.repo, number: closing.number };
    const issueId = issueFor(lookups, ref);
    if (issueId === undefined || covered.has(referenceKey(ref))) continue;
    covered.add(referenceKey(ref));
    const issue = { type: 'issue', id: issueId } as const;
    drafts.push(
      landed
        ? {
            source: issue,
            relation: 'RESOLVED_BY',
            target: source,
            evidenceType: 'FACT',
            confidence: 1,
            method: GITHUB_CLOSING_METHOD,
            evidenceId,
          }
        : {
            source,
            relation: 'REFERENCES',
            target: issue,
            evidenceType: 'FACT',
            confidence: 1,
            method: GITHUB_CLOSING_METHOD,
            evidenceId,
            ...(details ? { details } : {}),
          },
    );
  }
  return { drafts, covered };
}

/**
 * Turn text references into links. `landed` says whether the change the text
 * belongs to is in effect (merged, not reverted, not itself a revert), which a
 * closing keyword needs before it can be read as a resolution.
 */
function referenceDrafts(
  source: EntityRef,
  references: readonly TextReference[],
  lookups: Lookups,
  landed: boolean,
  evidenceId: number | undefined,
  details: Record<string, unknown> | undefined,
): Draft[] {
  return references.flatMap((reference): Draft[] => {
    const issueId = issueFor(lookups, reference);
    const extra = details ? { details } : {};
    if (issueId !== undefined && reference.closing && landed) {
      return [
        {
          source: { type: 'issue', id: issueId },
          relation: 'RESOLVED_BY',
          target: source,
          evidenceType: 'DERIVED',
          confidence: CLOSING_KEYWORD_CONFIDENCE,
          method: 'closing-keyword',
          evidenceId,
        },
      ];
    }
    // Pull requests of other repositories are not synced.
    const pullRequestId =
      reference.repo === null ? lookups.pullRequests.get(reference.number) : undefined;
    const target: EntityRef | null =
      issueId !== undefined
        ? { type: 'issue', id: issueId }
        : pullRequestId !== undefined
          ? { type: 'pull_request', id: pullRequestId }
          : null;
    if (!target) return [];
    return [
      {
        source,
        relation: 'REFERENCES',
        target,
        evidenceType: 'DERIVED',
        confidence: 1,
        method: 'text-mention',
        evidenceId,
        ...extra,
      },
    ];
  });
}
