import {
  deleteRelation,
  fileSymbolRows,
  findFileById,
  findFileByPath,
  findIdenticalSymbol,
  hasIndexedVersion,
  insertSymbolVersion,
  loadParsedBlob,
  markSymbolsIndexed,
  moveSymbols,
  pendingSymbolChanges,
  recordEvidence,
  recordRelation,
  saveParsedBlob,
  setCurrentSymbols,
  trimParseCache,
  upsertSymbol,
  type FossilDb,
  type PendingSymbolChange,
} from '@codefossil/db';
import { readBlobIds, readBlobs } from '@codefossil/git';
import {
  extractionVersion,
  grammarForPath,
  SymbolExtractor,
  type ExtractResult,
} from '@codefossil/parser';
import type { ProvenanceInput } from '@codefossil/shared';

export const SYMBOL_INDEXER_PRODUCER = 'symbol-indexer@0.1.0';

/** Parsed file versions written per database transaction. */
const DEFAULT_BATCH_SIZE = 200;

/**
 * Parse results kept per repository (about 1–2 KB each). Enough for the
 * history of a large project; the oldest go first beyond it.
 */
export const MAX_PARSE_CACHE_ROWS = 200_000;

/** A commit's changes are written in one transaction up to this many batches. */
const MAX_BATCHES_PER_COMMIT = 25;

/** Parsed versions whose symbol hashes are kept to diff their children against. */
const MAX_CACHED_VERSIONS = 20_000;

/** Kinds whose identical text in another file is taken as the same code, copied or moved. */
const COPYABLE_KINDS: ReadonlySet<string> = new Set([
  'function',
  'method',
  'class',
  'interface',
  'enum',
  'struct',
  'trait',
  'impl',
]);
/** Shorter definitions are too likely to be identical by coincidence. */
const MIN_COPY_LINES = 3;
/** Identical content is observed; that it was copied (not rewritten identically) is very likely. */
const COPY_CONFIDENCE = 0.9;
/**
 * The same name and kind left one file and arrived in another within one
 * commit, with edits: probably moved, but the content does not prove it.
 */
const MOVED_WITH_EDITS_CONFIDENCE = 0.6;

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
  /** New symbols identical to one in another file: copied or moved there, not introduced. */
  readonly symbolsCopied: number;
  /** New symbols identical to one that disappeared from the same file in that commit, but for the name. */
  readonly symbolsRenamed: number;
  /** New symbols whose name and kind left another file in the same commit (moved with edits). */
  readonly symbolsMoved: number;
  /** Versions the parser failed on; counted in versionsSkipped as well. */
  readonly parseFailures: number;
  /** Versions whose symbols came from the parse cache (content parsed in an earlier run). */
  readonly versionsFromCache: number;
}

/** A symbol's hashes in one file version. */
interface SymbolHashes {
  readonly content: string;
  /** With the symbol's own name blanked: equal across a rename. */
  readonly shape: string;
}

const hashesOf = (result: ExtractResult): ReadonlyMap<string, SymbolHashes> =>
  new Map(
    result.symbols.map((symbol) => [
      symbol.stableKey,
      { content: symbol.contentHash, shape: symbol.shapeHash },
    ]),
  );

interface ParsedChange {
  readonly change: PendingSymbolChange;
  /** Null for deletions and for versions that could not be parsed. */
  readonly result: ExtractResult | null;
  /**
   * Symbol hashes of the same file in the commit's first parent, when known:
   * a symbol changed only if it differs from there. Null falls back to the
   * stored version (an incremental run whose parent was parsed earlier).
   */
  readonly previous: ReadonlyMap<string, SymbolHashes> | null;
}

interface LineageSymbol {
  readonly symbolId: number;
  readonly fileId: number;
  readonly kind: string;
  readonly qualifiedName: string;
  /** Null when the version's text is unknown (a deleted file, no parsed parent). */
  readonly shape: string | null;
  readonly lines: number;
}

interface BornSymbol extends LineageSymbol {
  readonly evidenceId: number;
  readonly confidence: number;
}

