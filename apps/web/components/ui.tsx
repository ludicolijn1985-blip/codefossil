import type { ReactNode } from 'react';
import { LEVEL_EXPLANATION, LEVEL_STYLE } from '@/lib/format';
import type { EvidenceLevel } from '@/lib/types';

export function Panel({
  title,
  aside,
  children,
  className = '',
}: {
  title?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`rounded-[var(--radius-panel)] border border-line bg-surface/90 ${className}`}
    >
      {title ? (
        <header className="flex items-baseline justify-between gap-4 border-b border-line px-4 py-2.5">
          <h2 className="font-mono text-2xs uppercase tracking-[0.14em] text-muted">{title}</h2>
          {aside ? <div className="font-mono text-2xs text-faint">{aside}</div> : null}
        </header>
      ) : null}
      <div className="p-4">{children}</div>
    </section>
  );
}

/** A large figure with a small label: the overview's vital signs. */
export function Metric({ label, value, note }: { label: string; value: number; note?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-panel)] border border-line bg-surface/80 px-4 py-3">
      <span className="font-mono text-2xs uppercase tracking-[0.14em] text-faint">{label}</span>
      <span className="text-2xl font-semibold tabular-nums tracking-tight">
        {value.toLocaleString('en-US')}
      </span>
      {note ? <span className="text-xs text-muted">{note}</span> : null}
    </div>
  );
}

/** FACT, DERIVED or INFERRED, with its meaning on hover and for screen readers. */
export function LevelBadge({ level }: { level: EvidenceLevel }) {
  const style = LEVEL_STYLE[level];
  return (
    <span
      title={LEVEL_EXPLANATION[level]}
      className={`inline-flex items-center rounded border px-1.5 py-px font-mono text-2xs tracking-wider ${style.text} ${style.border} ${
        level === 'DERIVED' ? 'border-dashed' : level === 'INFERRED' ? 'border-dotted' : ''
      }`}
    >
      {level}
      <span className="sr-only"> — {LEVEL_EXPLANATION[level]}</span>
    </span>
  );
}

/** Confidence as a number and a bar; the number carries the meaning, the bar the glance. */
export function ConfidenceMeter({ value, level }: { value: number; level: EvidenceLevel }) {
  const percent = Math.round(value * 100);
  return (
    <div className="flex items-center gap-3">
      <div
        className="h-1.5 w-28 overflow-hidden rounded-full bg-raised"
        role="meter"
        aria-label="Confidence"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
      >
        <div
          className={`h-full rounded-full ${level === 'FACT' ? 'bg-fact' : level === 'DERIVED' ? 'bg-derived' : 'bg-inferred'}`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="font-mono text-sm tabular-nums">{value.toFixed(2)}</span>
    </div>
  );
}

export function Mono({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`font-mono text-xs ${className}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>;
}

export function PageHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-col gap-1">
      <span className="font-mono text-2xs uppercase tracking-[0.18em] text-accent">{eyebrow}</span>
      <h1 className="[overflow-wrap:anywhere] text-2xl font-semibold tracking-tight">{title}</h1>
      {children ? <div className="text-sm text-muted">{children}</div> : null}
    </header>
  );
}

/** A 0–1 component as a thin bar with its value; the number carries the meaning. */
export function ComponentBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid grid-cols-[7.5rem_1fr_2.75rem] items-center gap-2 text-xs">
      <span className="text-muted">{label}</span>
      <div className="h-1 overflow-hidden rounded-full bg-raised" aria-hidden>
        <div
          className="h-full rounded-full bg-accent/80"
          style={{ width: `${Math.round(value * 100)}%` }}
        />
      </div>
      <span className="text-right font-mono tabular-nums">{value.toFixed(2)}</span>
    </div>
  );
}
