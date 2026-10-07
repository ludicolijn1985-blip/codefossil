import { entityKey, findEvidenceId, type EntityRecord, type FossilDb } from '@codefossil/db';
import { issueReference, resolutionBasis, type EntityRef } from '@codefossil/shared';
import {
  commitContext,
  commitEvidence,
  describeCommit,
  linked,
  recordOf,
  type CommitRecord,
} from './context.js';
import { labelOf } from './describe.js';
import { weakestLevel } from './traverse.js';
import { fileLineage } from './lineage.js';
import {
  conclude,
  day,
  type Conclusion,
  type RelatedEntity,
  type Statement,
} from './statements.js';

export interface WhyInvestigation extends Conclusion {
  readonly kind: 'why';
  readonly question: string;
  readonly target: { readonly key: string; readonly label: string };
  readonly related: readonly RelatedEntity[];
  /** What the answer cannot say, and why. */
  readonly caveats: readonly string[];
}

interface Parts {
  statements: Statement[];
  related: RelatedEntity[];
  caveats: string[];
}

const NO_ORIGIN =
  'The indexed history does not show where it was introduced: it predates the indexed ' +
  'history or was added in a merge commit.';

/**
 * Answer "why does this exist?" from the evidence graph alone. Each sentence
 * is a statement with its own evidence and confidence; nothing is inferred
 * beyond what the stored relations say, and gaps are stated as gaps.
 */
export function investigateWhy(
  db: FossilDb,
  repositoryId: number,
  target: EntityRef,
  question?: string,
): WhyInvestigation {
  const record = recordOf(db, target);
  const label = record ? labelOf(record) : entityKey(target);
  const parts: Parts = { statements: [], related: [], caveats: [] };
  if (record) {
    switch (record.type) {
      case 'symbol':
        whySymbol(db, repositoryId, record, parts);
        break;
      case 'file':
        whyFile(db, repositoryId, record, parts);
        break;
      case 'commit':
        whyCommit(db, repositoryId, record, parts);
        break;
      case 'issue':
      case 'pull_request':
        whyWork(db, repositoryId, record, parts);
        break;
      case 'dependency':
        whyDependency(db, repositoryId, record, parts);
        break;
      default:
        parts.caveats.push(`Explaining a ${record.type} is not supported yet.`);
    }
  } else {
    parts.caveats.push('The entity no longer exists in the index.');
  }
  return {
    kind: 'why',
    question: question ?? `Why does ${label} exist?`,
    target: { key: entityKey(target), label },
    ...conclude(db, parts.statements),
    related: dedupe(parts.related),
    caveats: parts.caveats,
  };
}

function dedupe(related: readonly RelatedEntity[]): RelatedEntity[] {
  return [...new Map(related.map((r) => [r.key, r])).values()];
}

/** How often something changed after it appeared, from the given change dates. */
function historyStatement(
  subject: string,
  changes: readonly { commit: CommitRecord; evidenceIds: readonly number[] }[],
  level: Statement['level'],
): Statement {
  const latest = [...changes].sort((a, b) =>
    b.commit.committedAt.localeCompare(a.commit.committedAt),
  )[0];
  return {
    text: latest
      ? `${subject} changed ${changes.length} time${changes.length === 1 ? '' : 's'} since, most recently in ${describeCommit(latest.commit)}.`
      : `${subject} has not changed since.`,
    role: 'later changes',
    level,
    confidence: 1,
    evidenceIds: latest ? [...latest.evidenceIds] : [],
  };
}

/** Longest copy chain followed; real chains are a few moves long. */
const MAX_COPY_HOPS = 10;

type SymbolRecord = Extract<EntityRecord, { type: 'symbol' }>;

interface CopyHop {
  /** The copy. */
  readonly from: EntityRef;
  readonly row: ReturnType<typeof linked>[number]['row'];
  /** What it was copied from. */
  readonly source: SymbolRecord;
}

