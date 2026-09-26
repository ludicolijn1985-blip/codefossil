import {
  entityKey,
  incomingRelations,
  outgoingRelations,
  type FossilDb,
  type RelationRow,
} from '@codefossil/db';
import type {
  EntityRef,
  EntityType,
  EvidenceLevel,
  Provenance,
  RelationType,
} from '@codefossil/shared';

export type Direction = 'out' | 'in';

/** One allowed move from a node: follow `relation` forwards (out) or backwards (in). */
export interface Step {
  readonly relation: RelationType;
  readonly direction: Direction;
  /** Only continue to neighbours of these types. */
  readonly to?: readonly EntityType[];
}

/** For each node type, the steps a traversal may take from it. */
export type StepTable = Readonly<Partial<Record<EntityType, readonly Step[]>>>;

export interface PathEdge {
  readonly relationId: number;
  readonly relation: RelationType;
  /** How the edge was walked: `out` = stored direction, `in` = against it. */
  readonly direction: Direction;
  readonly from: EntityRef;
  readonly to: EntityRef;
  readonly evidenceType: EvidenceLevel;
  readonly confidence: number;
  readonly provenance: Provenance;
}

export interface EvidencePath {
  readonly nodes: readonly EntityRef[];
  readonly edges: readonly PathEdge[];
  /** Product of the edge confidences: every link must hold for the chain to hold. */
  readonly confidence: number;
  /** The weakest evidence level on the path (FACT < DERIVED < INFERRED). */
  readonly level: EvidenceLevel;
}

export interface TraversalOptions {
  readonly maxDepth?: number;
  readonly maxPaths?: number;
  /** Most edges followed from one node for one step; the rest are reported as truncated. */
  readonly maxFanOut?: number;
  /** Paths whose confidence falls below this are not followed further. */
  readonly minConfidence?: number;
}

export interface TraversalResult {
  readonly start: EntityRef;
  /** Maximal paths: each ends where no allowed step continues, or at maxDepth. */
  readonly paths: readonly EvidencePath[];
  /** Why the result may be incomplete; empty when it is complete. */
  readonly truncated: readonly string[];
}

const LEVEL_RANK: Readonly<Record<EvidenceLevel, number>> = { FACT: 0, DERIVED: 1, INFERRED: 2 };

export function weakestLevel(levels: readonly EvidenceLevel[]): EvidenceLevel {
  return levels.reduce<EvidenceLevel>(
    (weakest, level) => (LEVEL_RANK[level] > LEVEL_RANK[weakest] ? level : weakest),
    'FACT',
  );
}

const DEFAULTS = { maxDepth: 4, maxPaths: 50, maxFanOut: 25, minConfidence: 0 } as const;

interface OpenPath {
  readonly nodes: EntityRef[];
  readonly edges: PathEdge[];
  readonly confidence: number;
}

/** Order candidate edges: strongest first, then most recently recorded. */
function byStrength(a: PathEdge, b: PathEdge): number {
  return b.confidence - a.confidence || b.relationId - a.relationId;
}

function toEdge(row: RelationRow, direction: Direction): PathEdge {
  const source = { type: row.sourceType, id: row.sourceId };
  const target = { type: row.targetType, id: row.targetId };
  return {
    relationId: row.id,
    relation: row.relation,
    direction,
    from: direction === 'out' ? source : target,
    to: direction === 'out' ? target : source,
    evidenceType: row.evidenceType,
    confidence: row.confidence,
    provenance: row.provenanceJson,
  };
}

/**
 * Walk the evidence graph from `start`, taking only the steps `steps` allows
 * for each node type. Breadth-first, cycle-free per path and bounded in
 * depth, fan-out and number of paths — whatever the bounds cut off is listed
 * in `truncated`, so a partial answer is never presented as complete.
 */
export function traverse(
  db: FossilDb,
  repositoryId: number,
  start: EntityRef,
  steps: StepTable,
  options: TraversalOptions = {},
): TraversalResult {
  const { maxDepth, maxPaths, maxFanOut, minConfidence } = { ...DEFAULTS, ...options };
  const truncated = new Set<string>();
  const cache = new Map<string, RelationRow[]>();
  const neighbours = (ref: EntityRef, direction: Direction): RelationRow[] => {
    const key = `${direction}|${entityKey(ref)}`;
    let rows = cache.get(key);
    if (!rows) {
      rows =
        direction === 'out'
          ? outgoingRelations(db, repositoryId, ref)
          : incomingRelations(db, repositoryId, ref);
      cache.set(key, rows);
    }
    return rows;
  };

  const paths: EvidencePath[] = [];
  const finish = (partial: OpenPath) => {
    if (partial.edges.length === 0) return;
    paths.push({
      nodes: partial.nodes,
      edges: partial.edges,
      confidence: partial.confidence,
      level: weakestLevel(partial.edges.map((e) => e.evidenceType)),
    });
  };

  /** Edges each step allows from the end of `partial`, per step, strongest first. */
  const candidatesFor = (partial: OpenPath): { step: Step; edges: PathEdge[] }[] => {
    const node = partial.nodes.at(-1) ?? start;
    const onPath = new Set(partial.nodes.map(entityKey));
    return (steps[node.type] ?? []).map((step) => ({
      step,
      edges: neighbours(node, step.direction)
        .filter((row) => row.relation === step.relation)
        .map((row) => toEdge(row, step.direction))
        .filter((edge) => !step.to || step.to.includes(edge.to.type))
        .filter((edge) => !onPath.has(entityKey(edge.to)))
        .sort(byStrength),
    }));
  };

  let frontier: OpenPath[] = [{ nodes: [start], edges: [], confidence: 1 }];
  for (let depth = 0; frontier.length > 0; depth++) {
    const next: OpenPath[] = [];
    for (const partial of frontier) {
      const node = partial.nodes.at(-1) ?? start;
      const options = candidatesFor(partial);
      // Only report a cut when something was actually there to follow.
      if (depth >= maxDepth) {
        if (options.some((o) => o.edges.length > 0)) truncated.add(`stopped at depth ${maxDepth}`);
        finish(partial);
        continue;
      }
      const extensions: PathEdge[] = [];
      for (const { step, edges } of options) {
        if (edges.length > maxFanOut) {
          truncated.add(
            `${step.relation} (${step.direction}) from ${entityKey(node)}: followed ${maxFanOut} of ${edges.length}`,
          );
        }
        extensions.push(...edges.slice(0, maxFanOut));
      }

      const continued = extensions
        .map((edge) => ({
          nodes: [...partial.nodes, edge.to],
          edges: [...partial.edges, edge],
          confidence: partial.confidence * edge.confidence,
        }))
        .filter((extended) => extended.confidence >= minConfidence);
      if (continued.length < extensions.length) {
        truncated.add(`links below confidence ${minConfidence} were not followed`);
      }
      if (continued.length === 0) finish(partial);
      next.push(...continued);
    }
    if (paths.length + next.length > maxPaths * 4) {
      truncated.add(`more than ${maxPaths} paths; kept the strongest`);
      next.sort((a, b) => b.confidence - a.confidence).splice(maxPaths * 4);
    }
    frontier = next;
  }

  paths.sort((a, b) => b.confidence - a.confidence || b.edges.length - a.edges.length);
  if (paths.length > maxPaths) {
    truncated.add(`more than ${maxPaths} paths; kept the strongest`);
    paths.splice(maxPaths);
  }
  return { start, paths, truncated: [...truncated] };
}
