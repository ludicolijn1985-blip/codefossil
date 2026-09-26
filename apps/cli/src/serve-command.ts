import type { Command } from 'commander';
import { buildServer } from '@codefossil/api';
import { planGitHubSync } from './github.js';
import { CliError, type CliIO } from './io.js';
import { openWorkspace } from './workspace.js';

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
const DEFAULT_PORT = 4000;

interface ServeOptions {
  readonly port: string;
  readonly host: string;
  readonly allowNetwork?: boolean;
  readonly githubMaxRequests: string;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new CliError(`--port must be a port number, got "${value}".`);
  }
  return port;
}

function parseCount(value: string): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count <= 0) {
    throw new CliError(`--github-max-requests must be a positive whole number, got "${value}".`);
  }
  return count;
}

export function registerServeCommand(program: Command, io: CliIO, repoPath: () => string): void {
  program
    .command('serve')
    .description(
      'Serve the JSON API for this repository on this machine only. Indexing through the API is ' +
        'offline unless --allow-network is given.',
    )
    .option('--port <port>', 'port to listen on', String(DEFAULT_PORT))
    .option('--host <host>', 'loopback address to listen on', '127.0.0.1')
    .option('--allow-network', 'let API clients trigger GitHub syncs (uses your GitHub token)')
    .option('--github-max-requests <n>', 'GitHub requests allowed per sync', '1000')
    .action(async (options: ServeOptions) => {
      if (!LOOPBACK.has(options.host)) {
        throw new CliError(
          `--host must be a loopback address (127.0.0.1, ::1 or localhost); the API has no authentication.`,
        );
      }
      const port = parsePort(options.port);
      const ws = await openWorkspace(repoPath());
      try {
        const plan = options.allowNetwork
          ? await planGitHubSync(ws, io, {
              offline: false,
              maxRequests: parseCount(options.githubMaxRequests),
            })
          : undefined;
        for (const note of plan?.notes ?? []) io.stderr(`Note: ${note}\n`);
        const app = await buildServer({
          fossil: ws.fossil,
          allowNetwork: options.allowNetwork === true,
          ...(plan?.factory && plan.apiUrl
            ? { github: { apiUrl: plan.apiUrl, client: plan.factory } }
            : {}),
          logger: { level: 'warn' },
        });
        const url = await app.listen({ port, host: options.host });
        const close = async () => {
          await app.close();
          ws.fossil.close();
        };
        io.stdout(
          `CODEFOSSIL API for ${ws.root} listening on ${url}` +
            `${options.allowNetwork ? ' (network sync allowed)' : ''}. Press Ctrl+C to stop.\n`,
        );
        if (io.onServe) {
          io.onServe({ url, close });
        } else {
          for (const signal of ['SIGINT', 'SIGTERM'] as const) {
            process.once(signal, () => {
              void close().then(() => process.exit(0));
            });
          }
        }
      } catch (error) {
        ws.fossil.close();
        throw error;
      }
    });
}
