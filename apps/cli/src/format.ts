import type { IndexStatus } from '@codefossil/db';

const SHORT_SHA_LENGTH = 7;

/** `plural(1, 'commit')` → "1 commit", `plural(2, 'commit')` → "2 commits". */
export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function rows(entries: readonly (readonly [string, string])[]): string {
  const width = Math.max(...entries.map(([label]) => label.length));
  return entries.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n');
}

export function formatStatus(status: IndexStatus): string {
  const { repository, counts, latestCommit } = status;
  const header = rows([
    [
      'Repository',
      repository.defaultBranch
        ? `${repository.name} (${repository.defaultBranch})`
        : repository.name,
    ],
    ['Path', repository.path],
    ['Remote', repository.remoteUrl ?? '—'],
    ['Indexed', repository.indexedAt ?? 'never — run `fossil index`'],
    [
      'Latest commit',
      latestCommit
        ? `${latestCommit.sha.slice(0, SHORT_SHA_LENGTH)} ${latestCommit.committedAt}`
        : '—',
    ],
  ]);
  const body = rows([
    ['Commits', String(counts.commits)],
    ['Files', `${counts.files} (${counts.currentFiles} current)`],
    ['File changes', String(counts.fileChanges)],
    ['Evidence', String(counts.evidence)],
    [
      'Relations',
      `${counts.relations.FACT} FACT · ${counts.relations.DERIVED} DERIVED · ${counts.relations.INFERRED} INFERRED`,
    ],
  ]);
  return `${header}\n\n${body}\n`;
}
