import {
  analysisChanges,
  analysisCommits,
  analysisFiles,
  commitDiscussions,
  commitEvidenceIds,
  runtimeEvidence,
  symbolChangeCommits,
  symbolsChangedIn,
  type AnalysisCommit,
  type CommitDiscussion,
  type FossilDb,
} from '@codefossil/db';
import { formatVersion, RUNTIMES, type Runtime, type Version } from '@codefossil/graph';
import { grammarForPath } from '@codefossil/parser';
import { isTestPath } from '@codefossil/query';
import type { EvidenceLevel } from '@codefossil/shared';
import {
  deadlines,
  isBelowMinimum,
  versionReferences,
  workaroundLanguage,
  type WorkaroundMatch,
} from './text-signals.js';
import { isCodePath } from './hotspots.js';

export type DeadIntentSignalKind =
  'workaround_language' | 'unsupported_version' | 'deadline_passed' | 'unconfirmed';

export interface DeadIntentSignal {
  readonly kind: DeadIntentSignalKind;
  readonly text: string;
  readonly level: EvidenceLevel;
  readonly evidenceIds: readonly number[];
}

export interface DeadIntentCandidate {
  readonly target: {
    readonly key: string;
    readonly kind: 'symbol' | 'file';
    readonly label: string;
    readonly path: string;
    readonly line: number | null;
  };
  /** Commits with workaround language that changed the target, oldest first. */
  readonly commits: readonly {
    readonly sha: string;
    readonly subject: string;
    readonly committedAt: string;
  }[];
  readonly signals: readonly DeadIntentSignal[];
  /** A candidate is always an inference: it points at code worth re-examining, nothing more. */
  readonly classification: 'INFERRED';
  readonly confidence: number;
  readonly evidenceIds: readonly number[];
}

export interface DeclaredRuntime {
  readonly runtime: Runtime;
  readonly constraint: string;
  readonly minimum: string | null;
  readonly manifest: string;
  readonly evidenceId: number;
}

export interface DeadIntentReport {
  readonly candidates: readonly DeadIntentCandidate[];
  readonly runtimes: readonly DeclaredRuntime[];
  readonly notes: readonly string[];
}

export interface DeadIntentOptions {
  readonly now?: Date;
  readonly limit?: number;
  /** Days without change after which nothing recent confirms the code is still needed. */
  readonly staleDays?: number;
}

export const DEFAULT_DEAD_INTENT_LIMIT = 50;
/** Files a commit may change for its subject's wording to be attributed to each of them. */
export const BROAD_COMMIT_FILES = 20;
/** Files a commit may change for one line of its body to be attributed to each of them. */
export const FOCUSED_COMMIT_FILES = 3;
/** Changes after the workaround commit after which the code counts as reworked. */
export const REWORKED_AFTER = 3;

/** Examples, docs, fixtures and benchmarks illustrate code; they are not where workarounds live. */
const NOT_PRODUCT_CODE =
  /(^|\/)(examples?|samples?|demos?|docs?|fixtures?|benchmarks?|__mocks__)\//i;

