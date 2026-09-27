'use client';

import { useState } from 'react';
import type { ImpactReport, WhyInvestigation } from '@/lib/types';
import { ConfidenceMeter, Empty, LevelBadge, Panel } from './ui';

/** Answer, statement chain and evidence inspector for a why-investigation. */
export function WhyView({ why }: { why: WhyInvestigation }) {
  const [selected, setSelected] = useState<number | null>(null);
  const cited = new Set(selected === null ? [] : (why.statements[selected]?.evidenceIds ?? []));

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-4">
        <Panel title="Answer" aside={why.target.label}>
          <p className="text-[15px] leading-relaxed">{why.answer}</p>
          <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3">
            <LevelBadge level={why.classification} />
            <ConfidenceMeter value={why.confidence} level={why.classification} />
            <span className="text-xs text-muted">
              An answer is as certain as its weakest statement.
            </span>
          </div>
        </Panel>

        <Panel title="Evidence chain" aside={`${why.statements.length} statements`}>
          <ol className="flex flex-col">
            {why.statements.map((statement, index) => (
              <li key={`${statement.role}-${String(index)}`} className="relative pl-6">
                <span
                  aria-hidden
                  className={`absolute left-[7px] top-0 h-full border-l ${
                    statement.level === 'FACT'
                      ? 'border-fact/50'
                      : statement.level === 'DERIVED'
                        ? 'border-dashed border-derived/60'
                        : 'border-dotted border-inferred/70'
                  }`}
                />
                <span
                  aria-hidden
                  className="absolute left-[3px] top-3 h-2 w-2 rounded-full bg-line-strong"
                />
                <button
                  type="button"
                  onClick={() => {
                    setSelected(selected === index ? null : index);
                  }}
                  aria-pressed={selected === index}
                  className={`mb-1 w-full rounded-md px-3 py-2 text-left transition-colors ${
                    selected === index ? 'bg-raised' : 'hover:bg-raised/60'
                  }`}
                >
                  <span className="flex flex-wrap items-center gap-2">
                    <LevelBadge level={statement.level} />
                    <span className="font-mono text-2xs text-faint">
                      {statement.confidence.toFixed(2)}
                    </span>
                    <span className="font-mono text-2xs uppercase tracking-wider text-faint">
                      {statement.role}
                    </span>
                  </span>
                  <span className="mt-1 block text-sm leading-relaxed">{statement.text}</span>
                </button>
              </li>
            ))}
          </ol>
        </Panel>

        {why.related.length > 0 ? (
          <Panel title="Related">
            <ul className="flex flex-col gap-1.5 text-sm">
              {why.related.map((r) => (
                <li key={r.key}>
                  {r.label} <span className="text-muted">— {r.relation}</span>
                </li>
              ))}
            </ul>
          </Panel>
        ) : null}

        {why.caveats.length > 0 ? (
          <Panel title="What the evidence cannot say">
            <ul className="list-disc pl-5 text-sm text-muted">
              {why.caveats.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
          </Panel>
        ) : null}
      </div>

      <Panel
        title="Evidence"
        aside={selected === null ? 'select a statement' : `${cited.size} cited`}
      >
        {why.evidence.length === 0 ? (
          <Empty>No stored evidence backs this answer.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {why.evidence.map((item) => {
              const dimmed = selected !== null && !cited.has(item.id);
              return (
                <li
                  key={item.id}
                  className={`rounded-md border px-3 py-2 transition-opacity ${
                    selected !== null && cited.has(item.id)
                      ? 'border-accent/60 bg-accent-dim/30'
                      : 'border-line'
                  } ${dimmed ? 'opacity-40' : ''}`}
                >
                  <div className="flex items-center justify-between gap-2 font-mono text-2xs text-faint">
                    <span>
                      #{item.id} · {item.type}
                    </span>
                  </div>
                  <p className="mt-1 break-all font-mono text-xs text-ink">{item.locator}</p>
                  {item.excerpt ? (
                    <p className="mt-1 text-xs text-muted">“{item.excerpt}”</p>
                  ) : null}
                  <p className="mt-1 text-2xs text-faint">cited for: {item.reason}</p>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

/** Direct and transitive dependents with their routes. */
export function ImpactView({ report }: { report: ImpactReport }) {
  const byDistance = new Map<number, ImpactReport['transitive'][number][]>();
  for (const d of report.transitive)
    byDistance.set(d.distance, [...(byDistance.get(d.distance) ?? []), d]);
  return (
    <div className="flex flex-col gap-4">
      <Panel
        title="Impact"
        aside={report.definedIn ? `defined in ${report.definedIn.label}` : undefined}
      >
        <p className="text-[15px]">{report.answer}</p>
      </Panel>
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Direct dependents" aside={String(report.direct.length)}>
          {report.direct.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <ul className="flex flex-col gap-1 font-mono text-xs">
              {report.direct.map((d) => (
                <li key={d.key}>
                  {d.label}
                  {d.isTest ? <span className="ml-2 text-derived">test</span> : null}
                </li>
              ))}
            </ul>
          )}
        </Panel>
        <Panel title="Transitive dependents" aside={String(report.transitive.length)}>
          {report.transitive.length === 0 ? (
            <Empty>None.</Empty>
          ) : (
            <div className="flex flex-col gap-3">
              {[...byDistance].map(([distance, list]) => (
                <div key={distance}>
                  <p className="font-mono text-2xs uppercase tracking-wider text-faint">
                    distance {distance}
                  </p>
                  <ul className="mt-1 flex flex-col gap-1 font-mono text-xs">
                    {list.map((d) => (
                      <li key={d.key}>
                        {d.label}
                        {d.isTest ? <span className="ml-2 text-derived">test</span> : null}
                        <span className="block pl-3 text-faint">via {d.via.join(' → ')}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
      {[...report.truncated, ...report.caveats].length > 0 ? (
        <Panel title="Notes">
          <ul className="list-disc pl-5 text-sm text-muted">
            {report.truncated.map((t) => (
              <li key={t}>Incomplete — {t}</li>
            ))}
            {report.caveats.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </Panel>
      ) : null}
    </div>
  );
}
