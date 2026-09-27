import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Problem } from '@/components/problem';
import { fossil } from '@/lib/api';
import { when } from '@/lib/format';
import type { RepositoryRow } from '@/lib/types';

export default async function Home() {
  let repositories: RepositoryRow[];
  try {
    repositories = await fossil<RepositoryRow[]>('/api/repositories');
  } catch (error) {
    return (
      <main id="main" className="px-4">
        <Problem error={error} />
      </main>
    );
  }
  const [only] = repositories;
  if (repositories.length === 1 && only) redirect(`/r/${only.id}`);

  return (
    <main id="main" className="mx-auto max-w-3xl px-4 py-16">
      <p className="font-mono text-2xs uppercase tracking-[0.18em] text-accent">CODEFOSSIL</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Indexed repositories</h1>
      {repositories.length === 0 ? (
        <p className="mt-6 text-sm text-muted">
          Nothing is indexed yet. Run <code className="font-mono text-ink">fossil init</code> and{' '}
          <code className="font-mono text-ink">fossil index</code> in a repository.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-line rounded-[var(--radius-panel)] border border-line bg-surface/90">
          {repositories.map((repository) => (
            <li key={repository.id}>
              <Link
                href={`/r/${repository.id}`}
                className="flex flex-col gap-0.5 px-4 py-3 hover:bg-raised"
              >
                <span className="font-medium">{repository.name}</span>
                <span className="font-mono text-xs text-faint">
                  {repository.path} · indexed {when(repository.indexedAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
