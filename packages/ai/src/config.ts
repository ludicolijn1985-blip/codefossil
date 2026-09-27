import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * The optional AI layer is off until the user configures it. The
 * configuration names a provider and model and records two explicit
 * choices: whether a non-local provider may be used at all, and whether
 * source excerpts may be sent to it. It never holds a key.
 */
export const AI_PROVIDERS = ['ollama', 'anthropic'] as const;
export type AiProviderName = (typeof AI_PROVIDERS)[number];

export const DEFAULT_MODELS: Readonly<Record<AiProviderName, string>> = {
  ollama: 'llama3.1',
  anthropic: 'claude-opus-5',
};
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';

export const aiConfigSchema = z
  .object({
    provider: z.enum(AI_PROVIDERS),
    model: z.string().trim().min(1).max(200),
    /** Ollama only: where it listens. */
    baseUrl: z.url().optional(),
    /** The user agreed that evidence may leave this machine. */
    allowCloud: z.boolean().default(false),
    /** The user agreed that source excerpts (symbol signatures) may be sent. */
    includeSource: z.boolean().default(false),
  })
  .strict();
export type AiConfig = z.infer<typeof aiConfigSchema>;

export class AiConfigError extends Error {
  override readonly name = 'AiConfigError';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Whether a provider sends data off this machine. */
export function isCloud(config: AiConfig): boolean {
  if (config.provider === 'anthropic') return true;
  const host = new URL(config.baseUrl ?? DEFAULT_OLLAMA_URL).hostname.toLowerCase();
  return !LOOPBACK.has(host);
}

/** A configuration is usable only if a cloud provider was explicitly allowed. */
export function validateAiConfig(input: unknown): AiConfig {
  const result = aiConfigSchema.safeParse(input);
  if (!result.success) {
    throw new AiConfigError(`Invalid AI configuration: ${z.prettifyError(result.error)}`);
  }
  const config = result.data;
  if (config.baseUrl && config.provider !== 'ollama') {
    throw new AiConfigError('A base URL can only be set for the ollama provider.');
  }
  if (isCloud(config) && !config.allowCloud) {
    throw new AiConfigError(
      `${config.provider === 'anthropic' ? 'Anthropic' : `Ollama at ${config.baseUrl ?? ''}`} ` +
        'runs outside this machine; evidence would leave it. Configure it with --allow-cloud to agree.',
    );
  }
  return config;
}

export const AI_CONFIG_FILE = 'ai.json';

/** Read the AI configuration from a workspace directory (`.codefossil/`); null when off. */
export function loadAiConfig(workspaceDir: string): AiConfig | null {
  const path = join(workspaceDir, AI_CONFIG_FILE);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new AiConfigError(`${path} is not valid JSON.`);
  }
  return validateAiConfig(parsed);
}

export function saveAiConfig(workspaceDir: string, config: AiConfig): void {
  writeFileSync(
    join(workspaceDir, AI_CONFIG_FILE),
    `${JSON.stringify(validateAiConfig(config), null, 2)}\n`,
  );
}
