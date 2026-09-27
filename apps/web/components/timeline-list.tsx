import { day, plural, shortSha } from '@/lib/format';
import type { Timeline } from '@/lib/types';
import { Empty } from './ui';

const CHANGE_STYLE: Readonly<Record<string, string>> = {
  added: 'text-fact',
  modified: 'text-derived',
  renamed: 'text-inferred',
  deleted: 'text-danger',
};

/** A file's changes as a vertical history line, oldest first. */
export function TimelineList({ timeline }: { timeline: Timeline }) {
  if (timeline.entries.length === 0) return <Empty>No recorded changes.</Empty>;
  return (
    <div>
      <p className="mb-4 text-sm text-muted">
        {plural(timeline.entries.length, 'change')}
        {timeline.paths.length > 1 ? ` · formerly ${timeline.paths.slice(1).join(', ')}` : ''}
      </p>
      <ol className="relative flex flex-col gap-5 border-l border-line pl-5">
        {timeline.entries.map((entry) => (
          <li key={`${entry.sha}-${entry.path}`} className="relative">
            <span
              aria-hidden
              className="absolute -left-[25px] top-1.5 h-2 w-2 rounded-full border border-line-strong bg-ground"
            />
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 font-mono text-2xs text-faint">
              <time dateTime={entry.committedAt}>{day(entry.committedAt)}</time>
              <span>{shortSha(entry.sha)}</span>
              <span className={`uppercase tracking-wider ${CHANGE_STYLE[entry.change] ?? ''}`}>
                {entry.change}
              </span>
              <span>
                {entry.additions === null
                  ? 'binary'
                  : `+${entry.additions} −${entry.deletions ?? 0}`}
              </span>
              <span>{entry.author}</span>
            </div>
            <p className="mt-1 text-sm">{entry.subject}</p>
            {entry.change === 'renamed' ? (
              <p className="mt-0.5 font-mono text-xs text-muted">
                {entry.previousPath} → {entry.path}
              </p>
            ) : null}
            {entry.symbols.length > 0 ? (
              <p className="mt-1 font-mono text-xs text-muted">
                <span className="text-faint">symbols </span>
                {entry.symbols.join(', ')}
              </p>
            ) : null}
            {[...entry.pullRequests, ...entry.issues.map((i) => `${i.relation} ${i.label}`)].map(
              (context) => (
                <p key={context} className="mt-0.5 text-xs text-derived">
                  {context}
                </p>
              ),
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
