import type { GitHubToken } from '@codefossil/providers';

/** Where CLI output goes. Injected so commands can be tested without a real terminal. */
export interface CliIO {
  readonly cwd: string;
  stdout(text: string): void;
  stderr(text: string): void;
  /**
   * Finds a GitHub token for a host. Defaults to the environment and the
   * GitHub CLI; tests inject their own so they never see real credentials.
   */
  readonly resolveGitHubToken?: (host: string) => Promise<GitHubToken | null>;
}

/** An error meant for the user: printed without a stack trace. */
export class CliError extends Error {
  override readonly name = 'CliError';

  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
  }
}

export function writeJson(io: CliIO, value: unknown): void {
  io.stdout(`${JSON.stringify(value, null, 2)}\n`);
}
