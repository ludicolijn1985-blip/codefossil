import { FileSearch } from '@/components/file-search';
import { Problem } from '@/components/problem';
import { PageHeader } from '@/components/ui';
import { fossil } from '@/lib/api';
import { idParam } from '@/lib/route';
import type { FileListItem } from '@/lib/types';

export default async function Files({ params }: { params: Promise<{ id: string }> }) {
  const id = idParam((await params).id);
  let files: FileListItem[];
  try {
    files = await fossil<FileListItem[]>(`/api/repositories/${id}/files?limit=100`);
  } catch (error) {
    return <Problem error={error} />;
  }
  return (
    <div className="flex max-w-4xl flex-col">
      <PageHeader eyebrow="Files" title="Every file the history has seen">
        Including deleted and renamed files: their history is still evidence.
      </PageHeader>
      <FileSearch repositoryId={id} initial={files} />
    </div>
  );
}
