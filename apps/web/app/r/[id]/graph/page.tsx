import { GraphView } from '@/components/graph-view';
import { Problem } from '@/components/problem';
import { Empty, PageHeader } from '@/components/ui';
import { fossil } from '@/lib/api';
import { idParam, oneParam } from '@/lib/route';
import type { GraphDocument } from '@/lib/types';

const DEPTHS = [1, 2, 3] as const;

export default async function Graph({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const id = idParam((await params).id);
  const query = await searchParams;
  const root = oneParam(query.root)?.trim().slice(0, 1000) ?? '';
  const requestedDepth = Number(oneParam(query.depth));
  const depth = DEPTHS.find((d) => d === requestedDepth) ?? 2;

  let graph: GraphDocument | null = null;
  let failure: unknown = null;
  if (root) {
    try {
      graph = await fossil<GraphDocument>(
        `/api/repositories/${id}/graph?root=${encodeURIComponent(root)}&depth=${depth}`,
      );
    } catch (error) {
      failure = error;
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <PageHeader eyebrow="Graph" title="Relationships around one entity">
        Line style shows the evidence level: solid is fact, dashed derived, dotted inferred.
      </PageHeader>
      <form
        method="get"
        className="flex flex-wrap items-end gap-3"
        role="search"
        aria-label="Choose the graph root"
      >
        <label className="flex min-w-[16rem] flex-1 flex-col gap-1">
          <span className="font-mono text-2xs uppercase tracking-[0.14em] text-muted">Root</span>
          <input
            name="root"
            data-shortcut="search"
            defaultValue={root}
            placeholder="src/app.ts · calculateVAT · #42 · npm:zod · a1b2c3d"
            autoComplete="off"
            className="rounded-md border border-line bg-ground px-3 py-2 font-mono text-sm placeholder:text-faint focus:border-accent/60 focus:outline-none"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-2xs uppercase tracking-[0.14em] text-muted">Depth</span>
          <select
            name="depth"
            defaultValue={String(depth)}
            className="rounded-md border border-line bg-ground px-3 py-2 text-sm focus:border-accent/60 focus:outline-none"
          >
            {DEPTHS.map((d) => (
              <option key={d} value={d}>
                {d} {d === 1 ? 'hop' : 'hops'}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-ground transition-opacity hover:opacity-90"
        >
          Show
        </button>
      </form>

      {failure ? <Problem error={failure} /> : null}
      {!root ? (
        <Empty>Name a file, symbol, commit, issue or dependency to draw its neighbourhood.</Empty>
      ) : null}
      {graph ? (
        <>
          {graph.scope.truncated.length > 0 ? (
            <p className="text-sm text-inferred">Incomplete — {graph.scope.truncated.join('; ')}</p>
          ) : null}
          {graph.nodes.length <= 1 ? (
            <Empty>No recorded relationships around this entity.</Empty>
          ) : (
            <GraphView graph={graph} />
          )}
        </>
      ) : null}
    </div>
  );
}
