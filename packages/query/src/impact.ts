import { entityKey, loadEntityRecords, type FossilDb } from '@codefossil/db';
import type { EntityRef, EvidenceLevel } from '@codefossil/shared';
import { describeEntities } from './describe.js';
import { CALLERS_ROUTE, IMPACT_ROUTE } from './routes.js';
import { traverse, weakestLevel } from './traverse.js';

/** Paths that are tests by the usual conventions of the supported languages. */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;

export const isTestPath = (path: string): boolean => TEST_PATH.test(path);

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

const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * What depends on the target: files importing it directly, and files
 * reaching it through a chain of imports, each with its shortest route.
 * For a symbol the analysis is file-level — it starts from the file that
 * defines the symbol, since call-level edges are not indexed.
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
  const all = bestDependents(result.paths, extraHop, new Set(['file']), label, isTest);
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
        'uniquely named definition in an imported file, or a unique qualified name (INFERRED). ' +
        'Calls through variables, callbacks and dynamic dispatch are not seen, so callers can be missing.',
      'Files are counted when they import the file that defines the symbol, whether or not they call it.',
    );
  }

  const fileSentence =
    all.length === 0
      ? result.truncated.length > 0
        ? `No dependents of ${targetLabel} were found within the analysed bounds (see notes).`
        : `Nothing in the index depends on ${targetLabel}.`
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
    truncated: [...result.truncated, ...(callResult?.truncated ?? [])],
    caveats,
  };
}