/** The `COPIED_FROM` links from a symbol back to code that was not itself copied. */
export function copyChain(
  db: FossilDb,
  repositoryId: number,
  start: EntityRef,
): { hops: CopyHop[]; origin: EntityRef } {
  const hops: CopyHop[] = [];
  const seen = new Set([start.id]);
  let current = start;
  while (hops.length < MAX_COPY_HOPS) {
    const link = linked(db, repositoryId, current, 'COPIED_FROM', 'out').find(
      (l) => l.record.type === 'symbol',
    );
    if (link?.record.type !== 'symbol' || seen.has(link.record.id)) break;
    hops.push({ from: current, row: link.row, source: link.record });
    seen.add(link.record.id);
    current = { type: 'symbol', id: link.record.id };
  }
  return { hops, origin: current };
}

/** The earliest commit recorded as changing a symbol: for a copy, the one that made it. */
function firstChange(db: FossilDb, repositoryId: number, ref: EntityRef): CommitRecord | null {
  const commits = linked(db, repositoryId, ref, 'MODIFIES', 'in').flatMap(({ record }) =>
    record.type === 'commit' ? [record] : [],
  );
  return commits.sort((a, b) => a.committedAt.localeCompare(b.committedAt))[0] ?? null;
}

function whySymbol(
  db: FossilDb,
  repositoryId: number,
  symbol: Extract<EntityRecord, { type: 'symbol' }>,
  parts: Parts,
): void {
  const ref = { type: 'symbol', id: symbol.id } as const;
  const containment = linked(db, repositoryId, ref, 'CONTAINS', 'in')[0];
  parts.statements.push({
    text: symbol.current
      ? `${symbol.kind} ${symbol.qualifiedName} is defined in ${symbol.path} at lines ${symbol.startLine}–${symbol.endLine}.`
      : `${symbol.kind} ${symbol.qualifiedName} no longer exists at HEAD; it was last seen in ${symbol.path}.`,
    role: 'definition',
    level: 'FACT',
    confidence: 1,
    evidenceIds: containment?.row.provenanceJson.evidenceIds ?? [],
  });

  // Copied or moved code was born elsewhere: follow the copies back to the original.
  const { hops, origin } = copyChain(db, repositoryId, ref);
  let copiedIn: CommitRecord | null = null;
  for (const [index, hop] of hops.entries()) {
    const copyCommit = firstChange(db, repositoryId, hop.from);
    if (index === 0) copiedIn = copyCommit;
    const evidenceId = copyCommit ? commitEvidence(db, repositoryId, copyCommit) : undefined;
    const { source } = hop;
    const subject = index === 0 ? 'It' : 'That';
    const from = `${source.kind} ${source.qualifiedName} in ${source.path}`;
    const when = copyCommit ? ` in ${describeCommit(copyCommit)}` : '';
    const method = hop.row.provenanceJson.method;
    parts.statements.push({
      text:
        method === 'renamed'
          ? `${subject} was renamed from ${from}${when}; the code is otherwise identical.`
          : method === 'moved-with-edits'
            ? `${subject} looks moved, with edits, from ${from}${when}: that definition left ` +
              'its file in the same commit (inferred from the name, not the content).'
            : `${subject} was copied, with identical content, from ${from}${when}.`,
      role: method === 'renamed' ? 'renamed from' : 'copied from',
      level: hop.row.evidenceType,
      confidence: hop.row.confidence,
      evidenceIds: [
        ...hop.row.provenanceJson.evidenceIds,
        ...(evidenceId === undefined ? [] : [evidenceId]),
      ],
    });
  }
  if (hops.length > 0) {
    parts.caveats.push('The change count covers the time since it took its current name and file.');
  }

  const introduction = linked(db, repositoryId, origin, 'INTRODUCED_BY', 'out').find(
    (l) => l.record.type === 'commit',
  );
  let introducedBy: CommitRecord | null = copiedIn;
  if (introduction?.record.type === 'commit') {
    const born = introduction.record;
    introducedBy ??= born;
    const evidenceId = commitEvidence(db, repositoryId, born);
    parts.statements.push({
      text: `${hops.length > 0 ? 'That code' : 'It'} was introduced in ${describeCommit(born)}.`,
      role: 'introducing commit',
      level: introduction.row.evidenceType,
      confidence: introduction.row.confidence,
      evidenceIds: [
        ...introduction.row.provenanceJson.evidenceIds,
        ...(evidenceId === undefined ? [] : [evidenceId]),
      ],
    });
    const context = commitContext(db, repositoryId, born, introduction.row);
    parts.statements.push(...context.statements);
    parts.related.push(...context.related);
  } else {
    parts.statements.push({
      text: NO_ORIGIN,
      role: 'absence of origin evidence',
      level: 'FACT',
      confidence: 1,
      evidenceIds: [],
    });
    parts.caveats.push('No introducing commit is recorded for this symbol.');
  }

  const changes = linked(db, repositoryId, ref, 'MODIFIES', 'in').flatMap(({ row, record }) =>
    record.type === 'commit' && record.id !== introducedBy?.id
      ? [{ commit: record, evidenceIds: row.provenanceJson.evidenceIds }]
      : [],
  );
  parts.statements.push(historyStatement('It', changes, 'DERIVED'));
}

