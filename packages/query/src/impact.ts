import {
  entityKey,
  importBindingsByEvidence,
  listFileSymbols,
  loadEntityRecords,
  type EntityRecord,
  type FossilDb,
} from '@codefossil/db';
import type { EntityRef, EvidenceLevel } from '@codefossil/shared';
import { describeEntities } from './describe.js';
import { CALLERS_ROUTE, IMPACT_ROUTE } from './routes.js';
import { traverse, weakestLevel } from './traverse.js';

/** Paths that are tests by the usual conventions of the supported languages. */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;
/** `CartTest.java`, `CartTests.cs`, `CartSpec.php`: case matters (`latest.java` is no test). */
const TEST_CLASS = /[a-z0-9](Tests?|Spec)\.(java|kt|cs|php)$/;

export const isTestPath = (path: string): boolean => TEST_PATH.test(path) || TEST_CLASS.test(path);

export interface Dependent {
  readonly key: string;
  readonly label: string;
  /** Hops from the target: 1 = imports (or calls) it directly. */
  readonly distance: number;
  /** Labels of the files (or callers) between the target and this dependent. */
  readonly via: readonly string[];
  readonly confidence: number;
  readonly level: EvidenceLevel;
  readonly isTest: boolean;
  readonly evidenceIds: readonly number[];
}

export interface ImpactReport {
  readonly kind: 'impact';
  readonly question: string;
  readonly target: { readonly key: string; readonly label: string };
  /** For a symbol, the file that defines it (impact is measured from there). */
  readonly definedIn: { readonly key: string; readonly label: string } | null;
  readonly direct: readonly Dependent[];
  readonly transitive: readonly Dependent[];
  /**
   * For a symbol, the functions (or files, at module level) that call it,
   * directly and through other calls; null for files and dependencies.
   */
  readonly callers: {
    readonly direct: readonly Dependent[];
    readonly transitive: readonly Dependent[];
  } | null;
  readonly answer: string;
  readonly confidence: number;
  readonly classification: EvidenceLevel;
  readonly truncated: readonly string[];
  readonly caveats: readonly string[];
}

const DEFAULT_DEPTH = 5;

/**
 * The best (shortest, then most confident) route to each node of the given
 * types, skipping the first `skip` nodes of every path.
 */
function bestDependents(
  paths: ReturnType<typeof traverse>['paths'],
  skip: number,
  types: ReadonlySet<EntityRef['type']>,
  label: (ref: EntityRef) => string,
  isTest: (ref: EntityRef) => boolean,
): Dependent[] {
  const best = new Map<string, Dependent>();
  for (const path of paths) {
    for (let i = 1 + skip; i < path.nodes.length; i++) {
      const node = path.nodes[i];
      if (!node || !types.has(node.type)) continue;
      const edges = path.edges.slice(0, i);
      const candidate: Dependent = {
        key: entityKey(node),
        label: label(node),
        distance: i - skip,
        via: path.nodes.slice(1 + skip, i).map(label),
        confidence: edges.reduce((c, e) => c * e.confidence, 1),
        level: weakestLevel(edges.map((e) => e.evidenceType)),
        isTest: isTest(node),
        evidenceIds: edges.flatMap((e) => e.provenance.evidenceIds),
      };
      const current = best.get(candidate.key);
      if (
        !current ||
        candidate.distance < current.distance ||
        (candidate.distance === current.distance && candidate.confidence > current.confidence)
      ) {
        best.set(candidate.key, candidate);
      }
    }
  }
  return [...best.values()].sort(
    (a, b) => a.distance - b.distance || a.label.localeCompare(b.label),
  );
}

/**
 * Whether an imported name (`imported` of an import binding into the
 * defining file) may give access to the symbol `qualified`: the whole module
 * or its default export, the symbol itself, its container (`Cart` for
 * `Cart.total`), a member of it, or a name the defining file does not define
 * (a submodule, an alias, a re-export), which could be anything. Only a name
 * that is another definition of that file is known not to reach it.
 */
export function bindingMayReach(
  imported: string,
  qualified: string,
  defined: ReadonlySet<string>,
): boolean {
  return (
    imported === '*' ||
    imported === 'default' ||
    imported === qualified ||
    qualified.startsWith(`${imported}.`) ||
    imported.startsWith(`${qualified}.`) ||
    !defined.has(imported)
  );
}

/**
 * Import paths from a symbol, without those through a file whose imports of
 * the defining file name only other things (`import { b } from './a'` does not
 * use `a`). A statement binding no names, the whole module (`*`) or its
 * default export may use anything, so it is kept.
 */
function importersOfSymbol(
  db: FossilDb,
  symbol: EntityRecord | undefined,
  paths: ReturnType<typeof traverse>['paths'],
): { paths: ReturnType<typeof traverse>['paths']; skipped: number } {
  if (symbol?.type !== 'symbol') return { paths, skipped: 0 };
  const qualified = symbol.qualifiedName;
  // Names the defining file defines: a binding naming one of them (other than the symbol)
  // names something else; a binding naming none (a submodule, an alias) may reach anything.
  const definingFile = paths[0]?.nodes[1];
  const defined = new Set(
    definingFile?.type === 'file'
      ? listFileSymbols(db, definingFile.id).map((s) => s.qualifiedName)
      : [],
  );
  const reaches = (imported: string) => bindingMayReach(imported, qualified, defined);
  // paths are [symbol, defining file, importer, ...]; edges[1] is the importer's IMPORTS edge.
  const evidenceIds = paths.flatMap((path) => path.edges[1]?.provenance.evidenceIds ?? []);
  const bindings = importBindingsByEvidence(db, evidenceIds);
  const uses = (ids: readonly number[]): boolean =>
    ids.length === 0 ||
    ids.some((id) => {
      const bound = bindings.get(id);
      return bound === undefined || bound === null || bound.some((b) => reaches(b.imported));
    });
  const skippedFiles = new Set<string>();
  const kept = paths.filter((path) => {
    const edge = path.edges[1];
    const importer = path.nodes[2];
    if (!edge || !importer || uses(edge.provenance.evidenceIds)) return true;
    skippedFiles.add(entityKey(importer));
    return false;
  });
  return { paths: kept, skipped: skippedFiles.size };
}

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * What depends on the target: files importing it directly, and files
 * reaching it through a chain of imports, each with its shortest route.
 * For a symbol: first the functions that call it (statically resolved `CALLS`
 * edges, transitively), then the files importing the file that defines it.
 */