/**
 * Symbols that disappeared and that were born within one commit. Read
 * together once the commit's last file is written, they tell a rename or a
 * move apart from a removal plus an unrelated birth.
 */
interface CommitLineage {
  readonly commitId: number;
  readonly removed: LineageSymbol[];
  readonly born: BornSymbol[];
}

interface Totals {
  versionsParsed: number;
  versionsSkipped: number;
  symbolVersions: number;
  symbolsIntroduced: number;
  symbolsCopied: number;
  symbolsRenamed: number;
  symbolsMoved: number;
  parseFailures: number;
  versionsFromCache: number;
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
    symbolsCopied: 0,
    symbolsRenamed: 0,
    symbolsMoved: 0,
    parseFailures: 0,
    versionsFromCache: 0,
  };
  const touchedFiles = new Set<number>();

  const pending = pendingSymbolChanges(db, repositoryId).filter((c) => grammarForPath(c.path));
  const parseable = pending.filter((c) => c.status !== 'deleted');
  const extractor = new SymbolExtractor();
  const parser = new BlobParser(db, repositoryId, extractor, totals);
  const blobs = readBlobs(
    root,
    parseable.map((change) => ({ ...change, revision: change.sha })),
  )[Symbol.asyncIterator]();
  // Symbol hashes per parsed blob: a change is diffed against its parent's version of the file,
  // not against whichever branch was indexed last.
  const hashesByBlob = new Map<string, ReadonlyMap<string, SymbolHashes>>();

  try {
    const parents = await parentVersions(root, parseable);
    const parentHashes = await parseOutsideParents(root, parser, parseable, parents);
    db.transaction((tx) => {
      parser.save(tx);
    });
    let batch: ParsedChange[] = [];
    let processed = 0;
    let lineage: CommitLineage | null = null;
    /** Write the batch; `nextCommitId` is the commit of the change after it, if any. */
    const flush = (nextCommitId: number | null) => {
      db.transaction((tx) => {
        parser.save(tx);
        for (const item of batch) {
          if (lineage && lineage.commitId !== item.change.commitId) {
            resolveLineage(tx, repositoryId, lineage, observedAt, totals);
            lineage = null;
          }
          lineage ??= { commitId: item.change.commitId, removed: [], born: [] };
          writeChange(tx, repositoryId, item, observedAt, totals, touchedFiles, lineage);
        }
        if (lineage && lineage.commitId !== nextCommitId) {
          resolveLineage(tx, repositoryId, lineage, observedAt, totals);
          lineage = null;
        }
      });
      processed += batch.length;
      batch = [];
      options.onProgress?.(processed, pending.length);
    };

    let parsedIndex = 0;
    for (const [index, change] of pending.entries()) {
      if (change.status === 'deleted') {
        batch.push({ change, result: null, previous: null });
      } else {
        const next = await blobs.next();
        if (next.done) throw new Error(`Missing blob result for ${change.path}@${change.sha}`);
        const result = await parser.parse(change.path, next.value.oid, next.value.content, () => {
          totals.parseFailures++;
        });
        const parentBlob = parents[parsedIndex++]?.oid ?? null;
        const previous =
          change.status === 'added'
            ? new Map<string, SymbolHashes>()
            : parentBlob === null
              ? null
              : (hashesByBlob.get(parentBlob) ?? parentHashes.get(parentBlob) ?? null);
        if (result && next.value.oid) {
          if (hashesByBlob.size >= MAX_CACHED_VERSIONS) {
            const oldest = hashesByBlob.keys().next().value;
            if (oldest !== undefined) hashesByBlob.delete(oldest);
          }
          hashesByBlob.set(next.value.oid, hashesOf(result));
        }
        batch.push({ change, result, previous });
      }
      const nextCommitId = pending[index + 1]?.commitId ?? null;
      // Cut batches between commits, so a commit's renames and moves are read in one
      // transaction; only a huge commit is split (its lineage then spans transactions).
      if (
        batch.length >= batchSize &&
        (nextCommitId !== change.commitId || batch.length >= batchSize * MAX_BATCHES_PER_COMMIT)
      ) {
        flush(nextCommitId);
      }
    }
    if (batch.length > 0) flush(null);
    trimParseCache(db, repositoryId, extractionVersion(), MAX_PARSE_CACHE_ROWS);

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
  parser: BlobParser,
  changes: readonly PendingSymbolChange[],
  parents: readonly (ParentVersion | null)[],
): Promise<Map<string, ReadonlyMap<string, SymbolHashes>>> {
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
  const hashes = new Map<string, ReadonlyMap<string, SymbolHashes>>();
  for await (const { request, content } of readBlobs(root, [...outside.values()])) {
    const result = await parser.parse(request.path, request.oid, content, () => undefined, false);
    if (result) hashes.set(request.oid, hashesOf(result));
  }
  return hashes;
}

