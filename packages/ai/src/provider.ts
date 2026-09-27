import type { z } from 'zod';

/** One structured completion: a system prompt, the grounded material, a JSON schema for the reply. */
export interface CompletionRequest<T> {
  readonly system: string;
  readonly prompt: string;
  readonly schema: z.ZodType<T>;
}

export interface Completion<T> {
  readonly output: T;
  /** The model that actually answered (a fallback model may differ from the configured one). */
  readonly model: string;
}

export interface AiProvider {
  readonly name: string;
  readonly model: string;
  /** Whether requests leave this machine. */
  readonly cloud: boolean;
  complete<T>(request: CompletionRequest<T>): Promise<Completion<T>>;
}

/** The provider could not produce a usable answer; the message is safe to show. */
export class AiProviderError extends Error {
  override readonly name = 'AiProviderError';
}
