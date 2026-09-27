'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ClientApiError, request } from '@/lib/client';
import type { FileListItem } from '@/lib/types';
import { Empty } from './ui';

const DEBOUNCE_MS = 150;

/** Search indexed files by path; results update as you type. */
export function FileSearch({
  repositoryId,
  initial,
}: {
  repositoryId: number;
  initial: readonly FileListItem[];
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ query: string; files: readonly FileListItem[] } | null>(
    null,
  );
  const [problem, setProblem] = useState<{ query: string; message: string } | null>(null);
  const text = query.trim();

  useEffect(() => {
    if (!text) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      request<FileListItem[]>(
        `/repositories/${repositoryId}/files?query=${encodeURIComponent(text)}&limit=100`,
      )
        .then((files) => {
          if (!cancelled) setFound({ query: text, files });
        })
        .catch((error: unknown) => {
          if (!cancelled) {
            setProblem({
              query: text,
              message: error instanceof ClientApiError ? error.message : 'The search failed.',
            });
          }
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [text, repositoryId]);

  // Until the answer for the current text arrives, the previous list stays up.
  const results = !text ? initial : (found?.files ?? initial);
  const message = text && problem?.query === text ? problem.message : null;

  return (
    <div className="flex flex-col gap-3">
      <label htmlFor="file-search" className="sr-only">
        Search files by path
      </label>
      <input
        id="file-search"
        data-shortcut="search"
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
        }}
        placeholder="Filter by path…   ( / )"
        autoComplete="off"
        className="rounded-md border border-line bg-ground px-3 py-2.5 font-mono text-sm placeholder:text-faint focus:border-accent/60 focus:outline-none"
      />
      {message ? (
        <p role="alert" className="text-sm text-danger">
          {message}
        </p>
      ) : null}
      {results.length === 0 ? (
        <Empty>No indexed file matches.</Empty>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-[var(--radius-panel)] border border-line bg-surface/90">
          {results.map((file) => (
            <li key={file.id}>
              <Link
                href={`/r/${repositoryId}/files/${file.id}`}
                className="flex items-center justify-between gap-4 px-4 py-2 font-mono text-sm transition-colors hover:bg-raised"
              >
                <span className={`break-all ${file.deletedAt ? 'text-faint line-through' : ''}`}>
                  {file.path}
                </span>
                <span className="shrink-0 text-2xs text-faint">
                  {file.deletedAt ? 'deleted' : (file.language ?? '')}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