interface CachedParse {
  readonly symbols: ExtractResult['symbols'];
  readonly hasSyntaxErrors: boolean;
}

const isCachedParse = (value: unknown): value is CachedParse =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as { symbols?: unknown }).symbols) &&
  typeof (value as { hasSyntaxErrors?: unknown }).hasSyntaxErrors === 'boolean';

/**
 * Parses file versions, reusing the result for content parsed before (by blob
 * id and grammar). New results are kept until `save` writes them in the
 * caller's transaction.
 */
class BlobParser {
  private pending: { oid: string; grammar: string; result: CachedParse }[] = [];

  constructor(
    private readonly db: FossilDb,
    private readonly repositoryId: number,
    private readonly extractor: SymbolExtractor,
    private readonly totals: Totals,
  ) {}

  async parse(
    path: string,
    oid: string | null,
    content: Buffer | null,
    onFailure: () => void,
    /** Count a cache hit in the totals: false for parent versions, which are not indexed versions. */
    counted = true,
  ): Promise<ExtractResult | null> {
    const grammar = grammarForPath(path);
    if (grammar && oid) {
      const cached = loadParsedBlob(this.db, this.repositoryId, oid, grammar, extractionVersion());
      if (isCachedParse(cached)) {
        if (counted) this.totals.versionsFromCache++;
        return {
          symbols: cached.symbols,
          imports: [],
          calls: [],
          hasSyntaxErrors: cached.hasSyntaxErrors,
        };
      }
    }
    const result = await parse(this.extractor, path, content, onFailure);
    if (result && grammar && oid) {
      this.pending.push({
        oid,
        grammar,
        result: { symbols: result.symbols, hasSyntaxErrors: result.hasSyntaxErrors },
      });
    }
    return result;
  }

  /** Write the results parsed since the last save. */
  save(db: FossilDb): void {
    for (const { oid, grammar, result } of this.pending) {
      saveParsedBlob(db, {
        repositoryId: this.repositoryId,
        oid,
        grammar,
        version: extractionVersion(),
        result,
      });
    }
    this.pending = [];
  }
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
    // History needs symbols only; imports and calls are read at HEAD by the dependency indexer.
    return await extractor.extract(content.toString('utf8'), grammar, { references: false });
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
  lineage: CommitLineage,
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
    noteRemoved(db, change.fileId, null, new Set(), lineage);
    setCurrentSymbols(db, change.fileId, new Set());
  } else if (!result) {
    totals.versionsSkipped++;
  } else {
    // Only claim an introduction when we have seen the file without the symbol.
    const sawEarlierVersion =
      change.status === 'added' ||
      hasIndexedVersion(db, change.fileId) ||
      (renamedFrom !== null && hasIndexedVersion(db, renamedFrom));
    noteRemoved(
      db,
      change.fileId,
      previous,
      new Set(result.symbols.map((s) => s.stableKey)),
      lineage,
    );
    writeSymbols(
      db,
      repositoryId,
      change,
      result,
      previous,
      sawEarlierVersion,
      observedAt,
      totals,
      lineage,
    );
    totals.versionsParsed++;
  }
  markSymbolsIndexed(db, change.fileChangeId, observedAt);
}