function whyFile(
  db: FossilDb,
  repositoryId: number,
  file: Extract<EntityRecord, { type: 'file' }>,
  parts: Parts,
): void {
  parts.statements.push({
    text: file.deletedAt
      ? `${file.path} was deleted on ${day(file.deletedAt)}.`
      : `${file.path} exists at HEAD.`,
    role: 'current state',
    level: 'FACT',
    confidence: 1,
    evidenceIds: [],
  });

  const lineage = fileLineage(db, repositoryId, file.id);
  const commits = recordsOfCommits(
    db,
    lineage.entries.map((e) => e.commitId),
  );
  const [first, ...later] = lineage.entries;
  const firstCommit = first ? commits.get(first.commitId) : undefined;
  if (first && firstCommit && first.status === 'added') {
    const evidenceId = commitEvidence(db, repositoryId, firstCommit);
    const as = first.path === file.path ? '' : ` as ${first.path}`;
    parts.statements.push({
      text: `It was created${as} in ${describeCommit(firstCommit)}.`,
      role: 'creating commit',
      level: 'FACT',
      confidence: 1,
      evidenceIds: evidenceId === undefined ? [] : [evidenceId],
    });
    const context = commitContext(db, repositoryId, firstCommit, { confidence: 1 });
    parts.statements.push(...context.statements);
    parts.related.push(...context.related);
  } else {
    parts.statements.push({
      text: NO_ORIGIN,
      role: 'absence of origin evidence',
      level: 'FACT',
      confidence: 1,
      evidenceIds: [],
    });
    parts.caveats.push('The file already existed where the indexed history begins.');
  }

  for (const rename of later.filter((e) => e.status === 'renamed')) {
    const commit = commits.get(rename.commitId);
    if (!commit) continue;
    const evidenceId = commitEvidence(db, repositoryId, commit);
    parts.statements.push({
      text: `It was renamed from ${rename.previousPath ?? '?'} to ${rename.path} in ${describeCommit(commit)}.`,
      role: 'rename',
      level: 'FACT',
      confidence: 1,
      evidenceIds: evidenceId === undefined ? [] : [evidenceId],
    });
  }
  // A pure rename moves the file without changing it; it is reported above, not counted here.
  const contentChanges = later.filter(
    (e) => e.status !== 'renamed' || (e.additions ?? 1) + (e.deletions ?? 1) > 0,
  );
  const changes = contentChanges.flatMap((entry) => {
    const commit = commits.get(entry.commitId);
    const evidenceId = commit ? commitEvidence(db, repositoryId, commit) : undefined;
    return commit ? [{ commit, evidenceIds: evidenceId === undefined ? [] : [evidenceId] }] : [];
  });
  parts.statements.push(historyStatement('It', changes, 'FACT'));
}

function recordsOfCommits(db: FossilDb, ids: readonly number[]): Map<number, CommitRecord> {
  const out = new Map<number, CommitRecord>();
  for (const id of new Set(ids)) {
    const record = recordOf(db, { type: 'commit', id });
    if (record?.type === 'commit') out.set(id, record);
  }
  return out;
}

function whyCommit(db: FossilDb, repositoryId: number, commit: CommitRecord, parts: Parts): void {
  const evidenceId = commitEvidence(db, repositoryId, commit);
  parts.statements.push({
    text: `This is ${describeCommit(commit)}.`,
    role: 'the commit',
    level: 'FACT',
    confidence: 1,
    evidenceIds: evidenceId === undefined ? [] : [evidenceId],
  });
  const context = commitContext(db, repositoryId, commit, { confidence: 1 });
  parts.statements.push(...context.statements);
  parts.related.push(...context.related);
  if (context.statements.length === 0) {
    parts.caveats.push('No commit message body, pull request or issue explains this commit.');
  }
}

