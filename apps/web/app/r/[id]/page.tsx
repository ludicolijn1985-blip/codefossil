import Link from 'next/link';
import { Problem } from '@/components/problem';
import { Empty, LevelBadge, Metric, PageHeader, Panel } from '@/components/ui';
import { fossil } from '@/lib/api';
import { day, entityHref, plural, shortSha, when } from '@/lib/format';
import { idParam } from '@/lib/route';
import type {
  CommitListItem,
  HotspotReport,
  InvestigationRow,
  RepositoryDetail,
} from '@/lib/types';

export default async function Overview({ params }: { params: Promise<{ id: string }> }) {
  const id = idParam((await params).id);
  let data: [RepositoryDetail, CommitListItem[], InvestigationRow[], HotspotReport];
  try {
    data = await Promise.all([
      fossil<RepositoryDetail>(`/api/repositories/${id}`),
      fossil<CommitListItem[]>(`/api/repositories/${id}/commits?limit=12`),
      fossil<InvestigationRow[]>(`/api/repositories/${id}/investigations?limit=8`),
      fossil<HotspotReport>(`/api/repositories/${id}/hotspots?limit=6`),
    ]);
  } catch (error) {
    return <Problem error={error} />;
  }
  const [repository, commits, investigations, hotspots] = data;
  const { counts } = repository.status;
  const relations = counts.relations.FACT + counts.relations.DERIVED + counts.relations.INFERRED;

  return (
    <div className="flex max-w-6xl flex-col gap-6">
      <PageHeader eyebrow="Overview" title={repository.name}>
        <span className="font-mono text-xs">{repository.path}</span> · indexed{' '}
        {when(repository.indexedAt)}
      </PageHeader>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Metric label="Commits" value={counts.commits} />
        <Metric
          label="Files"
          value={counts.currentFiles}
          note={`${counts.files.toLocaleString('en-US')} ever tracked`}
        />
        <Metric
          label="Symbols"
          value={counts.currentSymbols}
          note={`${counts.symbolVersions.toLocaleString('en-US')} versions`}
        />
        <Metric label="Evidence" value={counts.evidence} />
      </div>

      <Panel title="Relationships by evidence level" aside={relations.toLocaleString('en-US')}>
        <div className="flex h-2 overflow-hidden rounded-full bg-raised" aria-hidden>
          {(['FACT', 'DERIVED', 'INFERRED'] as const).map((level) => (
            <div
              key={level}
              className={
                level === 'FACT' ? 'bg-fact' : level === 'DERIVED' ? 'bg-derived' : 'bg-inferred'
              }
              style={{ width: `${relations ? (counts.relations[level] / relations) * 100 : 0}%` }}
            />
          ))}
        </div>
        <ul className="mt-3 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          {(['FACT', 'DERIVED', 'INFERRED'] as const).map((level) => (
            <li key={level} className="flex items-center gap-2">
              <LevelBadge level={level} />
              <span className="tabular-nums">
                {counts.relations[level].toLocaleString('en-US')}
              </span>
            </li>
          ))}
        </ul>
        {repository.github ? (
          <p className="mt-3 text-xs text-muted">
            GitHub {repository.github.owner}/{repository.github.name}: {repository.github.issues}{' '}
            issues, {repository.github.pullRequests} pull requests, synced{' '}
            {when(repository.github.lastSyncedAt)}.
          </p>
        ) : (
          <p className="mt-3 text-xs text-muted">
            No GitHub connection: issue and pull-request evidence is absent, so answers rest on git
            history alone.
          </p>
        )}
      </Panel>

      <Panel
        title="Historical hotspots"
        aside={
          <Link href={`/r/${id}/hotspots`} className="hover:text-accent">
            all hotspots →
          </Link>
        }
      >
        {hotspots.hotspots.length === 0 ? (
          <Empty>No file has recorded changes yet.</Empty>
        ) : (
          <ol className="grid gap-x-8 gap-y-2 md:grid-cols-2">
            {hotspots.hotspots.map((hotspot) => {
              const href = entityHref(id, hotspot.file.key);
              return (
                <li
                  key={hotspot.file.key}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
                >
                  <span className="min-w-0">
                    {href ? (
                      <Link
                        href={href}
                        className="block truncate font-mono text-xs hover:text-accent"
                        title={hotspot.file.path}
                      >
                        {hotspot.file.path}
                      </Link>
                    ) : (
                      <span className="block truncate font-mono text-xs">{hotspot.file.path}</span>
                    )}
                    <span className="text-2xs text-faint">
                      {plural(hotspot.commits, 'commit')} · {plural(hotspot.churn, 'line')} ·{' '}
                      {plural(hotspot.defectCount, 'defect commit')}
                    </span>
                  </span>
                  <span className="font-mono text-xs tabular-nums text-accent">
                    {hotspot.score.toFixed(2)}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Recent commits">
          {commits.length === 0 ? (
            <Empty>No commits indexed.</Empty>
          ) : (
            <ul className="flex flex-col gap-2">
              {commits.map((commit) => (
                <li key={commit.id} className="grid grid-cols-[auto_1fr] gap-x-3 text-sm">
                  <span className="font-mono text-xs text-faint">{shortSha(commit.sha)}</span>
                  <span className="truncate" title={commit.subject}>
                    {commit.subject}
                  </span>
                  <span />
                  <span className="text-2xs text-faint">
                    {commit.authorName} · {day(commit.committedAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Recent investigations">
          {investigations.length === 0 ? (
            <Empty>
              None yet.{' '}
              <Link href={`/r/${id}/investigate`} className="text-accent hover:underline">
                Ask a question
              </Link>
              .
            </Empty>
          ) : (
            <ul className="flex flex-col gap-1">
              {investigations.map((investigation) => (
                <li key={investigation.id}>
                  <Link
                    href={`/r/${id}/investigate?show=${investigation.id}`}
                    className="flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-raised"
                  >
                    <span className="text-sm">{investigation.query}</span>
                    <span className="flex items-center gap-2 text-2xs text-faint">
                      <LevelBadge level={investigation.classification} />
                      {investigation.confidence.toFixed(2)} · {when(investigation.createdAt)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </div>
  );
}