function writeSymbols(
  db: FossilDb,
  repositoryId: number,
  change: PendingSymbolChange,
  result: ExtractResult,
  previous: ReadonlyMap<string, SymbolHashes> | null,
  sawEarlierVersion: boolean,
  observedAt: string,
  totals: Totals,
  lineage: CommitLineage,
): void {
  const derivedConfidence = result.hasSyntaxErrors ? RECOVERED_PARSE_CONFIDENCE : 1;
  for (const symbol of result.symbols) {
    const upsert = upsertSymbol(db, { fileId: change.fileId, ...symbol });
    const { row, created } = upsert;
    const changed =
      created ||
      (previous ? previous.get(symbol.stableKey)?.content !== symbol.contentHash : upsert.changed);
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
    const copiedFrom =
      created && sawEarlierVersion ? copySource(db, repositoryId, change, symbol) : null;
    if (copiedFrom !== null) {
      // Identical content already lived in another file: this is where it was copied or moved
      // to, not where it was born. Its origin is the source symbol's.
      recordRelation(db, {
        repositoryId,
        source: symbolRef,
        relation: 'COPIED_FROM',
        target: { type: 'symbol', id: copiedFrom },
        evidenceType: 'DERIVED',
        confidence: COPY_CONFIDENCE * derivedConfidence,
        provenance: provenance('identical-content'),
      });
      totals.symbolsCopied++;
    } else if (created && sawEarlierVersion) {
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
      // A rename or a move found once the whole commit is read replaces this claim.
      lineage.born.push({
        symbolId: row.id,
        fileId: change.fileId,
        kind: symbol.kind,
        qualifiedName: symbol.qualifiedName,
        shape: symbol.shapeHash,
        lines: symbol.endLine - symbol.startLine + 1,
        evidenceId: evidence.id,
        confidence: derivedConfidence,
      });
    }
    totals.symbolVersions++;
  }
  setCurrentSymbols(db, change.fileId, new Set(result.symbols.map((s) => s.stableKey)));
}

/**
 * The symbol in another file whose recorded content is identical to a newly
 * seen one, for kinds and sizes where identical text means the same code:
 * one-line declarations (`var http = require('http')`) repeat by coincidence.
 */
