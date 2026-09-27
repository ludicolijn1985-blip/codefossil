'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type SubmitEvent } from 'react';
import { ClientApiError, request } from '@/lib/client';
import type { ImpactReport, Timeline, WhyInvestigation } from '@/lib/types';
import { ImpactView, WhyView } from './investigation-view';
import { TimelineList } from './timeline-list';

type Answer =
  | { kind: 'why'; result: WhyInvestigation; investigationId: number | null }
  | { kind: 'impact'; result: ImpactReport; investigationId: number | null }
  | { kind: 'timeline'; result: Timeline; investigationId: null };

const EXAMPLES = [
  'Why does calculateVAT exist?',
  'What depends on src/app.ts?',
  'History of package.json',
];

/** Ask a question in plain words; the answer comes with its evidence. */
export function Ask({ repositoryId, initial }: { repositoryId: number; initial?: string }) {
  const router = useRouter();
  const [question, setQuestion] = useState(initial ?? '');
  const [answer, setAnswer] = useState<Answer | null>(null);
  const [problem, setProblem] = useState<ClientApiError | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = question.trim();
    if (!text) return;
    startTransition(async () => {
      try {
        const result = await request<Answer>(`/repositories/${repositoryId}/investigate`, {
          method: 'POST',
          body: { question: text },
        });
        setAnswer(result);
        setProblem(null);
        router.refresh(); // the saved investigation appears in the history
      } catch (error) {
        setAnswer(null);
        setProblem(
          error instanceof ClientApiError
            ? error
            : new ClientApiError(0, 'error', 'The request failed.'),
        );
      }
    });
  };

  const candidates =
    problem?.code === 'ambiguous_target'
      ? ((problem.details as { candidates?: { label: string; how: string }[] } | undefined)
          ?.candidates ?? [])
      : [];

  return (
    <div className="flex flex-col gap-4">
      <form
        onSubmit={submit}
        className="flex flex-col gap-2"
        role="search"
        aria-label="Ask a question"
      >
        <label
          htmlFor="question"
          className="font-mono text-2xs uppercase tracking-[0.14em] text-muted"
        >
          Ask about this repository
        </label>
        <div className="flex gap-2">
          <input
            id="question"
            data-shortcut="search"
            value={question}
            onChange={(e) => {
              setQuestion(e.target.value);
            }}
            placeholder="Why does … exist?  ·  What depends on …?  ·  History of …"
            autoComplete="off"
            className="min-w-0 flex-1 rounded-md border border-line bg-ground px-3 py-2.5 text-[15px] placeholder:text-faint focus:border-accent/60 focus:outline-none"
          />
          <button
            type="submit"
            disabled={pending}
            className="rounded-md bg-accent px-4 text-sm font-medium text-ground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {pending ? 'Tracing…' : 'Investigate'}
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {EXAMPLES.map((example) => (
            <button
              key={example}
              type="button"
              onClick={() => {
                setQuestion(example);
              }}
              className="rounded border border-line px-2 py-0.5 font-mono text-2xs text-faint hover:border-line-strong hover:text-muted"
            >
              {example}
            </button>
          ))}
        </div>
      </form>

      <div aria-live="polite" className="flex flex-col gap-4">
        {problem ? (
          <div
            role="alert"
            className="rounded-[var(--radius-panel)] border border-inferred/40 bg-surface p-4"
          >
            <p className="font-mono text-2xs uppercase tracking-[0.16em] text-inferred">
              {problem.code}
            </p>
            <p className="mt-1 whitespace-pre-line text-sm">{problem.message}</p>
            {candidates.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1 font-mono text-xs text-muted">
                {candidates.map((c) => (
                  <li key={c.label}>
                    {c.label} <span className="text-faint">({c.how})</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {answer?.kind === 'why' ? <WhyView why={answer.result} /> : null}
        {answer?.kind === 'impact' ? <ImpactView report={answer.result} /> : null}
        {answer?.kind === 'timeline' ? <TimelineList timeline={answer.result} /> : null}
      </div>
    </div>
  );
}
