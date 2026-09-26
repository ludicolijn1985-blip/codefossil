import { and, asc, count, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { EvidenceKind } from '@codefossil/shared';
import type { FossilDb } from './client.js';
import { dependencies, evidence, files, imports, relations, repositories } from './schema.js';

export type ImportRow = typeof imports.$inferSelect;
export type DependencyRow = typeof dependencies.$inferSelect;
type FileRow = typeof files.$inferSelect;

/**
 * The file row for a path present at HEAD, created without history when the
 * indexed history never touched it (e.g. it predates a `--since` window).
 */
export function ensureFile(
  db: FossilDb,
  repositoryId: number,
  path: string,
  language: string | null,
): FileRow {
  return db
    .insert(files)
    .values({ repositoryId, path, language })
    .onConflictDoUpdate({ target: [files.repositoryId, files.path], set: { path } })
    .returning()
    .get();
}

export interface NewImport {
  readonly specifier: string;
  readonly kind: ImportRow['kind'];
  readonly line: number;
  readonly names?: readonly string[] | undefined;
}

/**
 * Replace the imports recorded for a file with those observed in `sha`,
 * together with the evidence rows that back them.
 */
export function replaceFileImports(
  db: FossilDb,
  repositoryId: number,
  file: { readonly id: number; readonly path: string },
  sha: string,
  found: readonly NewImport[],
): void {
  deleteFileImports(db, file.id);
  for (const item of found) {
    const record = db
      .insert(evidence)
      .values({
        repositoryId,
        type: 'ast_node',
        locator: `${file.path}@${sha}#L${item.line}`,
        excerpt: `${item.kind} ${item.specifier}`,
        metadataJson: { snapshot: 'imports' },
      })
      .returning({ id: evidence.id })
      .get();
    db.insert(imports)
      .values({
        fileId: file.id,
        specifier: item.specifier,
        kind: item.kind,
        line: item.line,
        namesJson: item.names ? [...item.names] : null,
        evidenceId: record.id,
      })
      .run();
  }
}

/** Remove a file's import snapshot and its evidence. */
export function deleteFileImports(db: FossilDb, fileId: number): void {
  const evidenceIds = db
    .select({ id: imports.evidenceId })
    .from(imports)
    .where(eq(imports.fileId, fileId))
    .all()
    .flatMap((row) => (row.id === null ? [] : [row.id]));
  db.delete(imports).where(eq(imports.fileId, fileId)).run();
  if (evidenceIds.length > 0) db.delete(evidence).where(inArray(evidence.id, evidenceIds)).run();
}

export interface RepositoryImport {
  readonly id: number;
  readonly fileId: number;
  readonly path: string;
  readonly specifier: string;
  readonly kind: ImportRow['kind'];
  readonly names: string[] | null;
  readonly evidenceId: number | null;
}

/** Every import of every file that exists at HEAD. */
export function listRepositoryImports(db: FossilDb, repositoryId: number): RepositoryImport[] {
  return db
    .select({
      id: imports.id,
      fileId: files.id,
      path: files.path,
      specifier: imports.specifier,
      kind: imports.kind,
      names: imports.namesJson,
      evidenceId: imports.evidenceId,
    })
    .from(imports)
    .innerJoin(files, eq(imports.fileId, files.id))
    .where(and(eq(files.repositoryId, repositoryId), isNull(files.deletedAt)))
    .orderBy(asc(files.path), asc(imports.line))
    .all();
}

export function setImportResolution(
  db: FossilDb,
  importId: number,
  resolution: NonNullable<ImportRow['resolution']>,
  detail: string | null,
): void {
  db.update(imports)
    .set({ resolution, resolutionDetail: detail })
    .where(eq(imports.id, importId))
    .run();
}

/** Imports of one file, in source order, with how each was resolved. */
export function fileImports(db: FossilDb, fileId: number): ImportRow[] {
  return db
    .select()
    .from(imports)
    .where(eq(imports.fileId, fileId))
    .orderBy(asc(imports.line))
    .all();
}

/** Delete relations one producer derived, so a snapshot can be rebuilt. */
export function deleteRelationsByProducer(
  db: FossilDb,
  repositoryId: number,
  producer: string,
): number {
  return db
    .delete(relations)
    .where(
      and(
        eq(relations.repositoryId, repositoryId),
        sql`json_extract(${relations.provenanceJson}, '$.producer') = ${producer}`,
      ),
    )
    .run().changes;
}

export function deleteEvidenceOfType(db: FossilDb, repositoryId: number, type: EvidenceKind): void {
  db.delete(evidence)
    .where(and(eq(evidence.repositoryId, repositoryId), eq(evidence.type, type)))
    .run();
}

export interface NewDependency {
  readonly repositoryId: number;
  readonly manifestFile: string;
  readonly ecosystem: string;
  readonly name: string;
  readonly version: string | null;
  readonly scope: DependencyRow['scope'];
  readonly internal: boolean;
}

/** Mark all dependencies stale before re-reading manifests; upserts revive current ones. */
export function markDependenciesStale(db: FossilDb, repositoryId: number): void {
  db.update(dependencies)
    .set({ current: false })
    .where(eq(dependencies.repositoryId, repositoryId))
    .run();
}

export function upsertDependency(db: FossilDb, dependency: NewDependency): DependencyRow {
  return db
    .insert(dependencies)
    .values({ ...dependency, current: true })
    .onConflictDoUpdate({
      target: [
        dependencies.repositoryId,
        dependencies.manifestFile,
        dependencies.ecosystem,
        dependencies.name,
      ],
      set: {
        version: dependency.version,
        scope: dependency.scope,
        internal: dependency.internal,
        current: true,
      },
    })
    .returning()
    .get();
}

export function findDependency(
  db: FossilDb,
  repositoryId: number,
  manifestFile: string,
  ecosystem: string,
  name: string,
): DependencyRow | undefined {
  return db
    .select()
    .from(dependencies)
    .where(
      and(
        eq(dependencies.repositoryId, repositoryId),
        eq(dependencies.manifestFile, manifestFile),
        eq(dependencies.ecosystem, ecosystem),
        eq(dependencies.name, name),
      ),
    )
    .get();
}

export interface DependencyUsage extends DependencyRow {
  /** Files whose imports resolve to this dependency. */
  readonly usedBy: number;
}

/** Current dependencies with how many files import each. */
export function listDependencies(db: FossilDb, repositoryId: number): DependencyUsage[] {
  const usage = new Map(
    db
      .select({ id: relations.targetId, value: count() })
      .from(relations)
      .where(
        and(
          eq(relations.repositoryId, repositoryId),
          eq(relations.relation, 'DEPENDS_ON'),
          eq(relations.sourceType, 'file'),
          eq(relations.targetType, 'dependency'),
        ),
      )
      .groupBy(relations.targetId)
      .all()
      .map((row) => [row.id, row.value]),
  );
  return db
    .select()
    .from(dependencies)
    .where(and(eq(dependencies.repositoryId, repositoryId), eq(dependencies.current, true)))
    .orderBy(asc(dependencies.manifestFile), asc(dependencies.ecosystem), asc(dependencies.name))
    .all()
    .map((row) => ({ ...row, usedBy: usage.get(row.id) ?? 0 }));
}

export interface ImportingFile {
  readonly path: string;
  readonly confidence: number;
}

/** Files at HEAD whose imports resolve to `fileId`. */
export function importedBy(db: FossilDb, repositoryId: number, fileId: number): ImportingFile[] {
  return db
    .select({ path: files.path, confidence: relations.confidence })
    .from(relations)
    .innerJoin(files, eq(relations.sourceId, files.id))
    .where(
      and(
        eq(relations.repositoryId, repositoryId),
        eq(relations.relation, 'IMPORTS'),
        eq(relations.sourceType, 'file'),
        eq(relations.targetType, 'file'),
        eq(relations.targetId, fileId),
      ),
    )
    .orderBy(asc(files.path))
    .all();
}

export function getGraphIndexedSha(db: FossilDb, repositoryId: number): string | null {
  return (
    db
      .select({ sha: repositories.graphIndexedSha })
      .from(repositories)
      .where(eq(repositories.id, repositoryId))
      .get()?.sha ?? null
  );
}

export function setGraphIndexedSha(db: FossilDb, repositoryId: number, sha: string): void {
  db.update(repositories)
    .set({ graphIndexedSha: sha })
    .where(eq(repositories.id, repositoryId))
    .run();
}
