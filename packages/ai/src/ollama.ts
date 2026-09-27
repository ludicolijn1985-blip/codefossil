import { z } from 'zod';
import { DEFAULT_OLLAMA_URL } from './config.js';
import {
  AiProviderError,
  type AiProvider,
  type Completion,
  type CompletionRequest,
} from './provider.js';

const TIMEOUT_MS = 5 * 60 * 1000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const chatResponse = z.object({
  model: z.string(),
  message: z.object({ content: z.string() }),
  done_reason: z.string().optional(),
});

export interface OllamaProviderOptions {
  readonly model: string;
  readonly baseUrl?: string;
  /** Whether the base URL is off this machine (decided by the configuration). */
  readonly cloud: boolean;
}

/**
 * A model served by Ollama, asked for JSON matching the schema
 * (`format` takes a JSON Schema). The reply is validated here: a model that
 * ignores the schema produces an error, not a half-trusted answer.
 */
export function ollamaProvider(options: OllamaProviderOptions): AiProvider {
  const url = new URL('/api/chat', options.baseUrl ?? DEFAULT_OLLAMA_URL);
  return {
    name: 'ollama',
    model: options.model,
    cloud: options.cloud,
    async complete<T>(request: CompletionRequest<T>): Promise<Completion<T>> {
      let response: Response;
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: options.model,
            stream: false,
            format: z.toJSONSchema(request.schema),
            options: { temperature: 0 },
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.prompt },
            ],
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
          redirect: 'error',
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new AiProviderError(`Ollama is not reachable at ${url.origin} (${detail}).`);
      }
      const text = await response.text();
      if (text.length > MAX_RESPONSE_BYTES)
        throw new AiProviderError('Ollama sent an oversized reply.');
      if (!response.ok) {
        throw new AiProviderError(
          `Ollama answered ${String(response.status)}: ${text.slice(0, 200)}`,
        );
      }
      let reply: z.infer<typeof chatResponse>;
      let output: T;
      try {
        reply = chatResponse.parse(JSON.parse(text));
        output = request.schema.parse(JSON.parse(reply.message.content));
      } catch {
        throw new AiProviderError('The model did not return an answer in the required structure.');
      }
      return { output, model: reply.model };
    },
  };
}
