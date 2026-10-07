import type { GitHubIndexResult, TrackerIndexResult } from '@codefossil/core';
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
  const extras = [
    sync.closingRefsFetched > 0
      ? `closing issues of ${plural(sync.closingRefsFetched, 'pull request')}`
      : '',
    sync.foreignIssues > 0 ? `${plural(sync.foreignIssues, 'issue')} of other repositories` : '',
  ].filter((extra) => extra !== '');
  const read = extras.length > 0 ? `; read ${extras.join(' and ')}` : '';
  const lines = [
    `GitHub ${slug}: synced ${plural(sync.issues, 'issue')} and ` +
      `${plural(sync.pullRequests, 'pull request')} with ${plural(sync.requests, 'request')}; ` +
      `fetched details of ${plural(sync.detailsFetched, 'pull request')}${pending}${read}.\n`,
    formatLinks(result),
  ];
  if (sync.closingRefsError) {
    lines.push(
      `Note: GitHub's closing issue links could not be read (${sync.closingRefsError}); ` +
        'pull requests keep their keyword-based links.\n',
    );
  }
  if (sync.foreignIssuesError) {
    lines.push(
      `Note: issues of other repositories could not be read (${sync.foreignIssuesError}); ` +
        'the next sync tries again.\n',
    );
  }
  if (sync.stoppedEarly) {
    lines.push(`Note: ${sync.stoppedEarly}. Run \`codefossil index\` again later to continue.\n`);
  }
  return lines.join('');
}

export function formatGitHubStatus(github: GitHubStatus | null): string {
  if (!github) return 'GitHub         not connected — run `codefossil connect github`\n';
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

export function formatTrackers(trackers: readonly TrackerIndexResult[]): string {
  return trackers
    .map((tracker) => {
      const label = tracker.provider === 'jira' ? 'Jira' : 'Linear';
      const links = `${plural(tracker.links.references, 'reference')} linked`;
      if (!tracker.sync) return `${label}: offline, ${links}.\n`;
      const { sync } = tracker;
      const stopped = sync.stoppedEarly ? ` Note: ${sync.stoppedEarly}.` : '';
      return (
        `${label}: read ${plural(sync.issues, 'issue')} from ${plural(sync.projects, 'project')} ` +
        `with ${plural(sync.requests, 'request')}; ${links}.${stopped}\n`
      );
    })
    .join('');
}