const IMPORT_BINDING = /^[^=]*=\s*(?:await\s+)?(?:require|import)\s*\(/;

const isTargetPath = (path: string) =>
  isCodePath(path) && !isTestPath(path) && !NOT_PRODUCT_CODE.test(path);
export const DEFAULT_STALE_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Confidence added by each signal; capped well below certainty. */
export const DEAD_INTENT_CONFIDENCE = {
  workaround_language: 0.3,
  unsupported_version: 0.25,
  deadline_passed: 0.2,
  unconfirmed: 0.1,
  max: 0.8,
} as const;

interface Source {
  readonly text: string;
  readonly where: string;
  readonly evidenceIds: readonly number[];
}

interface Minimum {
  readonly version: Version;
  readonly declared: DeclaredRuntime;
}

/**
 * Find code that may exist only for a reason that has since gone away. A
 * candidate needs workaround or compatibility wording in a commit (or its
 * linked issue or pull request) that changed the code; unsupported version
 * references, passed deadlines and long silence make it stronger. It is never
 * more than a candidate.
 */
export function analyzeDeadIntent(
  db: FossilDb,
  repositoryId: number,
  options: DeadIntentOptions = {},
): DeadIntentReport {
  const now = options.now ?? new Date();
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const commits = analysisCommits(db, repositoryId);
  const commitEvidence = commitEvidenceIds(db, repositoryId);
  const discussionsByCommit = groupBy(commitDiscussions(db, repositoryId), (d) => d.commitId);
  const runtimes = declaredRuntimes(db, repositoryId);
  const minimums = lowestMinimums(runtimes);

  const changes = analysisChanges(db, repositoryId);
  const breadth = new Map<number, number>();
  for (const change of changes)
    breadth.set(change.commitId, (breadth.get(change.commitId) ?? 0) + 1);

  // Commits whose own words, or whose linked discussion's words, speak of a workaround.
  // The wording must be attributable to what the commit changed: a subject or
  // title covers a commit of modest size, a line in the body only a focused one.
  const flagged = new Map<
    number,
    { commit: AnalysisCommit; sources: Source[]; language: WorkaroundMatch & Source }
  >();
  for (const commit of commits) {
    const own = commitEvidence.get(commit.sha);
    const sources: Source[] = [
      {
        text: `${commit.subject}\n${commit.body}`,
        where: `commit ${commit.sha.slice(0, 7)}`,
        evidenceIds: own === undefined ? [] : [own],
      },
      ...(discussionsByCommit.get(commit.id) ?? []).map((d) => discussionSource(d)),
    ];
    for (const source of sources) {
      const match = workaroundLanguage(source.text);
      const files = breadth.get(commit.id) ?? 0;
      if (match && files <= (match.inFirstLine ? BROAD_COMMIT_FILES : FOCUSED_COMMIT_FILES)) {
        flagged.set(commit.id, { commit, sources, language: { ...match, ...source } });
        break;
      }
    }
  }

  const files = new Map(analysisFiles(db, repositoryId).map((f) => [f.id, f]));
  const commitDate = new Map(commits.map((c) => [c.id, c.committedAt]));
  const changedSymbols = symbolsChangedIn(db, [...flagged.keys()]);
  const symbolFilesByCommit = groupBy(changedSymbols, (s) => s.commitId);

  // Targets: current symbols a flagged commit changed; files when it changed no symbol in them.
  const targets = new Map<
    string,
    { target: DeadIntentCandidate['target']; commitIds: Set<number>; symbolId: number | null }
  >();
  const addTarget = (
    key: string,
    target: DeadIntentCandidate['target'],
    commitId: number,
    symbolId: number | null,
  ) => {
    const existing = targets.get(key) ?? { target, commitIds: new Set<number>(), symbolId };
    existing.commitIds.add(commitId);
    targets.set(key, existing);
  };
  for (const symbol of changedSymbols) {
    const file = files.get(symbol.fileId);
    if (!symbol.current || !file || file.deletedAt !== null || !isTargetPath(file.path)) continue;
    // An import line (`const x = require('y')`) is plumbing, not where a workaround lives.
    if (IMPORT_BINDING.test(symbol.signature ?? '')) continue;
    addTarget(
      `symbol:${symbol.symbolId}`,
      {
        key: `symbol:${symbol.symbolId}`,
        kind: 'symbol',
        label: `${symbol.kind} ${symbol.qualifiedName} (${file.path}:${symbol.startLine})`,
        path: file.path,
        line: symbol.startLine,
      },
      symbol.commitId,
      symbol.symbolId,
    );
  }
  for (const change of changes) {
    if (!flagged.has(change.commitId) || change.status === 'deleted') continue;
    const file = files.get(change.fileId);
    // A file whose language is parsed is a target through its symbols only.
    if (!file || file.deletedAt !== null || !isTargetPath(file.path) || grammarForPath(file.path))
      continue;
    const withSymbols = (symbolFilesByCommit.get(change.commitId) ?? []).some(
      (s) => s.fileId === file.id,
    );
    if (withSymbols) continue;
    addTarget(
      `file:${file.id}`,
      { key: `file:${file.id}`, kind: 'file', label: file.path, path: file.path, line: null },
      change.commitId,
      null,
    );
  }

  // When each target last changed: symbol versions for symbols, file changes for files.
  const symbolCommits = symbolChangeCommits(
    db,
    [...targets.values()].flatMap((t) => (t.symbolId === null ? [] : [t.symbolId])),
  );
  const fileCommits = groupBy(changes, (c) => c.fileId);
  /** Dates of every recorded change to the target, oldest first. */
  const changeDates = (entry: {
    target: DeadIntentCandidate['target'];
    symbolId: number | null;
  }) => {
    const ids =
      entry.symbolId !== null
        ? (symbolCommits.get(entry.symbolId) ?? [])
        : (fileCommits.get(Number(entry.target.key.slice('file:'.length))) ?? []).map(
            (c) => c.commitId,
          );
    return ids.map((id) => commitDate.get(id) ?? '').sort();
  };

  const candidates = [...targets.values()].flatMap((entry): DeadIntentCandidate[] => {
    const dates = changeDates(entry);
    const latestFlagged = [...entry.commitIds]
      .map((id) => commitDate.get(id) ?? '')
      .sort()
      .at(-1);
    // Code reworked several times since the wording no longer carries it reliably.
    if (latestFlagged && dates.filter((date) => date > latestFlagged).length >= REWORKED_AFTER) {
      return [];
    }
    return [candidateFor(entry, dates.at(-1) ?? null)];
  });

  function candidateFor(
    entry: { target: DeadIntentCandidate['target']; commitIds: Set<number> },
    last: string | null,
  ): DeadIntentCandidate {
    const reasons = [...entry.commitIds]
      .flatMap((id) => {
        const found = flagged.get(id);
        return found ? [found] : [];
      })
      .sort((a, b) => a.commit.committedAt.localeCompare(b.commit.committedAt));
    const signals: DeadIntentSignal[] = [];
    for (const { language, sources } of reasons) {
      signals.push({
        kind: 'workaround_language',
        text: `${language.where} says "${language.phrase}": ${language.excerpt}`,
        level: 'INFERRED',
        evidenceIds: language.evidenceIds,
      });
      signals.push(...versionSignals(sources, minimums), ...deadlineSignals(sources, now));
    }
    if (last && now.getTime() - Date.parse(last) >= staleDays * DAY_MS) {
      const days = Math.floor((now.getTime() - Date.parse(last)) / DAY_MS);
      signals.push({
        kind: 'unconfirmed',
        text: `Unchanged since ${last.slice(0, 10)} (${days} days); no later change confirms it is still needed.`,
        level: 'DERIVED',
        evidenceIds: [],
      });
    }
    const unique = dedupe(signals);
    const kinds = new Set(unique.map((s) => s.kind));
    const confidence = Math.min(
      DEAD_INTENT_CONFIDENCE.max,
      [...kinds].reduce((sum, kind) => sum + DEAD_INTENT_CONFIDENCE[kind], 0),
    );
    return {
      target: entry.target,
      commits: reasons.map(({ commit }) => ({
        sha: commit.sha,
        subject: commit.subject,
        committedAt: commit.committedAt,
      })),
      signals: unique,
      classification: 'INFERRED',
      confidence: Math.round(confidence * 100) / 100,
      evidenceIds: [...new Set(unique.flatMap((s) => s.evidenceIds))],
    };
  }

  candidates.sort(
    (a, b) =>
      b.confidence - a.confidence ||
      (a.commits[0]?.committedAt ?? '').localeCompare(b.commits[0]?.committedAt ?? '') ||
      a.target.label.localeCompare(b.target.label),
  );

  return {
    candidates: candidates.slice(0, options.limit ?? DEFAULT_DEAD_INTENT_LIMIT),
    runtimes,
    notes: [
      'Candidates are inferences from wording in commits, issues and pull requests; each needs a human look before anything is removed.',
      runtimes.length > 0
        ? 'Version references are compared with the runtime support the manifests declare at HEAD.'
        : 'No manifest declares runtime support (engines.node, requires-python, go, rust-version), so version references are not compared.',
      `"Unconfirmed" means unchanged for at least ${staleDays} days.`,
    ],
  };
}

function discussionSource(discussion: CommitDiscussion): Source {
  const kind = discussion.type === 'issue' ? 'issue' : 'pull request';
  return {
    text: `${discussion.title}\n${discussion.body}`,
    where: `${kind} #${discussion.number}`,
    evidenceIds: discussion.evidenceIds,
  };
}

function versionSignals(
  sources: readonly Source[],
  minimums: ReadonlyMap<Runtime, Minimum>,
): DeadIntentSignal[] {
  return sources.flatMap((source) =>
    versionReferences(source.text).flatMap((reference): DeadIntentSignal[] => {
      const minimum = minimums.get(reference.runtime);
      if (!minimum || !isBelowMinimum(reference, minimum.version)) return [];
      const { declared } = minimum;
      return [
        {
          kind: 'unsupported_version',
          text: `${source.where} mentions ${reference.phrase.trim()}; ${declared.manifest} declares ${declared.runtime} ${declared.constraint}.`,
          level: 'DERIVED',
          evidenceIds: [...source.evidenceIds, declared.evidenceId],
        },
      ];
    }),
  );
}

function deadlineSignals(sources: readonly Source[], now: Date): DeadIntentSignal[] {
  const today = now.toISOString().slice(0, 10);
  return sources.flatMap((source) =>
    deadlines(source.text)
      .filter((deadline) => deadline.date < today)
      .map((deadline) => ({
        kind: 'deadline_passed' as const,
        text: `${source.where} sets "${deadline.phrase}", which ended ${deadline.date}: ${deadline.excerpt}`,
        level: 'DERIVED' as const,
        evidenceIds: source.evidenceIds,
      })),
  );
}

function declaredRuntimes(db: FossilDb, repositoryId: number): DeclaredRuntime[] {
  return runtimeEvidence(db, repositoryId).flatMap((row): DeclaredRuntime[] => {
    const meta = row.metadata ?? {};
    const runtime = RUNTIMES.find((r) => r === meta.runtime);
    const minimum = meta.minimum as Version | null | undefined;
    if (!runtime || typeof meta.constraint !== 'string') return [];
    return [
      {
        runtime,
        constraint: meta.constraint,
        minimum: minimum ? formatVersion(minimum, runtime) : null,
        manifest: row.locator.split('@')[0] ?? row.locator,
        evidenceId: row.evidenceId,
      },
    ];
  });
}

/** With several manifests (a monorepo), the lowest declared minimum is what the project still supports. */
function lowestMinimums(runtimes: readonly DeclaredRuntime[]): Map<Runtime, Minimum> {
  const result = new Map<Runtime, Minimum>();
  for (const declared of runtimes) {
    if (declared.minimum === null) continue;
    const [major = 0, minor = 0] = declared.minimum.split('.').map(Number);
    const version = { major, minor };
    const current = result.get(declared.runtime);
    if (
      !current ||
      major < current.version.major ||
      (major === current.version.major && minor < current.version.minor)
    ) {
      result.set(declared.runtime, { version, declared });
    }
  }
  return result;
}

function dedupe(signals: readonly DeadIntentSignal[]): DeadIntentSignal[] {
  const seen = new Set<string>();
  return signals.filter((signal) => {
    const key = `${signal.kind}:${signal.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const result = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const group = result.get(k);
    if (group) group.push(item);
    else result.set(k, [item]);
  }
  return result;
}
