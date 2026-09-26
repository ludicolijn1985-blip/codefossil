import { z } from 'zod';
import {
  allRelations,
  entityKey,
  incomingRelations,
  loadEvidenceRecords,
  outgoingRelations,
  type EntityRecord,
  type FossilDb,
  type RelationRow,
} from '@codefossil/db';
import {
  entityTypeSchema,
  evidenceKindSchema,
  evidenceLevelSchema,
  provenanceSchema,
  relationTypeSchema,
  type EntityRef,
} from '@codefossil/shared';
import { describeEntities } from './describe.js';

export const GRAPH_FORMAT = 'codefossil.graph/v1';

const nodeSchema = z.object({
  /** `type:id`, unique within the document. */
  id: z.string(),
  type: entityTypeSchema,
  entityId: z.number().int().positive(),
  label: z.string(),
  /** Stored facts about the entity; empty when the entity no longer exists. */
  attributes: z.record(z.string(), z.unknown()),
});

const edgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  target: z.string(),
  relation: relationTypeSchema,
  evidenceType: evidenceLevelSchema,
  confidence: z.number().min(0).max(1),
  provenance: provenanceSchema,
});

const evidenceSchema = z.object({
  id: z.number().int().positive(),
  type: evidenceKindSchema,
  locator: z.string(),
  excerpt: z.string().nullable(),
});

/** The exported evidence graph. Validated on export and usable to validate imports. */
export const graphDocumentSchema = z.object({
  format: z.literal(GRAPH_FORMAT),
  generatedAt: z.iso.datetime(),
  repository: z.object({ name: z.string(), path: z.string() }),
  scope: z.object({
    root: z.string().nullable(),
    depth: z.number().int().nonnegative().nullable(),
    /** Why the document may be incomplete; empty when it holds the whole scope. */
    truncated: z.array(z.string()),
  }),
  nodes: z.array(nodeSchema),
  edges: z.array(edgeSchema),
  evidence: z.array(evidenceSchema),
});
export type GraphDocument = z.infer<typeof graphDocumentSchema>;

export interface ExportOptions {
  readonly repository: { readonly name: string; readonly path: string };
  /** Export only the neighbourhood of this entity; omit for the whole graph. */
  readonly root?: EntityRef;
  /** Hops from the root, in either direction (default 2). */
  readonly depth?: number;
  /** Largest neighbourhood exported around a root (default 5000 nodes). */
  readonly maxNodes?: number;
  readonly now?: () => Date;
}

/** An entity's stored facts without the identity already carried by the node. */
function attributesOf(record: EntityRecord | null): Record<string, unknown> {
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => key !== 'type' && key !== 'id'),
  );
}

/** Relations within `depth` hops of `root`, following edges in both directions. */
function neighbourhood(
  db: FossilDb,
  repositoryId: number,
  root: EntityRef,
  depth: number,
  maxNodes: number,
): { relations: RelationRow[]; truncated: string[] } {
  const seen = new Map([[entityKey(root), root]]);
  const relations = new Map<number, RelationRow>();
  const truncated: string[] = [];
  let frontier: EntityRef[] = [root];
  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: EntityRef[] = [];
    for (const node of frontier) {
      for (const row of [
        ...outgoingRelations(db, repositoryId, node),
        ...incomingRelations(db, repositoryId, node),
      ]) {
        const ends = [
          { type: row.sourceType, id: row.sourceId },
          { type: row.targetType, id: row.targetId },
        ];
        const fresh = ends.filter((end) => !seen.has(entityKey(end)));
        if (seen.size + fresh.length > maxNodes) {
          if (truncated.length === 0) truncated.push(`stopped at ${maxNodes} nodes`);
          continue;
        }
        relations.set(row.id, row);
        for (const end of fresh) {
          seen.set(entityKey(end), end);
          next.push(end);
        }
      }
    }
    frontier = next;
  }
  // Include every relation between exported nodes, so a node cap can never
  // leave two exported, related nodes looking unrelated.
  for (const node of seen.values()) {
    for (const row of outgoingRelations(db, repositoryId, node)) {
      if (seen.has(`${row.targetType}:${row.targetId}`)) relations.set(row.id, row);
    }
  }
  return { relations: [...relations.values()], truncated };
}

/**
 * Export the evidence graph — every node, every edge with its provenance, and
 * the evidence the edges cite — as a self-contained, schema-validated document.
 */
export function exportGraph(
  db: FossilDb,
  repositoryId: number,
  options: ExportOptions,
): GraphDocument {
  const depth = options.root ? (options.depth ?? 2) : null;
  const { relations, truncated } = options.root
    ? neighbourhood(db, repositoryId, options.root, depth ?? 2, options.maxNodes ?? 5000)
    : { relations: allRelations(db, repositoryId), truncated: [] };

  const refs = new Map<string, EntityRef>();
  if (options.root) refs.set(entityKey(options.root), options.root);
  for (const row of relations) {
    refs.set(`${row.sourceType}:${row.sourceId}`, { type: row.sourceType, id: row.sourceId });
    refs.set(`${row.targetType}:${row.targetId}`, { type: row.targetType, id: row.targetId });
  }
  const descriptions = describeEntities(db, [...refs.values()]);
  const nodes = [...refs.values()].map((ref) => {
    const description = descriptions.get(entityKey(ref));
    return {
      id: entityKey(ref),
      type: ref.type,
      entityId: ref.id,
      label: description?.label ?? entityKey(ref),
      attributes: attributesOf(description?.record ?? null),
    };
  });

  const evidenceIds = relations.flatMap((row) => row.provenanceJson.evidenceIds);
  const evidence = [...loadEvidenceRecords(db, evidenceIds).values()].map((row) => ({
    id: row.id,
    type: row.type,
    locator: row.locator,
    excerpt: row.excerpt,
  }));

  return graphDocumentSchema.parse({
    format: GRAPH_FORMAT,
    generatedAt: (options.now ?? (() => new Date()))().toISOString(),
    repository: options.repository,
    scope: { root: options.root ? entityKey(options.root) : null, depth, truncated },
    nodes,
    edges: relations.map((row) => ({
      id: `relation:${row.id}`,
      source: `${row.sourceType}:${row.sourceId}`,
      target: `${row.targetType}:${row.targetId}`,
      relation: row.relation,
      evidenceType: row.evidenceType,
      confidence: row.confidence,
      provenance: row.provenanceJson,
    })),
    evidence,
  });
}
