import Link from 'next/link';
import { Problem } from '@/components/problem';
import { Empty, PageHeader } from '@/components/ui';
import { fossil } from '@/lib/api';
import { idParam } from '@/lib/route';
import type { DependencyUsage } from '@/lib/types';

export default async function Dependencies({ params }: { params: Promise<{ id: string }> }) {
  const id = idParam((await params).id);
  let dependencies: DependencyUsage[];
  try {
    dependencies = await fossil<DependencyUsage[]>(`/api/repositories/${id}/dependencies`);
  } catch (error) {
    return <Problem error={error} />;
  }
  const unused = dependencies.filter((d) => d.usedBy === 0 && !d.internal).length;

  return (
    <div className="flex max-w-5xl flex-col">
      <PageHeader eyebrow="Dependencies" title="What the manifests declare, and who imports it">
        {unused > 0
          ? `${unused} declared ${unused === 1 ? 'dependency is' : 'dependencies are'} not imported by any indexed file — tools, types and config-only packages often look like this.`
          : 'Import counts come from resolved imports at HEAD.'}
      </PageHeader>
      {dependencies.length === 0 ? (
        <Empty>No manifest declares dependencies.</Empty>
      ) : (
        <div className="overflow-x-auto rounded-[var(--radius-panel)] border border-line bg-surface/90">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-line font-mono text-2xs uppercase tracking-wider text-faint">
              <tr>
                <th className="px-4 py-2 font-normal">Name</th>
                <th className="px-4 py-2 font-normal">Version</th>
                <th className="px-4 py-2 font-normal">Scope</th>
                <th className="px-4 py-2 font-normal">Manifest</th>
                <th className="px-4 py-2 text-right font-normal">Imported by</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {dependencies.map((dependency) => (
                <tr key={dependency.id} className="hover:bg-raised/50">
                  <td className="px-4 py-1.5">
                    <Link
                      href={`/r/${id}/graph?root=${encodeURIComponent(`${dependency.ecosystem}:${dependency.name}`)}`}
                      className="font-mono hover:text-accent"
                    >
                      {dependency.name}
                    </Link>
                    {dependency.internal ? (
                      <span className="ml-2 text-2xs text-derived">workspace</span>
                    ) : null}
                  </td>
                  <td className="px-4 py-1.5 font-mono text-xs text-muted">
                    {dependency.version ?? '—'}
                  </td>
                  <td className="px-4 py-1.5 text-xs text-muted">{dependency.scope}</td>
                  <td className="px-4 py-1.5 font-mono text-xs text-faint">
                    {dependency.manifestFile}
                  </td>
                  <td
                    className={`px-4 py-1.5 text-right font-mono text-xs tabular-nums ${
                      dependency.usedBy === 0 ? 'text-faint' : ''
                    }`}
                  >
                    {dependency.usedBy}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
