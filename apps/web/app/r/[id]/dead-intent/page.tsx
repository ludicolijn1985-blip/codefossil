import Link from 'next/link';
import { Problem } from '@/components/problem';
import { ConfidenceMeter, Empty, LevelBadge, PageHeader, Panel } from '@/components/ui';
import { fossil } from '@/lib/api';
import { day, entityHref, plural, shortSha } from '@/lib/format';
import { idParam } from '@/lib/route';
import type { DeadIntentCandidate, DeadIntentReport } from '@/lib/types';

const SIGNAL_LABEL: Readonly<Record<DeadIntentCandidate['signals'][number]['kind'], string>> = {
  workaround_language: 'workaround wording',
  unsupported_version: 'unsupported version',
  deadline_passed: 'deadline passed',
  unconfirmed: 'no recent confirmation',
};

function Candidate({
  repositoryId,
  candidate,
}: {
  repositoryId: number;
  candidate: DeadIntentCandidate;
}) {
  const href = entityHref(repositoryId, candidate.target.key);
  return (
    <li className="rounded-[var(--radius-panel)] border border-dotted border-inferred/50 bg-surface/80 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-2xs uppercase tracking-[0.14em] text-faint">
            {candidate.target.kind}
          </p>
          {href ? (
            <Link href={href} className="break-all font-mono text-sm hover:text-accent">
              {candidate.target.label}
            </Link>
          ) : (
            <span className="break-all font-mono text-sm">{candidate.target.label}</span>
          )}
        </div>
        <div className="flex items-center gap-3">
          <LevelBadge level={candidate.classification} />
          <ConfidenceMeter value={candidate.confidence} level={candidate.classification} />
        </div>
      </div>
      <ul className="mt-3 flex flex-col gap-1 text-xs text-muted">
        {candidate.commits.map((commit) => (
          <li key={commit.sha}>
            changed by <span className="font-mono text-faint">{shortSha(commit.sha)}</span>{' '}
            <span className="text-ink">{commit.subject}</span> · {day(commit.committedAt)}
          </li>
        ))}
      </ul>
      <ul className="mt-3 flex flex-col gap-2 border-t border-line pt-3">
        {candidate.signals.map((signal) => (
          <li
            key={`${signal.kind}-${signal.text}`}
            className="grid gap-x-3 text-sm sm:grid-cols-[11rem_1fr]"
          >
            <span className="flex items-center gap-2 font-mono text-2xs uppercase tracking-wider text-faint">
              <LevelBadge level={signal.level} />
              {SIGNAL_LABEL[signal.kind]}
            </span>
            <span className="break-words">{signal.text}</span>
          </li>
        ))}
      </ul>
    </li>
  );
}

export default async function DeadIntent({ params }: { params: Promise<{ id: string }> }) {
  const id = idParam((await params).id);
  let report: DeadIntentReport;
  try {
    report = await fossil<DeadIntentReport>(`/api/repositories/${id}/dead-intent`);
  } catch (error) {
    return <Problem error={error} />;
  }

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <PageHeader eyebrow="Dead intent" title="Workarounds whose reason may be gone">
        Candidates, never facts: code changed by commits that speak of workarounds, compatibility or
        legacy support, made stronger by old version references, passed deadlines and long silence.
        Each needs a human look before anything is removed.
      </PageHeader>

      <Panel title="Declared runtime support" aside={plural(report.runtimes.length, 'declaration')}>
        {report.runtimes.length === 0 ? (
          <Empty>
            No manifest declares a supported runtime, so version references are not compared.
          </Empty>
        ) : (
          <ul className="flex flex-wrap gap-x-6 gap-y-1 font-mono text-xs">
            {report.runtimes.map((runtime) => (
              <li key={`${runtime.manifest}-${runtime.runtime}`}>
                {runtime.runtime} {runtime.constraint}{' '}
                <span className="text-faint">({runtime.manifest})</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      {report.candidates.length === 0 ? (
        <Empty>
          No candidates: no workaround or compatibility wording can be tied to code that is still
          present and has not been reworked since.
        </Empty>
      ) : (
        <ol className="flex flex-col gap-3" aria-label="Candidates">
          {report.candidates.map((candidate) => (
            <Candidate key={candidate.target.key} repositoryId={id} candidate={candidate} />
          ))}
        </ol>
      )}

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
