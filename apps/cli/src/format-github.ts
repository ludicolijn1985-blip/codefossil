import type { GitHubIndexResult } from '@codefossil/core';
import type { ProviderCounts } from '@codefossil/db';
import { plural } from './format.js';

export interface GitHubStatus extends ProviderCounts {
  readonly owner: string;
  readonly name: string;
  readonly apiUrl: string;
  readonly lastSyncedAt: string | null;
}

function formatLinks(result: GitHubIndexResult): string {
  const { links } = result;
  return (
    `Links: ${plural(links.pullRequestCommits, 'pull request → commit')}, ` +
    `${plural(links.resolutions, 'issue resolution')}, ${plural(links.references, 'reference')}.\n`
  );
}

export function formatGitHubIndex(result: GitHubIndexResult | null): string {
  if (!result) return '';
  const slug = `${result.owner}/${result.name}`;
  const { sync } = result;
  if (!sync) return `GitHub ${slug}: offline, linked stored data. ${formatLinks(result)}`;

  const pending =
    sync.detailsPending > 0 ? `; ${plural(sync.detailsPending, 'pull request')} still pending` : '';
  const lines = [
    `GitHub ${slug}: synced ${plural(sync.issues, 'issue')} and ` +
      `${plural(sync.pullRequests, 'pull request')} with ${plural(sync.requests, 'request')}; ` +
      `fetched details of ${plural(sync.detailsFetched, 'pull request')}${pending}.\n`,
    formatLinks(result),
  ];
  if (sync.stoppedEarly) {
    lines.push(`Note: ${sync.stoppedEarly}. Run \`fossil index\` again later to continue.\n`);
  }
  return lines.join('');
}

export function formatGitHubStatus(github: GitHubStatus | null): string {
  if (!github) return 'GitHub         not connected — run `fossil connect github`\n';
  const pending =
    github.pendingPullRequestDetails > 0
      ? `, ${plural(github.pendingPullRequestDetails, 'pull request')} awaiting details`
      : '';
  return (
    `GitHub         ${github.owner}/${github.name} — ${plural(github.issues, 'issue')}, ` +
    `${plural(github.pullRequests, 'pull request')}${pending}; ` +
    `last synced ${github.lastSyncedAt ?? 'never'}\n`
  );
}