export function analyzeImpact(
  db: FossilDb,
  repositoryId: number,
  target: EntityRef,
  options: { readonly depth?: number; readonly question?: string } = {},
): ImpactReport {
  const depth = options.depth ?? DEFAULT_DEPTH;
  const extraHop = target.type === 'symbol' ? 1 : 0;
  const result = traverse(db, repositoryId, target, IMPACT_ROUTE, {
    maxDepth: depth + extraHop,
    maxPaths: 2000,
    maxFanOut: 1000,
  });
  const callResult =
    target.type === 'symbol'
      ? traverse(db, repositoryId, target, CALLERS_ROUTE, {
          maxDepth: depth,
          maxPaths: 2000,
          maxFanOut: 1000,
        })
      : null;
  const refs = [
    target,
    ...result.paths.flatMap((p) => p.nodes),
    ...(callResult?.paths.flatMap((p) => p.nodes) ?? []),
  ];
  const labels = describeEntities(db, refs);
  const label = (ref: EntityRef) => labels.get(entityKey(ref))?.label ?? entityKey(ref);
  const records = loadEntityRecords(db, refs);
  const isTest = (ref: EntityRef) => {
    const record = records.get(entityKey(ref));
    return record !== undefined && 'path' in record && isTestPath(record.path);
  };

  const definedIn = target.type === 'symbol' ? result.paths[0]?.nodes[1] : undefined;
  const importers = importersOfSymbol(db, records.get(entityKey(target)), result.paths);
  const all = bestDependents(importers.paths, extraHop, new Set(['file']), label, isTest);
  const direct = all.filter((d) => d.distance === 1);
  const transitive = all.filter((d) => d.distance > 1);
  const tests = all.filter((d) => d.isTest).length;
  const callers = callResult
    ? bestDependents(callResult.paths, 0, new Set(['symbol', 'file']), label, isTest)
    : null;
  const targetLabel = label(target);

  const caveats = [
    'Only imports that were resolved at HEAD count; see `codefossil deps <file>` for unresolved ones.',
  ];
  if (target.type === 'symbol' && !definedIn) {
    caveats.unshift(
      'No file is recorded as defining this symbol, so nothing could be traced from it.',
    );
  }
  if (target.type === 'symbol') {
    caveats.unshift(
      'Calls are resolved at HEAD only where one definition fits: in the same file or class, a ' +
        'uniquely named definition in an imported file, a name whose type the code states ' +
        '(`new Repo()`, `repo: Repo`), or a unique qualified name (INFERRED). Functions passed by ' +
        'name count as INFERRED callers. Other calls through variables and dynamic dispatch are not ' +
        'seen, so callers can be missing.',
      'Files are counted when they import the defining file and do not name only other things ' +
        'from it; one importing the whole module counts whether or not it uses the symbol.',
    );
    if (importers.skipped > 0) {
      caveats.push(
        `${plural(importers.skipped, 'file imports', 'files import')} only other names from the ` +
          'defining file and is left out, with what depends on it through that import.',
      );
    }
  }

  const fileSentence =
    all.length === 0
      ? result.truncated.length > 0
        ? `No dependents of ${targetLabel} were found within the analysed bounds (see notes).`
        : `Nothing in the index depends on ${targetLabel}.`
      : target.type === 'symbol'
        ? `${plural(direct.length, 'file imports', 'files import')} the file that defines it directly and ${String(transitive.length)} transitively (${String(tests)} of them tests).`
        : `${plural(direct.length, 'file depends', 'files depend')} on ${targetLabel} directly and ${String(transitive.length)} transitively (${String(tests)} of them tests).`;
  const callSentence = !callers
    ? ''
    : callers.length === 0
      ? 'No call to it was resolved. '
      : `${plural(
          callers.filter((c) => c.distance === 1).length,
          'caller calls it',
          'callers call it',
        )} directly and ${String(callers.filter((c) => c.distance > 1).length)} through other calls (${String(callers.filter((c) => c.isTest).length)} in tests). `;
  const everything = [...all, ...(callers ?? [])];
  return {
    kind: 'impact',
    question: options.question ?? `What depends on ${targetLabel}?`,
    target: { key: entityKey(target), label: targetLabel },
    definedIn: definedIn ? { key: entityKey(definedIn), label: label(definedIn) } : null,
    direct,
    transitive,
    callers: callers
      ? {
          direct: callers.filter((c) => c.distance === 1),
          transitive: callers.filter((c) => c.distance > 1),
        }
      : null,
    answer: `${callSentence}${fileSentence}`,
    confidence: everything.length === 0 ? 1 : Math.min(...everything.map((d) => d.confidence)),
    classification: weakestLevel(everything.map((d) => d.level)),
    truncated: [
      ...result.truncated.map((t) => (callResult ? `imports: ${t}` : t)),
      ...(callResult?.truncated ?? []).map((t) => `calls: ${t}`),
    ],
    caveats,
  };
}
