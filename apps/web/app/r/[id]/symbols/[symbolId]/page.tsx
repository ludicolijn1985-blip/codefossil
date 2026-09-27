import Link from 'next/link';
import { notFound } from 'next/navigation';
import { WhyView } from '@/components/investigation-view';
import { Problem } from '@/components/problem';
import { PageHeader } from '@/components/ui';
import { fossilOrNull } from '@/lib/api';
import { idParam } from '@/lib/route';
import type { SymbolDetail } from '@/lib/types';

export default async function SymbolPage({
  params,
}: {
  params: Promise<{ id: string; symbolId: string }>;
}) {
  const raw = await params;
  const id = idParam(raw.id);
  const symbolId = idParam(raw.symbolId);
  let detail: SymbolDetail | null;
  try {
    detail = await fossilOrNull<SymbolDetail>(`/api/repositories/${id}/symbols/${symbolId}`);
  } catch (error) {
    return <Problem error={error} />;
  }
  if (!detail) notFound();
  const { symbol, why } = detail;

  return (
    <div className="flex max-w-6xl flex-col">
      <PageHeader
        eyebrow={`Symbol · ${symbol.kind}${symbol.current ? '' : ' · removed'}`}
        title={symbol.qualifiedName}
      >
        <span className="font-mono text-xs">
          {symbol.path}:{symbol.startLine}–{symbol.endLine}
        </span>{' '}
        ·{' '}
        <Link
          href={`/r/${id}/investigate?q=${encodeURIComponent(`What depends on ${symbol.path}?`)}`}
          className="text-accent hover:underline"
        >
          What depends on its file?
        </Link>
      </PageHeader>
      <WhyView why={why} />
    </div>
  );
}
