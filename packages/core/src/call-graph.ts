import {
  analysisFiles,
  currentSymbols,
  deleteCallEvidence,
  deleteRelationsByProducer,
  fileImportEdges,
  listRepositoryCalls,
  recordEvidence,
  recordRelation,
  type CallableSymbol,
  type FossilDb,
  type RepositoryCall,
} from '@codefossil/db';
import type { EntityRef, EvidenceLevel } from '@codefossil/shared';

export const CALL_RESOLVER_PRODUCER = 'call-resolver@0.1.0';

/** A callee defined in the calling file: the name is unambiguous there. */
const SAME_FILE_CONFIDENCE = 1;
/** A uniquely named definition in a file the caller imports. */
const IMPORTED_FILE_CONFIDENCE = 0.9;
/** `utils.flatten()` with `utils` named after an imported file that defines `flatten`. */
const IMPORTED_MODULE_CONFIDENCE = 0.8;
/** Only the qualified name matches (`res.send` called on a parameter named `res`). */
const QUALIFIED_NAME_CONFIDENCE = 0.6;
/** Receivers that mean "this object" inside a method. */
const SELF = new Set(['this', 'self']);

interface Resolved {
  readonly target: CallableSymbol;
  readonly level: EvidenceLevel;
  readonly confidence: number;
  readonly method: string;
}

export interface CallGraphResult {
  /** Distinct calls considered. */
  readonly calls: number;
  /** `CALLS` edges recorded. */
  readonly callEdges: number;
}

class SymbolIndex {
  readonly byFileKey = new Map<string, CallableSymbol>();
  readonly byFile = new Map<number, CallableSymbol[]>();
  readonly byQualifiedName = new Map<string, CallableSymbol[]>();

  constructor(
    symbols: readonly CallableSymbol[],
    private readonly paths: ReadonlyMap<number, string>,
  ) {
    for (const symbol of symbols) {
      this.byFileKey.set(`${String(symbol.fileId)}\0${symbol.stableKey}`, symbol);
      this.byFile.set(symbol.fileId, [...(this.byFile.get(symbol.fileId) ?? []), symbol]);
      const named = this.byQualifiedName.get(symbol.qualifiedName) ?? [];
      named.push(symbol);
      this.byQualifiedName.set(symbol.qualifiedName, named);
    }
  }

  inFile(fileId: number, qualifiedName: string): CallableSymbol[] {
    return (this.byFile.get(fileId) ?? []).filter((s) => s.qualifiedName === qualifiedName);
  }

  /** Whether a file is named `name` (`utils.js`), or is the index of a directory of that name. */
  fileNamed(fileId: number, name: string): boolean {
    const path = this.paths.get(fileId);
    if (!path) return false;
    const parts = path.split('/');
    const base = (parts.at(-1) ?? '').replace(/\.[^.]+$/, '');
    return base === name || (/^(index|__init__|mod)$/.test(base) && parts.at(-2) === name);
  }
}

/** The one element, or null when there are none or several: ambiguity is never guessed. */
const only = <T>(items: readonly T[]): T | null => (items.length === 1 ? (items[0] ?? null) : null);

