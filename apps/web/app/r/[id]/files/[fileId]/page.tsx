import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ImpactView, WhyView } from '@/components/investigation-view';
import { Problem } from '@/components/problem';
import { TimelineList } from '@/components/timeline-list';
import { Empty, PageHeader, Panel } from '@/components/ui';
import { fossil, fossilOrNull } from '@/lib/api';
import { day, shortSha } from '@/lib/format';
import { idParam, oneParam } from '@/lib/route';
import type { FileDetail, ImpactReport, Timeline, WhyInvestigation } from '@/lib/types';

const TABS = [
  { id: 'symbols', label: 'Symbols' },
  { id: 'history', label: 'History' },
  { id: 'why', label: 'Why' },
  { id: 'impact', label: 'Impact' },
  { id: 'deps', label: 'Imports' },
] as const;
type Tab = (typeof TABS)[number]['id'];

const isTab = (value: string | undefined): value is Tab => TABS.some((t) => t.id === value);

function Symbols({ repositoryId, detail }: { repositoryId: number; detail: FileDetail }) {
  if (detail.symbols.length === 0) return <Empty>No symbols extracted from this file.</Empty>;
  return (
    <table className="w-full text-left text-sm">
      <thead className="font-mono text-2xs uppercase tracking-wider text-faint">
        <tr>
          <th className="pb-2 font-normal">Symbol</th>
          <th className="pb-2 font-normal">Lines</th>
          <th className="hidden pb-2 font-normal md:table-cell">Introduced</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {detail.symbols.map((symbol) => (
          <tr key={symbol.id}>
            <td className="py-1.5 pr-4">
              <Link href={`/r/${repositoryId}/symbols/${symbol.id}`} className="hover:text-accent">
                <span className="mr-2 font-mono text-2xs text-faint">{symbol.kind}</span>
                <span className="font-mono">{symbol.qualifiedName}</span>
              </Link>
            </td>
            <td className="py-1.5 pr-4 font-mono text-xs text-muted">
              {symbol.startLine}–{symbol.endLine}
            </td>
            <td className="hidden py-1.5 text-xs text-muted md:table-cell">
              {symbol.introducedBy
                ? `${shortSha(symbol.introducedBy.sha)} · ${day(symbol.introducedBy.committedAt)}`
                : 'not established'}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Imports({ repositoryId, detail }: { repositoryId: number; detail: FileDetail }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Imports" aside={String(detail.imports.length)}>
        {detail.imports.length === 0 ? (
          <Empty>No imports.</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5 font-mono text-xs">
            {detail.imports.map((row) => (
              <li key={row.id}>
                <span className="text-faint">{String(row.line).padStart(4)} </span>
                {row.specifier}
                <span
                  className={`ml-2 ${row.resolution === 'unresolved' ? 'text-inferred' : 'text-faint'}`}
                >
                  {row.resolution ?? 'pending'}
                  {row.resolutionDetail ? ` · ${row.resolutionDetail}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel title="Imported by" aside={String(detail.importedBy.length)}>
        {detail.importedBy.length === 0 ? (
          <Empty>No indexed file imports this one.</Empty>
        ) : (
          <ul className="flex flex-col gap-1.5 font-mono text-xs">
            {detail.importedBy.map((row) => (
              <li key={row.path}>
                <Link
                  href={`/r/${repositoryId}/graph?root=${encodeURIComponent(row.path)}`}
                  className="hover:text-accent"
                >
                  {row.path}
                </Link>
                <span className="ml-2 text-faint">{row.confidence.toFixed(2)}</span>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}

type TabData =
  | { tab: 'symbols' | 'deps' }
  | { tab: 'history'; timeline: Timeline }
  | { tab: 'why'; why: WhyInvestigation }
  | { tab: 'impact'; impact: ImpactReport };

/** Fetch what the selected tab needs; symbols and imports come with the file itself. */
async function loadTab(base: string, tab: Tab, path: string): Promise<TabData> {
  switch (tab) {
    case 'symbols':
    case 'deps':
      return { tab };
    case 'history':
      return {
        tab,
        timeline: await fossil<Timeline>(`${base}/timeline?path=${encodeURIComponent(path)}`),
      };
    case 'why': {
      const answer = await fossil<{ result: WhyInvestigation }>(`${base}/investigate`, {
        target: path,
        kind: 'why',
        save: false,
      });
      return { tab, why: answer.result };
    }
    case 'impact':
      return {
        tab,
        impact: await fossil<ImpactReport>(`${base}/impact?target=${encodeURIComponent(path)}`),
      };
  }
}

export default async function FilePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; fileId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await params;
  const id = idParam(raw.id);
  const fileId = idParam(raw.fileId);
  const requested = oneParam((await searchParams).tab);
  const tab: Tab = isTab(requested) ? requested : 'symbols';
  const base = `/api/repositories/${id}`;

  let detail: FileDetail | null;
  let view: TabData = { tab: 'symbols' };
  try {
    detail = await fossilOrNull<FileDetail>(`${base}/files/${fileId}`);
    if (detail) view = await loadTab(base, tab, detail.file.path);
  } catch (error) {
    return <Problem error={error} />;
  }
  if (!detail) notFound();

  const { file } = detail;
  return (
    <div className="flex max-w-6xl flex-col">
      <PageHeader
        eyebrow={
          file.deletedAt ? 'File · deleted' : `File · ${file.language ?? 'unknown language'}`
        }
        title={file.path}
      >
        <Link
          href={`/r/${id}/graph?root=${encodeURIComponent(file.path)}`}
          className="text-accent hover:underline"
        >
          Open in graph
        </Link>
      </PageHeader>
      <nav aria-label="File views" className="mb-5 flex gap-1 overflow-x-auto border-b border-line">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={`/r/${id}/files/${fileId}?tab=${t.id}`}
            aria-current={t.id === tab ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm transition-colors ${
              t.id === tab
                ? 'border-accent text-ink'
                : 'border-transparent text-muted hover:text-ink'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {view.tab === 'symbols' ? <Symbols repositoryId={id} detail={detail} /> : null}
      {view.tab === 'deps' ? <Imports repositoryId={id} detail={detail} /> : null}
      {view.tab === 'history' ? <TimelineList timeline={view.timeline} /> : null}
      {view.tab === 'why' ? <WhyView why={view.why} /> : null}
      {view.tab === 'impact' ? <ImpactView report={view.impact} /> : null}
    </div>
  );
}
