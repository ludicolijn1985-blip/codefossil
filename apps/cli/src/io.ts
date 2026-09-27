import type { AiConfig, AiProvider } from '@codefossil/ai';
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
  /** Lines typed or piped in, for `fossil investigate`. */
  readonly readLines?: () => AsyncIterable<string>;
  /** Whether a person is typing (show prompts), as opposed to piped input. */
  readonly interactive?: boolean;
  /** Receives a started API server instead of wiring process signals (tests). */
  readonly onServe?: (server: { url: string; close: () => Promise<void> }) => void;
  /** The current time, for analyses that measure age; tests pin it. */
  readonly now?: () => Date;
  /** Builds the AI provider from its configuration; tests inject a fake that contacts nothing. */
  readonly createAiProvider?: (config: AiConfig) => AiProvider;
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