function whyWork(
  db: FossilDb,
  repositoryId: number,
  work: Extract<EntityRecord, { type: 'issue' | 'pull_request' }>,
  parts: Parts,
): void {
  const ref = { type: work.type, id: work.id } as const;
  const noun = work.type === 'issue' ? 'Issue' : 'Pull request';
  const workEvidence = work.url ? findEvidenceId(db, repositoryId, work.type, work.url) : undefined;
  parts.statements.push({
    text: `${noun} ${issueReference(work)} "${work.title}" is ${work.mergedAt ? 'merged' : work.state}.`,
    role: work.type === 'issue' ? 'the issue' : 'the pull request',
    level: 'FACT',
    confidence: 1,
    evidenceIds: workEvidence === undefined ? [] : [workEvidence],
  });
  if (work.type === 'issue') {
    for (const { row, record } of linked(db, repositoryId, ref, 'RESOLVED_BY', 'out')) {
      parts.statements.push({
        text: `It is resolved by ${labelOf(record)} (${resolutionBasis(row.provenanceJson.method, row.confidence)}).`,
        role: 'resolution',
        level: row.evidenceType,
        confidence: row.confidence,
        evidenceIds: row.provenanceJson.evidenceIds,
      });
    }
  } else {
    const commits = linked(db, repositoryId, ref, 'IMPLEMENTED_BY', 'out');
    if (commits.length > 0) {
      parts.statements.push({
        text: `It is implemented by ${commits.length} indexed commit${commits.length === 1 ? '' : 's'}: ${commits.map((c) => labelOf(c.record)).join('; ')}.`,
        role: 'implementing commits',
        // As strong as the weakest of the links it summarizes.
        level: weakestLevel(commits.map((c) => c.row.evidenceType)),
        confidence: Math.min(...commits.map((c) => c.row.confidence)),
        evidenceIds: commits.flatMap((c) => c.row.provenanceJson.evidenceIds),
      });
    }
    for (const { row, record } of linked(db, repositoryId, ref, 'RESOLVED_BY', 'in')) {
      parts.statements.push({
        text: `It resolves ${labelOf(record)} (${resolutionBasis(row.provenanceJson.method, row.confidence)}).`,
        role: 'resolved issue',
        level: row.evidenceType,
        confidence: row.confidence,
        evidenceIds: row.provenanceJson.evidenceIds,
      });
    }
  }
  for (const { record } of linked(db, repositoryId, ref, 'REFERENCES', 'in')) {
    parts.related.push({ key: entityKey(record), label: labelOf(record), relation: 'mentions it' });
  }
}

function whyDependency(
  db: FossilDb,
  repositoryId: number,
  dependency: Extract<EntityRecord, { type: 'dependency' }>,
  parts: Parts,
): void {
  const ref = { type: 'dependency', id: dependency.id } as const;
  const declaration = linked(db, repositoryId, ref, 'DEPENDS_ON', 'in');
  const manifest = declaration.find((d) => d.record.type === 'repository');
  parts.statements.push({
    text: `${labelOf(dependency)} is declared as a ${dependency.scope} dependency.`,
    role: 'manifest declaration',
    level: 'FACT',
    confidence: 1,
    evidenceIds: manifest?.row.provenanceJson.evidenceIds ?? [],
  });
  const users = declaration.filter((d) => d.record.type === 'file');
  parts.statements.push({
    text:
      users.length > 0
        ? `${users.length} file${users.length === 1 ? ' imports' : 's import'} it: ${users
            .map((u) => labelOf(u.record))
            .slice(0, 5)
            .join(', ')}${users.length > 5 ? ', …' : ''}.`
        : 'No file in the repository imports it (it may be a tool, a type package or unused).',
    role: 'usage',
    level: 'DERIVED',
    confidence: 1,
    evidenceIds: users.flatMap((u) => u.row.provenanceJson.evidenceIds),
  });
  parts.caveats.push(
    'When the dependency was added is not tracked: dependency history is not indexed yet.',
  );
}
