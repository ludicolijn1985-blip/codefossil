import Link from 'next/link';
import { Problem } from '@/components/problem';
import { ComponentBar, Empty, LevelBadge, PageHeader, Panel } from '@/components/ui';
import { fossil } from '@/lib/api';
import { day, entityHref, plural, shortSha } from '@/lib/format';
import { idParam, oneParam } from '@/lib/route';
import type { Hotspot, HotspotReport } from '@/lib/types';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

function Row({
  repositoryId,
  hotspot,
  rank,
}: {
  repositoryId: number;
  hotspot: Hotspot;
  rank: number;
}) {
  const href = entityHref(repositoryId, hotspot.file.key);
  const c = hotspot.components;
  const r = hotspot.risk.components;
  return (
    <li>
      <details className="group rounded-md border border-transparent open:border-line open:bg-surface/60">
        <summary className="grid cursor-pointer list-none [&::-webkit-details-marker]:hidden grid-cols-[2rem_minmax(0,1fr)_repeat(3,4.5rem)_5rem_5rem] items-center gap-2 rounded-md px-3 py-2 text-sm hover:bg-raised/60 max-md:grid-cols-[2rem_minmax(0,1fr)_5rem]">
          <span className="flex items-center gap-1 font-mono text-2xs text-faint">
            <span aria-hidden className="transition-transform group-open:rotate-90">
              ›
            </span>
            {rank}
          </span>
          <span className="truncate font-mono text-xs" title={hotspot.file.path}>
            {hotspot.file.path}
            {hotspot.isTest ? <span className="ml-2 text-derived">test</span> : null}
          </span>
          <span className="text-right font-mono text-xs tabular-nums max-md:hidden">
            {hotspot.commits}
          </span>
          <span className="text-right font-mono text-xs tabular-nums max-md:hidden">
            {hotspot.churn}
          </span>
          <span className="text-right font-mono text-xs tabular-nums max-md:hidden">
            {hotspot.defectCount}
          </span>
          <span className="text-right font-mono text-xs tabular-nums text-accent">
            {hotspot.score.toFixed(2)}
          </span>
          <span className="text-right font-mono text-xs tabular-nums max-md:hidden">
            {hotspot.risk.score.toFixed(2)}
          </span>
        </summary>
        <div className="grid gap-6 px-3 pb-4 pt-2 lg:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <p className="font-mono text-2xs uppercase tracking-[0.14em] text-faint">
              Hotspot = product of
            </p>
            <ComponentBar label="change" value={c.changeFrequency} />
            <ComponentBar label="churn" value={c.churn} />
            <ComponentBar label="defects + 1" value={c.defects} />
          </div>
          <div className="flex flex-col gap-1.5">
            <p className="font-mono text-2xs uppercase tracking-[0.14em] text-faint">
              Risk = product of
            </p>
            <ComponentBar label="change" value={r.changeFrequency} />
            <ComponentBar label="centrality" value={r.dependencyCentrality} />
            <ComponentBar label="bug density" value={r.bugDensity} />
            <ComponentBar label="untested" value={r.testReachInverse} />
            <p className="mt-1 text-2xs text-muted">
              {plural(hotspot.risk.dependents, 'file')} import it;{' '}
              {plural(hotspot.risk.testsReaching, 'test')}{' '}
              {hotspot.risk.testsReaching === 1 ? 'reaches' : 'reach'} it.
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <p className="flex items-center gap-2 font-mono text-2xs uppercase tracking-[0.14em] text-faint">
              Defect commits <LevelBadge level={hotspot.classification} />
            </p>
            {hotspot.defects.length === 0 ? (
              <Empty>None recorded.</Empty>
            ) : (
              <ul className="flex flex-col gap-1.5 text-xs">
                {hotspot.defects.map((d) => (
                  <li key={d.sha}>
                    <span className="font-mono text-faint">{shortSha(d.sha)}</span> {d.subject}
                    <span className="block text-2xs text-muted">
                      {d.reason} · {d.level} {d.confidence.toFixed(2)} · {day(d.committedAt)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {href ? (
              <Link href={`${href}?tab=history`} className="text-xs text-accent hover:underline">
                Open its history
              </Link>
            ) : null}
          </div>
        </div>
      </details>
    </li>
  );
}

export default async function Hotspots({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const id = idParam((await params).id);
  const query = await searchParams;
  const order = oneParam(query.order) === 'risk' ? 'risk' : 'hotspot';
  const since = oneParam(query.since) ?? '';
  const tests = oneParam(query.tests) === 'true';
  const generated = oneParam(query.generated) === 'true';
  const search = new URLSearchParams({
    order,
    limit: '50',
    tests: String(tests),
    generated: String(generated),
    ...(DATE.test(since) ? { since } : {}),
  });

  let report: HotspotReport;
  try {
    report = await fossil<HotspotReport>(`/api/repositories/${id}/hotspots?${search.toString()}`);
  } catch (error) {
    return <Problem error={error} />;
  }

  return (
    <div className="flex max-w-6xl flex-col gap-5">
      <PageHeader eyebrow="Hotspots" title="Where the history concentrates">
        Files ranked by how often and how much they changed, and how often a change was a fix. Open
        a row to see why it ranks there.
      </PageHeader>

      <form
        method="get"
        className="flex flex-wrap items-end gap-4 text-sm"
        aria-label="Hotspot options"
      >
        <label className="flex flex-col gap-1">
          <span className="font-mono text-2xs uppercase tracking-[0.14em] text-muted">
            Order by
          </span>
          <select
            name="order"
            defaultValue={order}
            className="rounded-md border border-line bg-ground px-3 py-2 focus:border-accent/60 focus:outline-none"
          >
            <option value="hotspot">hotspot score</option>
            <option value="risk">risk</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="font-mono text-2xs uppercase tracking-[0.14em] text-muted">Since</span>
          <input
            type="date"
            name="since"
            defaultValue={DATE.test(since) ? since : ''}
            className="rounded-md border border-line bg-ground px-3 py-2 focus:border-accent/60 focus:outline-none"
          />
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input
            type="checkbox"
            name="tests"
            value="true"
            defaultChecked={tests}
            className="accent-accent"
          />
          tests
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input
            type="checkbox"
            name="generated"
            value="true"
            defaultChecked={generated}
            className="accent-accent"
          />
          lockfiles &amp; generated
        </label>
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 font-medium text-ground transition-opacity hover:opacity-90"
        >
          Apply
        </button>
      </form>

      <Panel
        title={`Ranked by ${order === 'risk' ? 'risk' : 'hotspot score'}`}
        aside={`${plural(report.filesConsidered, 'file')} with changes${report.since ? ` since ${day(report.since)}` : ''}`}
      >
        {report.hotspots.length === 0 ? (
          <Empty>No file has recorded changes in this window.</Empty>
        ) : (
          <>
            <div className="grid grid-cols-[2rem_minmax(0,1fr)_repeat(3,4.5rem)_5rem_5rem] gap-2 px-3 pb-2 font-mono text-2xs uppercase tracking-wider text-faint max-md:grid-cols-[2rem_minmax(0,1fr)_5rem]">
              <span>#</span>
              <span>File</span>
              <span className="text-right max-md:hidden">Commits</span>
              <span className="text-right max-md:hidden">Churn</span>
              <span className="text-right max-md:hidden">Defects</span>
              <span className="text-right">Hotspot</span>
              <span className="text-right max-md:hidden">Risk</span>
            </div>
            <ol className="flex flex-col">
              {report.hotspots.map((hotspot, index) => (
                <Row key={hotspot.file.key} repositoryId={id} hotspot={hotspot} rank={index + 1} />
              ))}
            </ol>
          </>
        )}
      </Panel>

      <Panel title="How to read this">
        <ul className="list-disc pl-5 text-sm text-muted">
          {report.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}
