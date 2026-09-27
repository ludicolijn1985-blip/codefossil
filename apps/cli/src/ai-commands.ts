import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Option, type Command } from 'commander';
import {
  AI_CONFIG_FILE,
  AI_PROVIDERS,
  AiConfigError,
  AiProviderError,
  askWithEvidence,
  createProvider,
  DEFAULT_MODELS,
  loadAiConfig,
  saveAiConfig,
  summarizeWhy,
  validateAiConfig,
  type AiConfig,
  type AiProvider,
  type AiProviderName,
} from '@codefossil/ai';
import { investigateWhy, recordInvestigation, type TargetMatch } from '@codefossil/query';
import { formatAiAnswer, formatAiConfig } from './format-ai.js';
import { formatWhy } from './format-investigation.js';
import { CliError, writeJson, type CliIO } from './io.js';
import { openWorkspace, withWorkspace, type Workspace } from './workspace.js';

const workspaceDir = (ws: Workspace) => dirname(ws.databasePath);

function readConfig(ws: Workspace): AiConfig | null {
  try {
    return loadAiConfig(workspaceDir(ws));
  } catch (error) {
    if (error instanceof AiConfigError) throw new CliError(error.message);
    throw error;
  }
}

/** The configured provider, or a clear message that the AI layer is off. */
export function providerFor(ws: Workspace, io: CliIO): { config: AiConfig; provider: AiProvider } {
  const config = readConfig(ws);
  if (!config) {
    throw new CliError(
      'The AI layer is off. Configure it with `fossil ai configure` (see `fossil ai status`); ' +
        'recognized questions work without it through `fossil query`.',
    );
  }
  return { config, provider: (io.createAiProvider ?? createProvider)(config) };
}

async function runAi<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof AiProviderError) throw new CliError(error.message);
    throw error;
  }
}

/** `fossil why --summarize`: the deterministic answer, then an AI summary citing its evidence. */
export async function whyWithSummary(
  ws: Workspace,
  io: CliIO,
  match: TargetMatch,
  options: { readonly json?: boolean; readonly save: boolean },
): Promise<void> {
  const { config, provider } = providerFor(ws, io);
  const why = investigateWhy(ws.fossil.db, ws.repositoryId, match.ref);
  const savedId = options.save ? recordInvestigation(ws.fossil.db, ws.repositoryId, why) : null;
  const summary = await runAi(() =>
    summarizeWhy(provider, why, { includeSource: config.includeSource }),
  );
  if (options.json) writeJson(io, { ...why, investigationId: savedId, summary });
  else io.stdout(`${formatWhy(why, savedId)}\n${formatAiAnswer(summary)}`);
}

interface ConfigureOptions {
  readonly provider: AiProviderName;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly allowCloud?: boolean;
  readonly includeSource?: boolean;
}

export function registerAiCommands(program: Command, io: CliIO, repoPath: () => string): void {
  const ai = program
    .command('ai')
    .description(
      'Configure the optional AI layer (off by default; nothing is sent until configured).',
    );

  ai.command('configure')
    .description('Choose a provider and model. Cloud providers need --allow-cloud.')
    .addOption(
      new Option('--provider <name>', 'where the model runs')
        .choices([...AI_PROVIDERS])
        .makeOptionMandatory(),
    )
    .option(
      '--model <model>',
      'model name (default: llama3.1 for ollama, claude-opus-5 for anthropic)',
    )
    .option('--base-url <url>', 'ollama only: where it listens (default http://127.0.0.1:11434)')
    .option(
      '--allow-cloud',
      'agree that evidence (commit, issue and PR text, paths) may leave this machine',
    )
    .option('--include-source', 'also send source excerpts (symbol signatures); off by default')
    .action(async (options: ConfigureOptions) => {
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        let config: AiConfig;
        try {
          config = validateAiConfig({
            provider: options.provider,
            model: options.model ?? DEFAULT_MODELS[options.provider],
            ...(options.baseUrl ? { baseUrl: options.baseUrl } : {}),
            allowCloud: options.allowCloud === true,
            includeSource: options.includeSource === true,
          });
        } catch (error) {
          if (error instanceof AiConfigError) throw new CliError(error.message);
          throw error;
        }
        saveAiConfig(workspaceDir(ws), config);
        io.stdout(`AI layer configured.\n\n${formatAiConfig(config)}`);
        if (config.provider === 'anthropic') {
          io.stdout(
            'Credentials are read at use from ANTHROPIC_API_KEY or `ant auth login`; none are stored.\n',
          );
        }
      });
    });

  ai.command('status')
    .description('Show whether the AI layer is on, and what it may send where.')
    .addOption(new Option('--json', 'print the configuration as JSON'))
    .action(async (options: { json?: boolean }) => {
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        const config = readConfig(ws);
        if (options.json) writeJson(io, { configured: config !== null, config });
        else io.stdout(formatAiConfig(config));
      });
    });

  ai.command('off')
    .description('Turn the AI layer off again.')
    .action(async () => {
      await withWorkspace(openWorkspace(repoPath()), (ws) => {
        rmSync(join(workspaceDir(ws), AI_CONFIG_FILE), { force: true });
        io.stdout('AI layer off.\n');
      });
    });

  program
    .command('ask')
    .description(
      'Answer an open question with the AI layer, from evidence gathered deterministically.',
    )
    .argument('<question>', 'the question, quoted')
    .addOption(new Option('--json', 'print the answer as JSON'))
    .action(async (question: string, options: { json?: boolean }) => {
      await withWorkspace(openWorkspace(repoPath()), async (ws) => {
        const { config, provider } = providerFor(ws, io);
        const answer = await runAi(() =>
          askWithEvidence(provider, ws.fossil.db, ws.repositoryId, question, {
            includeSource: config.includeSource,
          }),
        );
        if (!answer) {
          throw new CliError(
            'Nothing in the index relates to this question, so the model was not asked. ' +
              'Name a file, symbol, commit or issue, or use words from commit messages.',
          );
        }
        if (options.json) writeJson(io, answer);
        else io.stdout(formatAiAnswer(answer));
      });
    });
}
