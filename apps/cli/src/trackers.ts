import type { ProviderConnectionRow } from '@codefossil/db';
import { JiraClient, LinearClient, type TrackerClient } from '@codefossil/providers';
import type { CliIO } from './io.js';

export const JIRA_TOKEN_ENV = 'JIRA_API_TOKEN';
export const JIRA_EMAIL_ENV = 'JIRA_EMAIL';
export const LINEAR_TOKEN_ENV = 'LINEAR_API_KEY';

export interface TrackerPlan {
  readonly factory: ((connection: ProviderConnectionRow) => TrackerClient | null) | undefined;
  readonly notes: readonly string[];
}

/**
 * Clients for the connected Jira and Linear trackers, with credentials read
 * from the environment at run time and never stored. A tracker without
 * credentials stays offline: its stored issues are still linked.
 */
export function planTrackerSync(
  io: CliIO,
  connections: readonly ProviderConnectionRow[],
  options: { readonly offline: boolean; readonly maxRequests: number },
): TrackerPlan {
  const env = io.env ?? process.env;
  const trackers = connections.filter((c) => c.provider === 'jira' || c.provider === 'linear');
  if (trackers.length === 0 || options.offline) return { factory: undefined, notes: [] };
  const notes: string[] = [];
  const jiraToken = env[JIRA_TOKEN_ENV];
  const linearKey = env[LINEAR_TOKEN_ENV];
  if (trackers.some((c) => c.provider === 'jira') && !jiraToken) {
    notes.push(`No ${JIRA_TOKEN_ENV} set; Jira is not synced (stored issues are still linked).`);
  }
  if (trackers.some((c) => c.provider === 'linear') && !linearKey) {
    notes.push(
      `No ${LINEAR_TOKEN_ENV} set; Linear is not synced (stored issues are still linked).`,
    );
  }
  return {
    factory: (connection) => {
      if (connection.provider === 'jira' && jiraToken) {
        return new JiraClient({
          url: connection.apiUrl,
          token: jiraToken,
          email: env[JIRA_EMAIL_ENV] ?? null,
          maxRequests: options.maxRequests,
        });
      }
      if (connection.provider === 'linear' && linearKey) {
        return new LinearClient({
          apiKey: linearKey,
          url: connection.apiUrl,
          maxRequests: options.maxRequests,
        });
      }
      return null;
    },
    notes,
  };
}
