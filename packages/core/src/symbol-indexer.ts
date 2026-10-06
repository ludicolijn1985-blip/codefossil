import {
  findFileById,
  findFileByPath,
  hasIndexedVersion,
  insertSymbolVersion,
  markSymbolsIndexed,
  moveSymbols,
  pendingSymbolChanges,
  recordEvidence,
  recordRelation,
  setCurrentSymbols,
  upsertSymbol,
  type FossilDb,
  type PendingSymbolChange,
} from '@codefossil/db';
import { readBlobIds, readBlobs } from '@codefossil/git';
import { grammarForPath, SymbolExtractor, type ExtractResult } from '@codefossil/parser';
import type { ProvenanceInput } from '@codefossil/shared';

export const SYMBOL_INDEXER_PRODUCER = 'symbol-indexer@0.1.0';

/** Parsed file versions written per database transaction. */
const DEFAULT_BATCH_SIZE = 200;

/** Parsed versions whose symbol hashes are kept to diff their children against. */
const MAX_CACHED_VERSIONS = 20_000;

/** Confidence for relations derived from a tree Tree-sitter had to error-recover. */
const RECOVERED_PARSE_CONFIDENCE = 0.8;

export interface SymbolIndexOptions {
  readonly now?: () => Date;
  readonly batchSize?: number;
  readonly onProgress?: (changesProcessed: number, changesTotal: number) => void;
}

export interface SymbolIndexResult {
  /** File versions parsed for symbols. */
  readonly versionsParsed: number;
  /** Versions skipped: binary, too large, or not present in git. */
  readonly versionsSkipped: number;
  /** New symbol versions recorded (a symbol appeared or its content changed). */
  readonly symbolVersions: number;
  /** Symbols whose introducing commit is established by the indexed history. */
  readonly symbolsIntroduced: number;
  /** Versions the parser failed on; counted in versionsSkipped as well. */
  readonly parseFailures: number;
}

interface ParsedChange {
  readonly change: PendingSymbolChange;
  /** Null for deletions and for versions that could not be parsed. */
  readonly result: ExtractResult | null;
  /**
   * Symbol content hashes of the same file in the commit's first parent, when
   * known: a symbol changed only if it differs from there. Null falls back to
   * the stored version (an incremental run whose parent was parsed earlier).
   */
  readonly previous: ReadonlyMap<string, string> | null;
}

interface Totals {
  versionsParsed: number;
  versionsSkipped: number;
  symbolVersions: number;
  symbolsIntroduced: number;
  parseFailures: number;
}

/**
 * Extract symbols from every file version the git indexer recorded but that
 * has not been parsed yet, oldest commit first, then reconcile which symbols
 * exist at HEAD.
 *
 * Per symbol this records:
 * - `file CONTAINS symbol` (FACT: the syntax tree shows it),
 * - `commit MODIFIES symbol` for each version (DERIVED: content hashes differ),
 * - `symbol INTRODUCED_BY commit` (DERIVED) — only when an earlier version of
 *   the file was indexed without the symbol, or the file was added in that
 *   commit. A symbol first seen at the edge of the indexed history gets no
 *   introduction claim, because the evidence does not establish one.
 */
