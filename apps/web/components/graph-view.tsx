'use client';

import '@xyflow/react/dist/style.css';
import {
  Background,
  Controls,
  Handle,
  Position as HandlePosition,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from '@xyflow/react';
import { useMemo, useState } from 'react';
import { LEVEL_STYLE } from '@/lib/format';
import { layoutGraph } from '@/lib/graph-layout';
import type { EvidenceLevel, GraphDocument } from '@/lib/types';
import { LevelBadge } from './ui';

type GraphNode = GraphDocument['nodes'][number];
type GraphEdge = GraphDocument['edges'][number];
type EntityNodeData = { label: string; type: string; isRoot: boolean };

const TYPE_LABEL: Readonly<Record<string, string>> = {
  pull_request: 'PR',
  dependency: 'dep',
};

const LEVEL_COLOR: Readonly<Record<EvidenceLevel, string>> = {
  FACT: 'var(--color-fact)',
  DERIVED: 'var(--color-derived)',
  INFERRED: 'var(--color-inferred)',
};

function EntityNode({ data }: NodeProps<Node<EntityNodeData>>) {
  return (
    <div
      className={`w-[240px] rounded-md border bg-surface px-3 py-2 shadow-[0_8px_24px_-12px_rgba(0,0,0,0.8)] ${
        data.isRoot ? 'border-accent' : 'border-line-strong'
      }`}
    >
      <Handle type="target" position={HandlePosition.Left} className="!border-0 !bg-line-strong" />
      <p className="font-mono text-2xs uppercase tracking-wider text-faint">
        {TYPE_LABEL[data.type] ?? data.type}
      </p>
      <p className="truncate text-xs" title={data.label}>
        {data.label}
      </p>
      <Handle type="source" position={HandlePosition.Right} className="!border-0 !bg-line-strong" />
    </div>
  );
}

const NODE_TYPES = { entity: EntityNode };

/** The evidence graph around one entity; click an edge to see where it came from. */
export function GraphView({ graph }: { graph: GraphDocument }) {
  const [selected, setSelected] = useState<GraphEdge | null>(null);

  const { nodes, edges } = useMemo(() => {
    const positions = layoutGraph(graph.nodes, graph.edges, graph.scope.root);
    const flowNodes: Node<EntityNodeData>[] = graph.nodes.map((node: GraphNode) => ({
      id: node.id,
      type: 'entity',
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      data: { label: node.label, type: node.type, isRoot: node.id === graph.scope.root },
    }));
    const flowEdges: Edge[] = graph.edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      // Only the selected relationship is labelled; labels on every edge bury the picture.
      ...(edge.id === selected?.id ? { label: edge.relation } : {}),
      style: {
        stroke: LEVEL_COLOR[edge.evidenceType],
        strokeDasharray:
          LEVEL_STYLE[edge.evidenceType].dash === 'none'
            ? undefined
            : LEVEL_STYLE[edge.evidenceType].dash,
        strokeWidth: edge.id === selected?.id ? 2.5 : 1.25,
        opacity: selected && edge.id !== selected.id ? 0.35 : 1,
      },
      labelStyle: {
        fill: 'var(--color-muted)',
        fontSize: 10,
        fontFamily: 'var(--font-geist-mono)',
      },
      labelBgStyle: { fill: 'var(--color-ground)' },
    }));
    return { nodes: flowNodes, edges: flowEdges };
  }, [graph, selected]);

  const labelOf = (id: string) => graph.nodes.find((n) => n.id === id)?.label ?? id;
  const evidence = selected
    ? graph.evidence.filter((e) => selected.provenance.evidenceIds.includes(e.id))
    : [];

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div
        className="h-[70vh] min-h-[420px] overflow-hidden rounded-[var(--radius-panel)] border border-line bg-ground"
        aria-label="Evidence graph"
        role="region"
      >
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          fitView
          minZoom={0.2}
          colorMode="dark"
          nodesConnectable={false}
          onEdgeClick={(_, edge) => {
            setSelected(graph.edges.find((e) => e.id === edge.id) ?? null);
          }}
          onPaneClick={() => {
            setSelected(null);
          }}
        >
          <Background gap={24} size={1} color="var(--color-line)" />
          <Controls showInteractive={false} />
        </ReactFlow>
      </div>

      <aside
        className="rounded-[var(--radius-panel)] border border-line bg-surface/90 p-4"
        aria-live="polite"
      >
        <h2 className="font-mono text-2xs uppercase tracking-[0.14em] text-muted">Provenance</h2>
        {selected ? (
          <div className="mt-3 flex flex-col gap-3 text-sm">
            <p>
              <span className="text-muted">{labelOf(selected.source)}</span>{' '}
              <span className="font-mono text-xs text-accent">{selected.relation}</span>{' '}
              <span className="text-muted">{labelOf(selected.target)}</span>
            </p>
            <div className="flex items-center gap-2">
              <LevelBadge level={selected.evidenceType} />
              <span className="font-mono text-xs">{selected.confidence.toFixed(2)}</span>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-xs">
              <dt className="text-faint">producer</dt>
              <dd>{selected.provenance.producer}</dd>
              <dt className="text-faint">method</dt>
              <dd>{selected.provenance.method}</dd>
              <dt className="text-faint">observed</dt>
              <dd>{selected.provenance.observedAt.slice(0, 10)}</dd>
            </dl>
            {evidence.length > 0 ? (
              <ul className="flex flex-col gap-2">
                {evidence.map((item) => (
                  <li key={item.id} className="rounded-md border border-line px-2.5 py-2">
                    <p className="font-mono text-2xs text-faint">
                      #{item.id} · {item.type}
                    </p>
                    <p className="mt-0.5 break-all font-mono text-xs">{item.locator}</p>
                    {item.excerpt ? (
                      <p className="mt-1 text-xs text-muted">“{item.excerpt}”</p>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted">No stored evidence record for this relationship.</p>
            )}
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted">
            Select a relationship to see its evidence, how it was established and how certain it is.
          </p>
        )}
        <ul className="mt-6 flex flex-col gap-1.5 border-t border-line pt-3 text-xs text-muted">
          {(['FACT', 'DERIVED', 'INFERRED'] as const).map((level) => (
            <li key={level} className="flex items-center gap-2">
              <svg width="28" height="6" aria-hidden>
                <line
                  x1="0"
                  y1="3"
                  x2="28"
                  y2="3"
                  stroke={LEVEL_COLOR[level]}
                  strokeWidth="1.5"
                  strokeDasharray={
                    LEVEL_STYLE[level].dash === 'none' ? undefined : LEVEL_STYLE[level].dash
                  }
                />
              </svg>
              {level}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
