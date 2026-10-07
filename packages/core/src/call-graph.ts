import {
  callEvidenceByLocator,
  currentSymbols,
  deleteCallEvidence,
  deleteRelationsByProducer,
  listRepositoryCalls,
  recordEvidence,
  recordRelation,
  type CallableSymbol,
  type FossilDb,
  type RepositoryCall,
} from '@codefossil/db';
import type { EntityRef, EvidenceLevel } from '@codefossil/shared';

export const CALL_RESOLVER_PRODUCER = 'call-resolver@0.2.0';
/** Earlier versions whose edges a rebuild replaces. */
const LEGACY_PRODUCERS = ['call-resolver@0.1.0'];

/** A name bound by an import: what it imports, and the repository files the import resolved to. */
export interface ImportBinding {
  /** The imported name, `*` for the whole module, `default` for a default export. */
  readonly imported: string;
  /** Empty when the import points outside the repository (a package, the standard library). */
  readonly targetFileIds: readonly number[];
  /** Confidence of the import's resolution. */
  readonly confidence: number;
}

/** Per file, the local names its imports bind. */
export type ImportBindings = ReadonlyMap<number, ReadonlyMap<string, ImportBinding>>;

/** `utils.sum()` or `sum()` through an import binding that resolved to the defining file. */
const IMPORT_BINDING_CONFIDENCE = 0.95;
/** Only the full qualified name ties the call to a definition (`res.send()` on a parameter). */
const QUALIFIED_NAME_CONFIDENCE = 0.6;

interface Resolved {
  readonly target: CallableSymbol;
  readonly level: EvidenceLevel;
  readonly confidence: number;
  readonly method: string;
}

export interface CallGraphResult {
  /** Distinct call sites considered. */
  readonly calls: number;
  /** `CALLS` edges recorded. */
  readonly callEdges: number;
}

/** Current symbols by file and qualified name, and by qualified name across the repository. */
class SymbolIndex {
  private readonly byFileKey = new Map<string, CallableSymbol>();
  private readonly byFileName = new Map<string, CallableSymbol[]>();
  private readonly byName = new Map<string, CallableSymbol[]>();

  constructor(symbols: readonly CallableSymbol[]) {
    for (const symbol of symbols) {
      this.byFileKey.set(`${String(symbol.fileId)}\0${symbol.stableKey}`, symbol);
      push(this.byFileName, `${String(symbol.fileId)}\0${symbol.qualifiedName}`, symbol);
      push(this.byName, symbol.qualifiedName, symbol);
    }
  }

  caller(fileId: number, stableKey: string): CallableSymbol | undefined {
    return this.byFileKey.get(`${String(fileId)}\0${stableKey}`);
  }

  inFile(fileId: number, qualifiedName: string): readonly CallableSymbol[] {
    return this.byFileName.get(`${String(fileId)}\0${qualifiedName}`) ?? [];
  }

