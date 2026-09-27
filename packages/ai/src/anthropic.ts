import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  AiProviderError,
  type AiProvider,
  type Completion,
  type CompletionRequest,
} from './provider.js';

const MAX_TOKENS = 16_000;

export interface AnthropicProviderOptions {
  readonly model: string;
  /** Tests point the SDK at a local fake; otherwise the SDK default. */
  readonly baseURL?: string;
  /** Credentials resolve like the SDK does (ANTHROPIC_API_KEY, `ant auth login`); never stored. */
  readonly apiKey?: string;
}

/**
 * Claude through the official SDK, with structured output constrained by the
 * schema and validated again here. A model that declines on safety grounds is retried server-side
 * on a fallback model (`fallbacks: "default"`); a final refusal is reported,
 * never turned into an answer.
 */
export function anthropicProvider(options: AnthropicProviderOptions): AiProvider {
  const client = new Anthropic({
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
    ...(options.apiKey ? { apiKey: options.apiKey } : {}),
  });
  return {
    name: 'anthropic',
    model: options.model,
    cloud: true,
    async complete<T>(request: CompletionRequest<T>): Promise<Completion<T>> {
      let response;
      try {
        response = await client.beta.messages.create({
          model: options.model,
          max_tokens: MAX_TOKENS,
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
          thinking: { type: 'adaptive' },
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
          output_config: { format: betaZodOutputFormat(request.schema) },
        });
      } catch (error) {
        if (error instanceof Anthropic.AuthenticationError) {
          throw new AiProviderError(
            'Anthropic rejected the credentials. Set ANTHROPIC_API_KEY or run `ant auth login`.',
          );
        }
        if (error instanceof Anthropic.RateLimitError) {
          throw new AiProviderError('Anthropic rate limit reached; try again later.');
        }
        if (error instanceof Anthropic.APIError) {
          throw new AiProviderError(
            `Anthropic API error ${String(error.status)}: ${error.message}`,
          );
        }
        throw error;
      }
      if (response.stop_reason === 'refusal') {
        throw new AiProviderError('The model declined to answer this question.');
      }
      // The reason is checked before the content: a refused or cut-off reply is not an answer.
      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      if (response.stop_reason !== 'end_turn' || !text) {
        throw new AiProviderError('The model did not return a complete, valid answer.');
      }
      try {
        return { output: request.schema.parse(JSON.parse(text)), model: response.model };
      } catch {
        throw new AiProviderError('The model did not return an answer in the required structure.');
      }
    },
  };
}
