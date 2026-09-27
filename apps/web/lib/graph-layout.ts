export interface LayoutNode {
  readonly id: string;
  readonly type: string;
  readonly label: string;
}

export interface LayoutEdge {
  readonly source: string;
  readonly target: string;
}

export interface Position {
  readonly x: number;
  readonly y: number;
}

export const COLUMN_WIDTH = 300;
export const ROW_HEIGHT = 72;

/** Reading order within a column: the "why" story from motivation to code. */
const TYPE_ORDER = [
  'issue',
  'pull_request',
  'review',
  'commit',
  'repository',
  'file',
  'symbol',
  'dependency',
  'test',
  'incident',
];

const typeRank = (type: string): number => {
  const rank = TYPE_ORDER.indexOf(type);
  return rank === -1 ? TYPE_ORDER.length : rank;
};

/**
 * Place nodes in columns by their distance from the root (ignoring edge
 * direction), each column sorted by type then label and centred vertically.
 * Deterministic: the same graph always gets the same picture. Nodes not
 * connected to the root go in a final column.
 */
export function layoutGraph(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  rootId: string | null,
): Map<string, Position> {
  const neighbours = new Map<string, string[]>();
  for (const { source, target } of edges) {
    neighbours.set(source, [...(neighbours.get(source) ?? []), target]);
    neighbours.set(target, [...(neighbours.get(target) ?? []), source]);
  }

  const distance = new Map<string, number>();
  const start = rootId && nodes.some((n) => n.id === rootId) ? rootId : null;
  if (start) {
    distance.set(start, 0);
    const queue = [start];
    for (let current = queue.shift(); current !== undefined; current = queue.shift()) {
      const d = distance.get(current) ?? 0;
      for (const next of neighbours.get(current) ?? []) {
        if (!distance.has(next)) {
          distance.set(next, d + 1);
          queue.push(next);
        }
      }
    }
  }
  const unreached = Math.max(-1, ...distance.values()) + 1;

  const columns = new Map<number, LayoutNode[]>();
  for (const node of nodes) {
    // Without a root, group by type so the picture still reads left to right.
    const column = start ? (distance.get(node.id) ?? unreached) : typeRank(node.type);
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }

  const positions = new Map<string, Position>();
  const ordered = [...columns.keys()].sort((a, b) => a - b);
  ordered.forEach((column, columnIndex) => {
    const members = (columns.get(column) ?? []).sort(
      (a, b) => typeRank(a.type) - typeRank(b.type) || a.label.localeCompare(b.label),
    );
    const offset = ((members.length - 1) * ROW_HEIGHT) / 2;
    members.forEach((node, row) => {
      positions.set(node.id, { x: columnIndex * COLUMN_WIDTH, y: row * ROW_HEIGHT - offset });
    });
  });
  return positions;
}