function resolveCall(
  call: RepositoryCall,
  caller: CallableSymbol | null,
  index: SymbolIndex,
  imported: ReadonlySet<number>,
): Resolved | null {
  const path = call.callee.split('.');
  const name = path.at(-1) ?? '';
  if (name === '' || name === '*') return null;
  const [receiver] = path;

  // `this.save()` inside `Cart.checkout` is `Cart.save` in the same file.
  if (path.length === 2 && receiver && SELF.has(receiver) && caller) {
    const owner = caller.qualifiedName.split('.').slice(0, -1).join('.');
    const target = owner ? only(index.inFile(call.fileId, `${owner}.${name}`)) : null;
    if (target) return { target, level: 'DERIVED', confidence: 1, method: 'same-class' };
    return null;
  }
  if (!path.includes('*')) {
    const local = only(index.inFile(call.fileId, call.callee));
    if (local) {
      return {
        target: local,
        level: 'DERIVED',
        confidence: SAME_FILE_CONFIDENCE,
        method: 'same-file',
      };
    }
  }
  // `flatten()`: a definition named `flatten` in a file this file imports. `utils.flatten()`
  // only when the receiver is named after that file (`utils.js`, `utils/index.js`):
  // `items.map()` must not reach an imported `map`.
  if (path.length <= 2 && receiver && !SELF.has(receiver)) {
    const files =
      path.length === 1 ? [...imported] : [...imported].filter((f) => index.fileNamed(f, receiver));
    const target = only(files.flatMap((fileId) => index.inFile(fileId, name)));
    if (target) {
      return {
        target,
        level: 'DERIVED',
        confidence: path.length === 1 ? IMPORTED_FILE_CONFIDENCE : IMPORTED_MODULE_CONFIDENCE,
        method: path.length === 1 ? 'imported-file-name' : 'imported-module-member',
      };
    }
  }
  // `res.send()` anywhere: only the full qualified name ties it to a definition.
  if (path.length >= 2 && !path.includes('*')) {
    const target = only(index.byQualifiedName.get(call.callee) ?? []);
    if (target) {
      return {
        target,
        level: 'INFERRED',
        confidence: QUALIFIED_NAME_CONFIDENCE,
        method: 'qualified-name',
      };
    }
  }
  return null;
}

/**
 * Rebuild `CALLS` edges from the call sites stored for HEAD. A call resolves
 * only when one definition fits: in the same file or class (DERIVED), by a
 * unique name in a file the caller imports (DERIVED, 0.9), or by a unique
 * qualified name anywhere (INFERRED, 0.6). Module-level calls come from the
 * file. Each edge cites the call site.
 */
export function rebuildCallEdges(
  db: FossilDb,
  repositoryId: number,
  observedAt: string,
): CallGraphResult {
  deleteRelationsByProducer(db, repositoryId, CALL_RESOLVER_PRODUCER);
  deleteCallEvidence(db, repositoryId);

  const calls = listRepositoryCalls(db, repositoryId);
  const paths = new Map(
    analysisFiles(db, repositoryId).map((file) => [file.id, file.path] as const),
  );
  const index = new SymbolIndex(currentSymbols(db, repositoryId), paths);
  const importsOf = new Map<number, Set<number>>();
  for (const edge of fileImportEdges(db, repositoryId)) {
    const targets = importsOf.get(edge.source) ?? new Set<number>();
    targets.add(edge.target);
    importsOf.set(edge.source, targets);
  }

  const edges = new Map<string, { source: EntityRef; resolved: Resolved; call: RepositoryCall }>();
  for (const call of calls) {
    const caller =
      call.callerKey === null
        ? null
        : (index.byFileKey.get(`${String(call.fileId)}\0${call.callerKey}`) ?? null);
    const resolved = resolveCall(call, caller, index, importsOf.get(call.fileId) ?? new Set());
    if (!resolved || resolved.target.id === caller?.id) continue;
    const source: EntityRef = caller
      ? { type: 'symbol', id: caller.id }
      : { type: 'file', id: call.fileId };
    const key = `${source.type}:${String(source.id)}>${String(resolved.target.id)}`;
    const known = edges.get(key);
    if (!known || resolved.confidence > known.resolved.confidence) {
      edges.set(key, { source, resolved, call });
    }
  }

  for (const { source, resolved, call } of edges.values()) {
    const evidence = recordEvidence(db, {
      repositoryId,
      type: 'ast_node',
      locator: `${call.path}@${call.sha}#L${String(call.line)}`,
      excerpt: `call ${call.callee}`,
      metadata: { snapshot: 'calls' },
    });
    recordRelation(db, {
      repositoryId,
      source,
      relation: 'CALLS',
      target: { type: 'symbol', id: resolved.target.id },
      evidenceType: resolved.level,
      confidence: resolved.confidence,
      provenance: {
        producer: CALL_RESOLVER_PRODUCER,
        method: resolved.method,
        evidenceIds: [evidence.id],
        observedAt,
      },
    });
  }
  return { calls: calls.length, callEdges: edges.size };
}