export async function indexSymbols(
  db: FossilDb,
  repositoryId: number,
  root: string,
  headSha: string | null,
  options: SymbolIndexOptions = {},
): Promise<SymbolIndexResult> {
  const now = options.now ?? (() => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const observedAt = now().toISOString();
  const totals: Totals = {
    versionsParsed: 0,
    versionsSkipped: 0,
    symbolVersions: 0,
    symbolsIntroduced: 0,
    parseFailures: 0,
  };
  const touchedFiles = new Set<number>();

  const pending = pendingSymbolChanges(db, repositoryId).filter((c) => grammarForPath(c.path));
  const parseable = pending.filter((c) => c.status !== 'deleted');
  const extractor = new SymbolExtractor();
  const blobs = readBlobs(
    root,
    parseable.map((change) => ({ ...change, revision: change.sha })),
  )[Symbol.asyncIterator]();
  // Symbol hashes per parsed blob: a change is diffed against its parent's version of the file,
  // not against whichever branch was indexed last.
  const hashesByBlob = new Map<string, ReadonlyMap<string, string>>();

  try {
    const parents = await parentVersions(root, parseable);
    const parentHashes = await parseOutsideParents(root, extractor, parseable, parents);
    let batch: ParsedChange[] = [];
    let processed = 0;
    const flush = () => {
      db.transaction((tx) => {
        for (const item of batch)
          writeChange(tx, repositoryId, item, observedAt, totals, touchedFiles);
      });
      processed += batch.length;
      batch = [];
      options.onProgress?.(processed, pending.length);
    };

    let parsedIndex = 0;
    for (const change of pending) {
      if (change.status === 'deleted') {
        batch.push({ change, result: null, previous: null });
      } else {
        const next = await blobs.next();
        if (next.done) throw new Error(`Missing blob result for ${change.path}@${change.sha}`);
        const result = await parse(extractor, change.path, next.value.content, () => {
          totals.parseFailures++;
        });
        const parentBlob = parents[parsedIndex++]?.oid ?? null;
        const previous =
          change.status === 'added'
            ? new Map<string, string>()
            : parentBlob === null
              ? null
              : (hashesByBlob.get(parentBlob) ?? parentHashes.get(parentBlob) ?? null);
        if (result && next.value.oid) {
          if (hashesByBlob.size >= MAX_CACHED_VERSIONS) {
            const oldest = hashesByBlob.keys().next().value;
            if (oldest !== undefined) hashesByBlob.delete(oldest);
          }
          hashesByBlob.set(
            next.value.oid,
            new Map(result.symbols.map((symbol) => [symbol.stableKey, symbol.contentHash])),
          );
        }
        batch.push({ change, result, previous });
      }
      if (batch.length >= batchSize) flush();
    }
    if (batch.length > 0) flush();

    if (headSha) {
      await reconcileWithHead(db, repositoryId, root, headSha, touchedFiles, extractor, observedAt);
    }
  } finally {
    // Stops the cat-file process when parsing ends early.
    await blobs.return(undefined);
    await extractor.dispose();
  }
  return totals;
}

interface ParentVersion {
  readonly oid: string;
  readonly revision: string;
  readonly path: string;
}

/**
 * The version of each change's file in its commit's first parent (the old
 * path for a rename), or null: an added file or a root commit has none.
 */
async function parentVersions(
  root: string,
  changes: readonly PendingSymbolChange[],
): Promise<(ParentVersion | null)[]> {
  const wanted = changes.flatMap((change, index) =>
    change.status !== 'added' && change.firstParentSha
      ? [{ index, revision: change.firstParentSha, path: change.previousPath ?? change.path }]
      : [],
  );
  const ids = await readBlobIds(root, wanted);
  const result: (ParentVersion | null)[] = changes.map(() => null);
  wanted.forEach((request, i) => {
    const oid = ids[i];
    if (oid) result[request.index] = { oid, revision: request.revision, path: request.path };
  });
  return result;
}

/**
 * Symbol hashes of parent versions this run does not parse itself: versions
 * a merge commit produced (merges record no file changes) and versions
 * parsed by an earlier run. Without them a change would be compared with
 * whichever version was stored last.
 */
async function parseOutsideParents(
  root: string,
  extractor: SymbolExtractor,
  changes: readonly PendingSymbolChange[],
  parents: readonly (ParentVersion | null)[],
): Promise<Map<string, ReadonlyMap<string, string>>> {
  const own = new Set(
    (
      await readBlobIds(
        root,
        changes.map((change) => ({ revision: change.sha, path: change.path })),
      )
    ).filter((oid): oid is string => oid !== null),
  );
  const outside = new Map<string, ParentVersion>();
  for (const parent of parents) {
    if (parent && !own.has(parent.oid)) outside.set(parent.oid, parent);
  }
  const hashes = new Map<string, ReadonlyMap<string, string>>();
  for await (const { request, content } of readBlobs(root, [...outside.values()])) {
    const result = await parse(extractor, request.path, content, () => undefined);
    if (result) {
      hashes.set(request.oid, new Map(result.symbols.map((s) => [s.stableKey, s.contentHash])));
    }
  }
  return hashes;
}

/**
 * Parse one file version. Returns null when it cannot be parsed: binary,
 * too large, or a parser failure — one hostile or broken file must not abort
 * indexing of the whole repository. Failures are reported via `onFailure`.
 */
async function parse(
  extractor: SymbolExtractor,
  path: string,
  content: Buffer | null,
  onFailure: () => void,
): Promise<ExtractResult | null> {
  const grammar = grammarForPath(path);
  // A NUL byte means binary content that happens to have a source extension.
  if (!grammar || !content || content.includes(0)) return null;
  try {
    return await extractor.extract(content.toString('utf8'), grammar);
  } catch {
    onFailure();
    return null;
  }
}

function writeChange(
  db: FossilDb,
  repositoryId: number,
  { change, result, previous }: ParsedChange,
  observedAt: string,
  totals: Totals,
  touchedFiles: Set<number>,
): void {
  touchedFiles.add(change.fileId);
  let renamedFrom: number | null = null;
  if (change.status === 'renamed' && change.previousPath) {
    const previous = findFileByPath(db, repositoryId, change.previousPath);
    if (previous) {
      // No-op when the destination path already has symbol rows (it held another file
      // before); the renamed file's symbols then start a fresh history.
      moveSymbols(db, previous.id, change.fileId);
      touchedFiles.add(previous.id);
      renamedFrom = previous.id;
    }
  }

  if (change.status === 'deleted') {
    setCurrentSymbols(db, change.fileId, new Set());
  } else if (!result) {
    totals.versionsSkipped++;
  } else {
    // Only claim an introduction when we have seen the file without the symbol.
    const sawEarlierVersion =
      change.status === 'added' ||
      hasIndexedVersion(db, change.fileId) ||
      (renamedFrom !== null && hasIndexedVersion(db, renamedFrom));
    writeSymbols(db, repositoryId, change, result, previous, sawEarlierVersion, observedAt, totals);
    totals.versionsParsed++;
  }
  markSymbolsIndexed(db, change.fileChangeId, observedAt);
}

function writeSymbols(
  db: FossilDb,
  repositoryId: number,
  change: PendingSymbolChange,
  result: ExtractResult,
  previous: ReadonlyMap<string, string> | null,
  sawEarlierVersion: boolean,
  observedAt: string,
  totals: Totals,
): void {
  const derivedConfidence = result.hasSyntaxErrors ? RECOVERED_PARSE_CONFIDENCE : 1;
  for (const symbol of result.symbols) {
    const upsert = upsertSymbol(db, { fileId: change.fileId, ...symbol });
    const { row, created } = upsert;
    const changed =
      created ||
      (previous ? previous.get(symbol.stableKey) !== symbol.contentHash : upsert.changed);
    if (!changed) continue;

    insertSymbolVersion(db, {
      symbolId: row.id,
      commitId: change.commitId,
      contentHash: symbol.contentHash,
      signature: symbol.signature,
    });
    const evidence = recordEvidence(db, {
      repositoryId,
      type: 'ast_node',
      locator: `${change.path}@${change.sha}#L${symbol.startLine}-L${symbol.endLine}`,
      excerpt: symbol.signature,
      metadata: {
        stableKey: symbol.stableKey,
        contentHash: symbol.contentHash,
        syntaxErrors: result.hasSyntaxErrors,
      },
    });
    const provenance = (method: string): ProvenanceInput => ({
      producer: SYMBOL_INDEXER_PRODUCER,
      method,
      evidenceIds: [evidence.id],
      observedAt,
    });
    const symbolRef = { type: 'symbol', id: row.id } as const;
    const commitRef = { type: 'commit', id: change.commitId } as const;

    recordRelation(db, {
      repositoryId,
      source: { type: 'file', id: change.fileId },
      relation: 'CONTAINS',
      target: symbolRef,
      evidenceType: 'FACT',
      confidence: 1,
      provenance: provenance('tree-sitter'),
    });
    recordRelation(db, {
      repositoryId,
      source: commitRef,
      relation: 'MODIFIES',
      target: symbolRef,
      evidenceType: 'DERIVED',
      confidence: derivedConfidence,
      provenance: provenance('content-hash-diff'),
    });
    if (created && sawEarlierVersion) {
      recordRelation(db, {
        repositoryId,
        source: symbolRef,
        relation: 'INTRODUCED_BY',
        target: commitRef,
        evidenceType: 'DERIVED',
        confidence: derivedConfidence,
        provenance: provenance('first-indexed-version'),
      });
      totals.symbolsIntroduced++;
    }
    totals.symbolVersions++;
  }
  setCurrentSymbols(db, change.fileId, new Set(result.symbols.map((s) => s.stableKey)));
}

/**
 * History is processed in commit-date order, which does not decide what is
 * current when branches merge. Re-read every touched file at HEAD and make its
 * current symbols, lines and signatures match.
 */
async function reconcileWithHead(
  db: FossilDb,
  repositoryId: number,
  root: string,
  headSha: string,
  touchedFiles: ReadonlySet<number>,
  extractor: SymbolExtractor,
  observedAt: string,
): Promise<void> {
  const files = [...touchedFiles]
    .map((id) => findFileById(db, id))
    .filter((file) => file !== undefined);
  const live = files.filter((file) => file.deletedAt === null && grammarForPath(file.path));
  const parsed = new Map<number, ExtractResult | null>();
  for await (const { request, content } of readBlobs(
    root,
    live.map((file) => ({ fileId: file.id, path: file.path, revision: headSha })),
  )) {
    // A failure here keeps what history established for the file.
    parsed.set(request.fileId, await parse(extractor, request.path, content, () => undefined));
  }

  db.transaction((tx) => {
    for (const file of files) {
      const result = parsed.get(file.id);
      if (result === undefined) {
        setCurrentSymbols(tx, file.id, new Set());
        continue;
      }
      if (result === null) continue; // unreadable at HEAD: keep what history established
      for (const symbol of result.symbols) {
        const { row, created } = upsertSymbol(tx, { fileId: file.id, ...symbol });
        if (!created) continue;
        // Present at HEAD but never seen in a parsed change (e.g. added in a merge).
        const evidence = recordEvidence(tx, {
          repositoryId,
          type: 'ast_node',
          locator: `${file.path}@${headSha}#L${symbol.startLine}-L${symbol.endLine}`,
          excerpt: symbol.signature,
          metadata: { stableKey: symbol.stableKey, contentHash: symbol.contentHash },
        });
        recordRelation(tx, {
          repositoryId,
          source: { type: 'file', id: file.id },
          relation: 'CONTAINS',
          target: { type: 'symbol', id: row.id },
          evidenceType: 'FACT',
          confidence: 1,
          provenance: {
            producer: SYMBOL_INDEXER_PRODUCER,
            method: 'tree-sitter-head',
            evidenceIds: [evidence.id],
            observedAt,
          },
        });
      }
      setCurrentSymbols(tx, file.id, new Set(result.symbols.map((s) => s.stableKey)));
    }
  });
}
