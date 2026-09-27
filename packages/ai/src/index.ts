import type { FossilDb } from '@codefossil/db';
import type { WhyInvestigation } from '@codefossil/query';
import { anthropicProvider } from './anthropic.js';
import { answerFromGrounding, type AiAnswer } from './answer.js';
import { isCloud, type AiConfig } from './config.js';
import { gatherGrounding, groundingFromWhy } from './grounding.js';
import { ollamaProvider } from './ollama.js';
import type { AiProvider } from './provider.js';

export * from './answer.js';
export * from './config.js';
export * from './grounding.js';
export * from './provider.js';
export { anthropicProvider } from './anthropic.js';
export { ollamaProvider } from './ollama.js';

/** The configured provider. The configuration was validated, so cloud use was agreed to. */
export function createProvider(config: AiConfig): AiProvider {
  return config.provider === 'anthropic'
    ? anthropicProvider({ model: config.model })
    : ollamaProvider({
        model: config.model,
        cloud: isCloud(config),
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
      });
}

export interface AskOptions {
  readonly includeSource: boolean;
}

/**
 * Answer an open question from evidence gathered deterministically. Returns
 * null — without contacting the model — when the index holds nothing related.
 */
export async function askWithEvidence(
  provider: AiProvider,
  db: FossilDb,
  repositoryId: number,
  question: string,
  options: AskOptions,
): Promise<AiAnswer | null> {
  const grounding = gatherGrounding(db, repositoryId, question, options);
  return grounding ? answerFromGrounding(provider, grounding) : null;
}

/** A readable summary of a why-investigation, citing the investigation's own evidence. */
export async function summarizeWhy(
  provider: AiProvider,
  why: WhyInvestigation,
  options: AskOptions,
): Promise<AiAnswer> {
  return answerFromGrounding(provider, groundingFromWhy(why, options));
}
