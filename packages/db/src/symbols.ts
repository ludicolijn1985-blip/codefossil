import { and, asc, count, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { SymbolKind } from '@codefossil/shared';
import type { FossilDb } from './client.js';
import { preparedFor } from './prepared.js';
import { commits, fileChanges, files, relations, symbols, symbolVersions } from './schema.js';

export type SymbolRow = typeof symbols.$inferSelect;

export type SymbolState = {
  readonly fileId: number;
  readonly stableKey: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: SymbolKind;
  readonly signature: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly contentHash: string;
};

export interface SymbolUpsert {
  readonly row: SymbolRow;
  /** True when no symbol with this key existed in the file. */
  readonly created: boolean;
  /** True when the content differs from the previously stored version (always true when created). */
  readonly changed: boolean;
}

/** Create or update a symbol and mark it current. Reports whether its content changed. */
export function upsertSymbol(db: FossilDb, state: SymbolState): SymbolUpsert {
  const s = statements(db);
  const existing = s.findSymbol.get({ fileId: state.fileId, stableKey: state.stableKey });
  if (!existing) {
    return { row: s.insertSymbol.get(state), created: true, changed: true };
  }
  const row = s.updateSymbol.get({ ...state, id: existing.id });
  return { row, created: false, changed: existing.contentHash !== state.contentHash };
}

export function insertSymbolVersion(
  db: FossilDb,
  version: { symbolId: number; commitId: number; contentHash: string; signature: string },
): void {
  statements(db).insertVersion.run(version);
}

/** Mark exactly the symbols of a file whose keys are in `currentKeys` as current. */
export function setCurrentSymbols(
  db: FossilDb,
  fileId: number,
  currentKeys: ReadonlySet<string>,
): void {
  const s = statements(db);
  for (const symbol of s.listFileSymbolKeys.all({ fileId })) {
    const current = currentKeys.has(symbol.stableKey);
    if (current !== symbol.current) s.setCurrent.run({ id: symbol.id, current: current ? 1 : 0 });
  }
}

/**
 * Move a file's symbols to the file it was renamed to, so their history
 * survives the rename. Does nothing if the destination already has symbols.
 */
export function moveSymbols(db: FossilDb, fromFileId: number, toFileId: number): number {
  const s = statements(db);
  if (s.anySymbol.get({ fileId: toFileId })) return 0;
  return s.moveSymbols.run({ fromFileId, toFileId }).changes;
}

export interface PendingSymbolChange {
  readonly fileChangeId: number;
  readonly commitId: number;
  readonly sha: string;
  readonly committedAt: string;
  readonly fileId: number;
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly previousPath: string | null;
}

/** File changes whose symbols have not been extracted yet, oldest commit first. */
export function pendingSymbolChanges(db: FossilDb, repositoryId: number): PendingSymbolChange[] {
  return db
    .select({
      fileChangeId: fileChanges.id,
      commitId: commits.id,
      sha: commits.sha,
      committedAt: commits.committedAt,
      fileId: files.id,
      path: files.path,
      status: fileChanges.status,
      previousPath: fileChanges.previousPath,
    })
    .from(fileChanges)
    .innerJoin(commits, eq(fileChanges.commitId, commits.id))
    .innerJoin(files, eq(fileChanges.fileId, files.id))
    .where(and(eq(files.repositoryId, repositoryId), isNull(fileChanges.symbolsIndexedAt)))
    .orderBy(asc(commits.committedAt), asc(commits.id), asc(fileChanges.id))
    .all();
}

export function markSymbolsIndexed(db: FossilDb, fileChangeId: number, at: string): void {
  statements(db).markIndexed.run({ id: fileChangeId, at });
}

/** Whether symbols were already extracted from an earlier version of this file. */
export function hasIndexedVersion(db: FossilDb, fileId: number): boolean {
  return statements(db).anyIndexedChange.get({ fileId }) !== undefined;
}

export interface FileSymbol {
  readonly id: number;
  readonly stableKey: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: string;
  readonly signature: string | null;
  readonly startLine: number;
  readonly endLine: number;
  readonly versions: number;
  /** The commit that introduced the symbol, when the evidence establishes it. */
  readonly introducedBy: {
    readonly sha: string;
    readonly committedAt: string;
    readonly subject: string;
  } | null;
}

/** Current symbols of a file in source order, with their origin. */
export function listFileSymbols(db: FossilDb, fileId: number): FileSymbol[] {
  const rows = db
    .select({
      id: symbols.id,
      stableKey: symbols.stableKey,
      name: symbols.name,
      qualifiedName: symbols.qualifiedName,
      kind: symbols.kind,
      signature: symbols.signature,
      startLine: symbols.startLine,
      endLine: symbols.endLine,
    })
    .from(symbols)
    .where(and(eq(symbols.fileId, fileId), eq(symbols.current, true)))
    .orderBy(asc(symbols.startLine), asc(symbols.id))
    .all();

  return rows.map((row) => {
    const versions =
      db
        .select({ value: count() })
        .from(symbolVersions)
        .where(eq(symbolVersions.symbolId, row.id))
        .get()?.value ?? 0;
    const introducedBy =
      db
        .select({ sha: commits.sha, committedAt: commits.committedAt, subject: commits.subject })
        .from(relations)
        .innerJoin(commits, eq(relations.targetId, commits.id))
        .where(
          and(
            eq(relations.sourceType, 'symbol'),
            eq(relations.sourceId, row.id),
            eq(relations.relation, 'INTRODUCED_BY'),
            eq(relations.targetType, 'commit'),
          ),
        )
        .orderBy(desc(relations.confidence))
        .get() ?? null;
    return { ...row, versions, introducedBy };
  });
}

const placeholder = (name: string) => sql.placeholder(name);

const statements = preparedFor((db) => ({
  findSymbol: db
    .select({ id: symbols.id, contentHash: symbols.contentHash })
    .from(symbols)
    .where(
      and(
        eq(symbols.fileId, placeholder('fileId')),
        eq(symbols.stableKey, placeholder('stableKey')),
      ),
    )
    .prepare(),
  insertSymbol: db
    .insert(symbols)
    .values({
      fileId: placeholder('fileId'),
      stableKey: placeholder('stableKey'),
      name: placeholder('name'),
      qualifiedName: placeholder('qualifiedName'),
      kind: placeholder('kind'),
      signature: placeholder('signature'),
      startLine: placeholder('startLine'),
      endLine: placeholder('endLine'),
      contentHash: placeholder('contentHash'),
      current: true,
    })
    .returning()
    .prepare(),
  updateSymbol: db
    .update(symbols)
    .set({
      name: sql`${placeholder('name')}`,
      qualifiedName: sql`${placeholder('qualifiedName')}`,
      kind: sql`${placeholder('kind')}`,
      signature: sql`${placeholder('signature')}`,
      startLine: sql`${placeholder('startLine')}`,
      endLine: sql`${placeholder('endLine')}`,
      contentHash: sql`${placeholder('contentHash')}`,
      current: true,
    })
    .where(eq(symbols.id, placeholder('id')))
    .returning()
    .prepare(),
  insertVersion: db
    .insert(symbolVersions)
    .values({
      symbolId: placeholder('symbolId'),
      commitId: placeholder('commitId'),
      contentHash: placeholder('contentHash'),
      signature: placeholder('signature'),
    })
    .onConflictDoNothing()
    .prepare(),
  listFileSymbolKeys: db
    .select({ id: symbols.id, stableKey: symbols.stableKey, current: symbols.current })
    .from(symbols)
    .where(eq(symbols.fileId, placeholder('fileId')))
    .prepare(),
  setCurrent: db
    .update(symbols)
    .set({ current: sql`${placeholder('current')}` })
    .where(eq(symbols.id, placeholder('id')))
    .prepare(),
  anySymbol: db
    .select({ id: symbols.id })
    .from(symbols)
    .where(eq(symbols.fileId, placeholder('fileId')))
    .limit(1)
    .prepare(),
  moveSymbols: db
    .update(symbols)
    .set({ fileId: sql`${placeholder('toFileId')}` })
    .where(eq(symbols.fileId, placeholder('fromFileId')))
    .prepare(),
  markIndexed: db
    .update(fileChanges)
    .set({ symbolsIndexedAt: sql`${placeholder('at')}` })
    .where(eq(fileChanges.id, placeholder('id')))
    .prepare(),
  anyIndexedChange: db
    .select({ id: fileChanges.id })
    .from(fileChanges)
    .where(
      and(eq(fileChanges.fileId, placeholder('fileId')), isNotNull(fileChanges.symbolsIndexedAt)),
    )
    .limit(1)
    .prepare(),
}));