function copySource(
  db: FossilDb,
  repositoryId: number,
  change: PendingSymbolChange,
  symbol: ExtractResult['symbols'][number],
): number | null {
  if (!COPYABLE_KINDS.has(symbol.kind)) return null;
  if (symbol.endLine - symbol.startLine + 1 < MIN_COPY_LINES) return null;
  return findIdenticalSymbol(db, repositoryId, {
    fileId: change.fileId,
    qualifiedName: symbol.qualifiedName,
    kind: symbol.kind,
    contentHash: symbol.contentHash,
  });
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

/**
 * Record the symbols of a file that this change removes: those of the
 * parent version (or, without one, the stored current ones) that `kept` no
 * longer has.
 */
function noteRemoved(
  db: FossilDb,
  fileId: number,
  previous: ReadonlyMap<string, SymbolHashes> | null,
  kept: ReadonlySet<string>,
  lineage: CommitLineage,
): void {
  // Without the parent version only a deleted file (`kept` empty) says what this change removed:
  // the stored current flags may come from another branch.
  if (!previous && kept.size > 0) return;
  for (const row of fileSymbolRows(db, fileId)) {
    const before = previous ? previous.has(row.stableKey) : row.current;
    if (!before || kept.has(row.stableKey)) continue;
    lineage.removed.push({
      symbolId: row.id,
      fileId,
      kind: row.kind,
      qualifiedName: row.qualifiedName,
      shape: previous?.get(row.stableKey)?.shape ?? null,
      lines: row.endLine - row.startLine + 1,
    });
  }
}

const isLineageCandidate = (symbol: LineageSymbol): boolean =>
  COPYABLE_KINDS.has(symbol.kind) && symbol.lines >= MIN_COPY_LINES;

/**
 * Once a commit is fully written, follow symbols born in it back to symbols
 * that disappeared in it:
 * - renamed: same file and kind, identical but for the name (DERIVED);
 * - moved with edits: same kind and qualified name, removed from another
 *   file (INFERRED).
 * Only an unambiguous match counts. A match replaces the symbol's
 * `INTRODUCED_BY` with `COPIED_FROM`, so its origin is the older symbol's.
 */
function resolveLineage(
  db: FossilDb,
  repositoryId: number,
  lineage: CommitLineage,
  observedAt: string,
  totals: Totals,
): void {
  const removed = lineage.removed.filter(isLineageCandidate);
  const born = lineage.born.filter(isLineageCandidate);
  const used = new Set<number>();
  const matched = new Set<number>();
  // Renames first (identical but for the name), then moves: a weaker reading never takes a
  // removed symbol that a stronger one explains.
  for (const rule of LINEAGE_RULES) {
    const candidates = new Map<number, LineageSymbol[]>();
    const claims = new Map<number, number>();
    for (const b of born) {
      if (matched.has(b.symbolId)) continue;
      const fits = removed.filter(
        (r) => !used.has(r.symbolId) && r.kind === b.kind && rule.fits(b, r),
      );
      candidates.set(b.symbolId, fits);
      for (const r of fits) claims.set(r.symbolId, (claims.get(r.symbolId) ?? 0) + 1);
    }
    for (const b of born) {
      const fits = candidates.get(b.symbolId) ?? [];
      const source = fits.length === 1 ? fits[0] : undefined;
      // Unambiguous on both sides: one candidate, claimed by this symbol only.
      if (!source || claims.get(source.symbolId) !== 1) continue;
      used.add(source.symbolId);
      matched.add(b.symbolId);
      writeLineage(db, repositoryId, lineage.commitId, b, source, rule, observedAt);
      totals.symbolsIntroduced--;
      if (rule.method === 'renamed') totals.symbolsRenamed++;
      else totals.symbolsMoved++;
    }
  }
}

interface LineageRule {
  readonly method: 'renamed' | 'moved-with-edits';
  readonly level: 'DERIVED' | 'INFERRED';
  readonly confidence: number;
  readonly fits: (born: LineageSymbol, removed: LineageSymbol) => boolean;
}

const LINEAGE_RULES: readonly LineageRule[] = [
  {
    method: 'renamed',
    level: 'DERIVED',
    confidence: COPY_CONFIDENCE,
    fits: (born, removed) =>
      removed.fileId === born.fileId && removed.shape !== null && removed.shape === born.shape,
  },
  {
    method: 'moved-with-edits',
    level: 'INFERRED',
    confidence: MOVED_WITH_EDITS_CONFIDENCE,
    fits: (born, removed) =>
      removed.fileId !== born.fileId && removed.qualifiedName === born.qualifiedName,
  },
];

/** Replace a born symbol's introduction with its lineage to the removed one. */
function writeLineage(
  db: FossilDb,
  repositoryId: number,
  commitId: number,
  born: BornSymbol,
  source: LineageSymbol,
  rule: LineageRule,
  observedAt: string,
): void {
  const symbolRef = { type: 'symbol', id: born.symbolId } as const;
  deleteRelation(db, repositoryId, {
    source: symbolRef,
    relation: 'INTRODUCED_BY',
    target: { type: 'commit', id: commitId },
  });
  recordRelation(db, {
    repositoryId,
    source: symbolRef,
    relation: 'COPIED_FROM',
    target: { type: 'symbol', id: source.symbolId },
    evidenceType: rule.level,
    confidence: rule.confidence * born.confidence,
    provenance: {
      producer: SYMBOL_INDEXER_PRODUCER,
      method: rule.method,
      evidenceIds: [born.evidenceId],
      observedAt,
      // What the removed side was, so the reading can be checked against history.
      details: {
        removedFrom: source.fileId,
        removedQualifiedName: source.qualifiedName,
        ...(rule.method === 'renamed' ? { shapeHash: born.shape } : {}),
      },
    },
  });
}
