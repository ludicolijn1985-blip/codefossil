import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { FossilDb } from './client.js';
import { calls, evidence, files, symbols } from './schema.js';

export interface NewCall {
  readonly callee: readonly string[];
  readonly caller: string | null;
  readonly line: number;
}

/** Replace the calls recorded for a file with those observed in `sha`. */
export function replaceFileCalls(
  db: FossilDb,
  fileId: number,
  sha: string,
  found: readonly NewCall[],
): void {
  deleteFileCalls(db, fileId);
  for (const call of found) {
    db.insert(calls)
      .values({
        fileId,
        callerKey: call.caller,
        callee: call.callee.join('.'),
        line: call.line,
        sha,
      })
      .run();
  }
}

export function deleteFileCalls(db: FossilDb, fileId: number): void {
  db.delete(calls).where(eq(calls.fileId, fileId)).run();
}

export interface RepositoryCall {
  readonly fileId: number;
  readonly path: string;
  readonly callerKey: string | null;
  readonly callee: string;
  readonly line: number;
  readonly sha: string;
}

/** Every call in every file that exists at HEAD. */
export function listRepositoryCalls(db: FossilDb, repositoryId: number): RepositoryCall[] {
  return db
    .select({
      fileId: calls.fileId,
      path: files.path,
      callerKey: calls.callerKey,
      callee: calls.callee,
      line: calls.line,
      sha: calls.sha,
    })
    .from(calls)
    .innerJoin(files, eq(calls.fileId, files.id))
    .where(and(eq(files.repositoryId, repositoryId), isNull(files.deletedAt)))
    .orderBy(asc(files.path), asc(calls.line))
    .all();
}

export interface CallableSymbol {
  readonly id: number;
  readonly fileId: number;
  readonly stableKey: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly kind: string;
}

/** Current symbols of files present at HEAD: what calls can resolve to. */
export function currentSymbols(db: FossilDb, repositoryId: number): CallableSymbol[] {
  return db
    .select({
      id: symbols.id,
      fileId: symbols.fileId,
      stableKey: symbols.stableKey,
      name: symbols.name,
      qualifiedName: symbols.qualifiedName,
      kind: symbols.kind,
    })
    .from(symbols)
    .innerJoin(files, eq(symbols.fileId, files.id))
    .where(
      and(eq(files.repositoryId, repositoryId), eq(symbols.current, true), isNull(files.deletedAt)),
    )
    .all();
}

/** Remove the evidence rows a call-graph rebuild created, tagged `snapshot: calls`. */
export function deleteCallEvidence(db: FossilDb, repositoryId: number): void {
  db.delete(evidence)
    .where(
      and(
        eq(evidence.repositoryId, repositoryId),
        sql`json_extract(${evidence.metadataJson}, '$.snapshot') = 'calls'`,
      ),
    )
    .run();
}
