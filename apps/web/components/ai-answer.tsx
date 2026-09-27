'use client';

import { useState } from 'react';
import type { AiAnswer } from '@/lib/types';
import { ConfidenceMeter, Empty, LevelBadge, Panel } from './ui';

/**
 * An answer from the optional AI layer. It is labelled as AI-generated
 * throughout, every claim is an inference, and selecting a claim shows the
 * evidence it cites — the same evidence the model was given.
 */
export function AiAnswerView({ answer }: { answer: AiAnswer }) {
  const [selected, setSelected] = useState<number | null>(null);
  const cited = new Set(selected === null ? [] : (answer.claims[selected]?.evidenceIds ?? []));

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
      <div className="flex flex-col gap-4">
        <section className="rounded-[var(--radius-panel)] border border-dotted border-inferred/60 bg-surface/90">
          <header className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line px-4 py-2.5">
            <h2 className="font-mono text-2xs uppercase tracking-[0.14em] text-inferred">
              AI-generated answer
            </h2>
            <span className="font-mono text-2xs text-faint">
              {answer.provider} · {answer.model} · {answer.cloud ? 'cloud' : 'this machine'}
            </span>
          </header>
          <div className="p-4">
            <p className="text-[15px] leading-relaxed">{answer.answer}</p>
            <div className="mt-4 flex flex-wrap items-center gap-3 border-t border-line pt-3">
              <LevelBadge level={answer.classification} />
              <ConfidenceMeter value={answer.confidence} level={answer.classification} />
              <span className="text-xs text-muted">
                Drawn from the evidence shown; never more than an inference.
              </span>
            </div>
          </div>
        </section>

        <Panel
          title="Claims"
          aside={`${String(answer.claims.length)} kept · ${String(answer.rejectedClaims)} dropped`}
        >
          {answer.claims.length === 0 ? (
            <Empty>No claim could be tied to the evidence.</Empty>
          ) : (
            <ol className="flex flex-col gap-1">
              {answer.claims.map((claim, index) => (
                <li key={`${String(index)}-${claim.text}`}>
                  <button
                    type="button"
                    aria-pressed={selected === index}
                    onClick={() => {
                      setSelected(selected === index ? null : index);
                    }}
                    className={`w-full rounded-md px-3 py-2 text-left transition-colors ${
                      selected === index ? 'bg-raised' : 'hover:bg-raised/60'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <LevelBadge level={claim.level} />
                      <span className="font-mono text-2xs text-faint">
                        {claim.confidence.toFixed(2)} · cites{' '}
                        {claim.evidenceIds.map((id) => `#${String(id)}`).join(' ')}
                      </span>
                    </span>
                    <span className="mt-1 block text-sm">{claim.text}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </Panel>

        <Panel title="Caveats">
          <ul className="list-disc pl-5 text-sm text-muted">
            {answer.caveats.map((caveat) => (
              <li key={caveat}>{caveat}</li>
            ))}
          </ul>
        </Panel>
      </div>

      <Panel
        title="Evidence shown to the model"
        aside={selected === null ? 'select a claim' : `${String(cited.size)} cited`}
      >
        <ul className="flex flex-col gap-2">
          {answer.evidence.map((item) => {
            const highlighted = selected !== null && cited.has(item.id);
            return (
              <li
                key={item.id}
                className={`rounded-md border px-3 py-2 transition-opacity ${
                  highlighted ? 'border-accent/60' : 'border-line'
                } ${selected !== null && !highlighted ? 'opacity-40' : ''}`}
              >
                <p className="font-mono text-2xs text-faint">
                  #{item.id} · {item.type}
                  {item.cited ? ' · cited' : ''}
                </p>
                <p className="mt-1 break-all font-mono text-xs">{item.locator}</p>
                {item.excerpt ? (
                  <p className="mt-1 line-clamp-4 whitespace-pre-line text-xs text-muted">
                    {item.excerpt}
                  </p>
                ) : item.type === 'ast_node' ? (
                  <p className="mt-1 text-2xs text-faint">source excerpt withheld</p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Panel>
    </div>
  );
}
