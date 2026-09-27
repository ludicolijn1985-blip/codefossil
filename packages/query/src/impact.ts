import { entityKey, type FossilDb } from '@codefossil/db';
import type { EntityRef, EvidenceLevel } from '@codefossil/shared';
import { describeEntities } from './describe.js';
import { IMPACT_ROUTE } from './routes.js';
import { traverse, weakestLevel } from './traverse.js';

/** Paths that are tests by the usual conventions of the supported languages. */
const TEST_PATH =
  /(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|_test\.go$/i;

export const isTestPath = (path: string): boolean => TEST_PATH.test(path);

export interface Dependent {
  readonly key: string;
  readonly label: string;
  /** Import hops from the target: 1 = imports it directly. */
  readonly distance: number;
  /** Labels of the files between the target and this dependent. */
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
  readonly answer: string;
  readonly confidence: number;
  readonly classification: EvidenceLevel;
  readonly truncated: readonly string[];
  readonly caveats: readonly string[];
}

const DEFAULT_DEPTH = 5;

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
  const refs = [target, ...result.paths.flatMap((p) => p.nodes)];
  const labels = describeEntities(db, refs);
  const label = (ref: EntityRef) => labels.get(entityKey(ref))?.label ?? entityKey(ref);

  const definedIn = target.type === 'symbol' ? result.paths[0]?.nodes[1] : undefined;
  const best = new Map<string, Dependent>();
  for (const path of result.paths) {
    for (let i = 1 + extraHop; i < path.nodes.length; i++) {
      const node = path.nodes[i];
      if (!node || node.type !== 'file') continue;
      const edges = path.edges.slice(0, i);
      const candidate: Dependent = {
        key: entityKey(node),
        label: label(node),
        distance: i - extraHop,
        via: path.nodes.slice(1 + extraHop, i).map(label),
        confidence: edges.reduce((c, e) => c * e.confidence, 1),
        level: weakestLevel(edges.map((e) => e.evidenceType)),
        isTest: isTestPath(label(node)),
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

  const all = [...best.values()].sort(
    (a, b) => a.distance - b.distance || a.label.localeCompare(b.label),
  );
  const direct = all.filter((d) => d.distance === 1);
  const transitive = all.filter((d) => d.distance > 1);
  const tests = all.filter((d) => d.isTest).length;
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
      'File-level analysis: dependents import the file that defines the symbol; whether they call the symbol itself is not checked.',
    );
  }
  return {
    kind: 'impact',
    question: options.question ?? `What depends on ${targetLabel}?`,
    target: { key: entityKey(target), label: targetLabel },
    definedIn: definedIn ? { key: entityKey(definedIn), label: label(definedIn) } : null,
    direct,
    transitive,
    answer:
      all.length === 0
        ? result.truncated.length > 0
          ? `No dependents of ${targetLabel} were found within the analysed bounds (see notes).`
          : `Nothing in the index depends on ${targetLabel}.`
        : `${direct.length} file${direct.length === 1 ? '' : 's'} depend${direct.length === 1 ? 's' : ''} on ${targetLabel} directly and ${transitive.length} transitively (${tests} of them tests).`,
    confidence: all.length === 0 ? 1 : Math.min(...all.map((d) => d.confidence)),
    classification: weakestLevel(all.map((d) => d.level)),
    truncated: result.truncated,
    caveats,
  };
}
