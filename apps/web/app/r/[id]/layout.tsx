import Link from 'next/link';
import type { ReactNode } from 'react';
import { Nav } from '@/components/nav';
import { Problem } from '@/components/problem';
import { Shortcuts } from '@/components/shortcuts';
import { fossil } from '@/lib/api';
import { day, shortSha } from '@/lib/format';
import { idParam } from '@/lib/route';
import type { RepositoryDetail } from '@/lib/types';

export default async function RepositoryLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const id = idParam((await params).id);
  let repository: RepositoryDetail;
  try {
    repository = await fossil<RepositoryDetail>(`/api/repositories/${id}`);
  } catch (error) {
    return (
      <main id="main" className="px-4">
        <Problem error={error} />
      </main>
    );
  }
  const base = `/r/${id}`;
  const items = [
    { href: base, label: 'Overview', hint: 'g o' },
    { href: `${base}/investigate`, label: 'Investigate', hint: 'g i' },
    { href: `${base}/files`, label: 'Files', hint: 'g f' },
    { href: `${base}/graph`, label: 'Graph', hint: 'g g' },
    { href: `${base}/hotspots`, label: 'Hotspots', hint: 'g h' },
    { href: `${base}/dead-intent`, label: 'Dead intent', hint: 'g x' },
    { href: `${base}/dependencies`, label: 'Dependencies', hint: 'g d' },
  ];
  const latest = repository.status.latestCommit;
  const head = repository.status.head;
  const indexedSha = head?.indexedSha ?? null;
  const offHistory = head?.freshness === 'diverged' || head?.freshness === 'unknown';

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside className="flex flex-col gap-4 border-b border-line bg-surface/60 px-3 py-4 lg:sticky lg:top-0 lg:h-screen lg:w-60 lg:shrink-0 lg:gap-6 lg:border-b-0 lg:border-r">
        <div className="px-3">
          <Link
            href="/"
            className="font-mono text-2xs uppercase tracking-[0.18em] text-accent hover:underline"
          >
            CODEFOSSIL
          </Link>
          <p className="mt-2 truncate font-semibold" title={repository.path}>
            {repository.name}
          </p>
          <p className="font-mono text-2xs text-faint">
            {indexedSha
              ? `indexed at ${shortSha(indexedSha)}${latest ? ` · ${day(latest.committedAt)}` : ''}`
              : 'not indexed'}
          </p>
          {offHistory ? (
            <p role="alert" className="mt-2 text-2xs leading-relaxed text-danger">
              HEAD left the indexed history; answers may cite commits HEAD does not contain. Run{' '}
              <code>codefossil index</code>.
            </p>
          ) : null}
        </div>
        <Nav items={items} />
        <p className="mt-auto hidden px-3 font-mono text-2xs leading-relaxed text-faint lg:block">
          <kbd>/</kbd> search · <kbd>g</kbd> then a letter to jump
        </p>
      </aside>
      <main id="main" className="min-w-0 flex-1 px-4 py-6 sm:px-8 lg:py-10">
        {children}
      </main>
      <Shortcuts base={base} />
    </div>
  );
}
