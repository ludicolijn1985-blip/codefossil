import { count, desc, eq, isNull, and } from 'drizzle-orm';
import { EVIDENCE_LEVELS, type EvidenceLevel } from '@codefossil/shared';
import type { FossilDb } from './client.js';
import { commits, evidence, fileChanges, files, relations, repositories } from './schema.js';

export interface IndexStatus {
  readonly repository: {
    readonly id: number;
    readonly name: string;
    readonly path: string;
    readonly defaultBranch: string | null;
    readonly remoteUrl: string | null;
    readonly indexedAt: string | null;
  };
  readonly counts: {
    readonly commits: number;
    readonly files: number;
    readonly currentFiles: number;
    readonly fileChanges: number;
    readonly evidence: number;
    readonly relations: Readonly<Record<EvidenceLevel, number>>;
  };
  readonly latestCommit: { readonly sha: string; readonly committedAt: string } | null;
}

/** Counts and freshness of a repository's index. Returns undefined for an unknown repository. */
export function getIndexStatus(db: FossilDb, repositoryId: number): IndexStatus | undefined {
  const repository = db
    .select({
      id: repositories.id,
      name: repositories.name,
      path: repositories.path,
      defaultBranch: repositories.defaultBranch,
      remoteUrl: repositories.remoteUrl,
      indexedAt: repositories.indexedAt,
    })
    .from(repositories)
    .where(eq(repositories.id, repositoryId))
    .get();
  if (!repository) return undefined;

  const countOf = (rows: { value: number }[]) => rows[0]?.value ?? 0;
  const inRepo = eq(files.repositoryId, repositoryId);

  const relationCounts = Object.fromEntries(EVIDENCE_LEVELS.map((level) => [level, 0])) as Record<
    EvidenceLevel,
    number
  >;
  for (const row of db
    .select({ level: relations.evidenceType, value: count() })
    .from(relations)
    .where(eq(relations.repositoryId, repositoryId))
    .groupBy(relations.evidenceType)
    .all()) {
    relationCounts[row.level] = row.value;
  }

  const latestCommit =
    db
      .select({ sha: commits.sha, committedAt: commits.committedAt })
      .from(commits)
      .where(eq(commits.repositoryId, repositoryId))
      .orderBy(desc(commits.committedAt), desc(commits.id))
      .limit(1)
      .get() ?? null;

  return {
    repository,
    counts: {
      commits: countOf(
        db
          .select({ value: count() })
          .from(commits)
          .where(eq(commits.repositoryId, repositoryId))
          .all(),
      ),
      files: countOf(db.select({ value: count() }).from(files).where(inRepo).all()),
      currentFiles: countOf(
        db
          .select({ value: count() })
          .from(files)
          .where(and(inRepo, isNull(files.deletedAt)))
          .all(),
      ),
      fileChanges: countOf(
        db
          .select({ value: count() })
          .from(fileChanges)
          .innerJoin(files, eq(fileChanges.fileId, files.id))
          .where(inRepo)
          .all(),
      ),
      evidence: countOf(
        db
          .select({ value: count() })
          .from(evidence)
          .where(eq(evidence.repositoryId, repositoryId))
          .all(),
      ),
      relations: relationCounts,
    },
    latestCommit,
  };
}
