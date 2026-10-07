import { Problem } from '@/components/problem';
import { Empty, LevelBadge, Metric, PageHeader, Panel } from '@/components/ui';
import { fossil } from '@/lib/api';
import { day, plural } from '@/lib/format';
import { idParam, oneParam } from '@/lib/route';
import type { FileOwnership, OwnershipReport } from '@/lib/types';

/** A repository-relative path typed into the scope field: no absolute paths or `..`. */
const SCOPE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[^\0]{1,500}$/;

function ShareBar({ share, active }: { share: number; active: boolean }) {
  return (
    <span
      aria-hidden
      className="relative h-1.5 w-24 overflow-hidden rounded-full bg-line"
      title={`${String(Math.round(share * 100))}%`}
    >
      <span
        className={`absolute inset-y-0 left-0 rounded-full ${active ? 'bg-accent' : 'bg-faint'}`}
        style={{ width: `${String(Math.max(2, Math.round(share * 100)))}%` }}
      />
    </span>
  );
}

function FileRow({ file }: { file: FileOwnership }) {
  return (
    <li className="flex flex-col gap-2 rounded-md px-3 py-3 hover:bg-raised/40">
      <div className="flex items-baseline justify-between gap-3">
        <span className="truncate font-mono text-xs" title={file.file.path}>
          {file.atRisk ? (
            <span className="mr-2 rounded bg-danger/15 px-1.5 py-0.5 text-2xs text-danger">
              at risk
            </span>
          ) : null}
          {file.file.path}
        </span>
        <span className="shrink-0 font-mono text-2xs text-faint">
          {plural(file.commits, 'commit')}
        </span>
      </div>
      <ul className="flex flex-col gap-1">
        {file.authors.slice(0, 4).map((author) => (
          <li key={author.author} className="flex items-center gap-3 text-xs">
            <ShareBar share={author.share} active={author.active} />
            <span className="w-10 text-right font-mono tabular-nums text-muted">
              {Math.round(author.share * 100)}%
            </span>
            <span className={author.active ? 'text-ink' : 'text-muted'}>{author.author}</span>
            <span className="text-2xs text-faint">
              {author.active ? 'active' : `last commit ${day(author.lastCommitAt)}`}
            </span>
          </li>
        ))}
        {file.authors.length > 4 ? (
          <li className="pl-[8.5rem] text-2xs text-faint">
            +{plural(file.authors.length - 4, 'more author')}
          </li>
        ) : null}
      </ul>
    </li>
  );
}

export default async function Owners({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const id = idParam((await params).id);
  const query = await searchParams;
  const scope = (oneParam(query.path) ?? '').trim();
  const search = new URLSearchParams({
    limit: '50',
    ...(SCOPE.test(scope) ? { path: scope } : {}),
  });

  let report: OwnershipReport;
  try {
    report = await fossil<OwnershipReport>(`/api/repositories/${id}/owners?${search.toString()}`);
  } catch (error) {
    return <Problem error={error} />;
  }
  const atRisk = report.files.filter((file) => file.atRisk).length;

  return (
    <div className="flex max-w-5xl flex-col gap-5">
      <PageHeader eyebrow="Owners" title="Who wrote this code">
        Each file&apos;s authors by their share of the lines changed, whether they still commit, and
        how many people the code depends on. Authorship stands in for knowledge, so this is an
        inference.
      </PageHeader>

      <form method="get" className="flex flex-wrap items-end gap-3 text-sm" aria-label="Scope">
        <label className="flex min-w-64 flex-1 flex-col gap-1">
          <span className="font-mono text-2xs uppercase tracking-[0.14em] text-muted">
            File or directory
          </span>
          <input
            name="path"
            defaultValue={scope}
            placeholder="the whole repository"
            className="rounded-md border border-line bg-ground px-3 py-2 font-mono text-xs focus:border-accent/60 focus:outline-none"
          />
        </label>
        <button
          type="submit"
          className="rounded-md bg-accent px-4 py-2 font-medium text-ground transition-opacity hover:opacity-90"
        >
          Apply
        </button>
      </form>

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric
          label="Bus factor"
          value={report.busFactor}
          note={report.busFactorAuthors.join(', ') || 'no files with history'}
        />
        <Metric
          label="Files at risk"
          value={atRisk}
          note="mostly written by someone no longer active"
        />
        <Metric label="Files" value={report.filesConsidered} note="code with history in scope" />
      </div>

      <Panel
        title="Files, those at risk first"
        aside={<LevelBadge level={report.classification} />}
      >
        {report.files.length === 0 ? (
          <Empty>No code files with history in {report.scope ?? 'the repository'}.</Empty>
        ) : (
          <ol className="flex flex-col divide-y divide-line">
            {report.files.map((file) => (
              <FileRow key={file.file.id} file={file} />
            ))}
          </ol>
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
