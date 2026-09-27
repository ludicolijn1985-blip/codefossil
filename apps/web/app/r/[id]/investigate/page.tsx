import Link from 'next/link';
import { Ask } from '@/components/ask';
import { ImpactView, WhyView } from '@/components/investigation-view';
import { Problem } from '@/components/problem';
import { Empty, LevelBadge, PageHeader, Panel } from '@/components/ui';
import { fossil, fossilOrNull } from '@/lib/api';
import { shortSha, when } from '@/lib/format';
import { idParam, oneParam } from '@/lib/route';
import type { AiStatus, ImpactReport, InvestigationRow, WhyInvestigation } from '@/lib/types';

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

function Saved({ investigation }: { investigation: InvestigationRow }) {
  const result = investigation.resultJson as WhyInvestigation | ImpactReport | null;
  return (
    <section aria-label="Saved investigation" className="flex flex-col gap-3">
      <p className="text-xs text-muted">
        Saved {when(investigation.createdAt)}
        {investigation.headSha ? ` at HEAD ${shortSha(investigation.headSha)}` : ''} — later history
        may change the answer; ask again to recompute it.
      </p>
      {result?.kind === 'why' ? <WhyView why={result} /> : null}
      {result?.kind === 'impact' ? <ImpactView report={result} /> : null}
      {result ? null : (
        <Panel title="Answer">
          <p>{investigation.answer}</p>
          <p className="mt-2 text-xs text-muted">
            The full evidence of this older investigation was not stored.
          </p>
        </Panel>
      )}
    </section>
  );
}

export default async function Investigate({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: SearchParams;
}) {
  const id = idParam((await params).id);
  const query = await searchParams;
  const question = oneParam(query.q)?.slice(0, 1000);
  const show = oneParam(query.show);
  const showId = show && /^[1-9]\d{0,15}$/.test(show) ? show : null;

  let history: InvestigationRow[];
  let saved: InvestigationRow | null;
  let ai: AiStatus;
  try {
    [history, saved, ai] = await Promise.all([
      fossil<InvestigationRow[]>(`/api/repositories/${id}/investigations?limit=30`),
      showId
        ? fossilOrNull<InvestigationRow>(`/api/repositories/${id}/investigations/${showId}`)
        : null,
      fossil<AiStatus>('/api/ai'),
    ]);
  } catch (error) {
    return <Problem error={error} />;
  }

  return (
    <div className="grid max-w-7xl gap-8 2xl:grid-cols-[minmax(0,1fr)_18rem]">
      <div className="flex min-w-0 flex-col gap-6">
        <PageHeader eyebrow="Investigate" title="Ask why, what depends on it, or how it changed">
          Every answer is built from stored evidence. Statements carry their own level and
          confidence; select one to see what it rests on.
        </PageHeader>
        <Ask repositoryId={id} ai={ai} {...(question ? { initial: question } : {})} />
        {showId && !saved ? <Empty>Investigation {showId} was not found.</Empty> : null}
        {saved ? <Saved investigation={saved} /> : null}
      </div>

      <Panel title="History" className="self-start">
        {history.length === 0 ? (
          <Empty>No saved investigations.</Empty>
        ) : (
          <ul className="flex flex-col gap-1">
            {history.map((item) => (
              <li key={item.id}>
                <Link
                  href={`/r/${id}/investigate?show=${item.id}`}
                  aria-current={String(item.id) === showId ? 'true' : undefined}
                  className={`flex flex-col gap-1 rounded-md px-2 py-1.5 text-sm hover:bg-raised ${
                    String(item.id) === showId ? 'bg-raised' : ''
                  }`}
                >
                  {item.query}
                  <span className="flex items-center gap-2 text-2xs text-faint">
                    <LevelBadge level={item.classification} /> {item.confidence.toFixed(2)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  );
}