  anywhere(qualifiedName: string): readonly CallableSymbol[] {
    return this.byName.get(qualifiedName) ?? [];
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** The one element, or null when there are none or several: ambiguity is never guessed. */
const only = <T>(items: readonly T[]): T | null => (items.length === 1 ? (items[0] ?? null) : null);

const derived = (target: CallableSymbol | null, confidence: number, method: string) =>
  target ? { target, level: 'DERIVED' as const, confidence, method } : null;

/**
 * Resolve one call site. The first name of the callee decides which rule
 * may apply, in this order:
 * - the caller's own object (`this.save()` in a method): the class's `save`;
 * - a parameter or local variable: only the qualified-name rule (INFERRED);
 * - a name an import binds: the imported definition in the resolved file, or
 *   nothing — a bound name never falls back to a same-named definition;
 * - otherwise a definition of that name in the same file;
 * - finally, for `a.b()`, a unique definition named `a.b` anywhere (INFERRED).
 */
function resolveCall(
  call: RepositoryCall,
  caller: CallableSymbol | null,
  index: SymbolIndex,
  bindings: ReadonlyMap<string, ImportBinding>,
): Resolved | null {
  const path = call.callee.split('.');
  const [head = '', ...rest] = path;
  const name = path.at(-1) ?? '';
  if (name === '' || name === '*' || head === '*') return null;

  if (call.selfReceiver) {
    if (!caller || path.length !== 2) return null;
    const owner = caller.qualifiedName.split('.').slice(0, -1).join('.');
    return owner
      ? derived(only(index.inFile(call.fileId, `${owner}.${name}`)), 1, 'same-class')
      : null;
  }

  const qualified = (): Resolved | null => {
    if (path.length < 2) return null;
    const target = only(index.anywhere(call.callee));
    return target
      ? {
          target,
          level: 'INFERRED',
          confidence: QUALIFIED_NAME_CONFIDENCE,
          method: 'qualified-name',
        }
      : null;
  };
  if (call.localHead) return qualified();

  const binding = bindings.get(head);
  if (binding) {
    // `sum()` from `import { sum }`, `utils.sum()` from `import * as utils`.
    // `sum()` from `import { sum }`; `utils.sum()` from `import * as utils`; and
    // `Rates.vat()` from a bound class (`import { Rates }`, Java `import a.Rates`).
    const named = binding.imported !== '*' && binding.imported !== 'default';
    const member =
      path.length === 1 && named
        ? binding.imported
        : path.length >= 2 && binding.imported === '*'
          ? rest.join('.')
          : path.length >= 2 && named
            ? [binding.imported, ...rest].join('.')
            : null;
    if (member === null) return null;
    const target = only(binding.targetFileIds.flatMap((fileId) => index.inFile(fileId, member)));
    return derived(
      target,
      Math.min(IMPORT_BINDING_CONFIDENCE, binding.confidence),
      'import-binding',
    );
  }

  const local = derived(only(index.inFile(call.fileId, call.callee)), 1, 'same-file');
  return local ?? qualified();
}

/**
 * Rebuild `CALLS` edges from the call sites stored for HEAD, each edge citing
 * its call site. Calls whose calling symbol is no longer in the index are
 * skipped, never attributed to the file; module-level calls come from the file.
 */
export function rebuildCallEdges(
  db: FossilDb,
  repositoryId: number,
  bindings: ImportBindings,
  observedAt: string,
): CallGraphResult {
  for (const producer of [CALL_RESOLVER_PRODUCER, ...LEGACY_PRODUCERS]) {
    deleteRelationsByProducer(db, repositoryId, producer);
  }
  const index = new SymbolIndex(currentSymbols(db, repositoryId));
  const calls = listRepositoryCalls(db, repositoryId);
  const none = new Map<string, ImportBinding>();

  const edges = new Map<string, { source: EntityRef; resolved: Resolved; call: RepositoryCall }>();
  for (const call of calls) {
    const caller = call.callerKey === null ? null : index.caller(call.fileId, call.callerKey);
    if (caller === undefined) continue;
    const resolved = resolveCall(call, caller, index, bindings.get(call.fileId) ?? none);
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

  // Cite the same evidence row for the same call site as earlier runs did.
  const previous = callEvidenceByLocator(db, repositoryId);
  const cited = new Set<number>();
  for (const { source, resolved, call } of edges.values()) {
    const locator = `${call.path}@${call.sha}#L${String(call.line)}`;
    const excerpt = `call ${call.callee}`;
    const evidenceId =
      previous.get(`${locator} ${excerpt}`) ??
      recordEvidence(db, {
        repositoryId,
        type: 'ast_node',
        locator,
        excerpt,
        metadata: { snapshot: 'calls' },
      }).id;
    cited.add(evidenceId);
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
        evidenceIds: [evidenceId],
        observedAt,
      },
    });
  }
  deleteCallEvidence(
    db,
    repositoryId,
    [...previous.values()].filter((id) => !cited.has(id)),
  );
  return { calls: calls.length, callEdges: edges.size };
}
