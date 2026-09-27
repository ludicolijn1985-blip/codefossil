import 'server-only';
import type { ApiEnvelope } from './types';

/** Where `codefossil serve` listens; the UI server talks to it directly. */
export const API_URL = process.env.FOSSIL_API_URL ?? 'http://127.0.0.1:4000';

export class ApiRequestError extends Error {
  override readonly name = 'ApiRequestError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** The API is not running: the most common first-run problem, shown as guidance. */
export class ApiUnavailableError extends Error {
  override readonly name = 'ApiUnavailableError';
}

/**
 * Call the API from a server component: GET, or POST when a body is given.
 * Always fresh: the index changes
 * whenever `codefossil index` runs.
 */
export async function fossil<T>(path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      cache: 'no-store',
      ...(body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    });
  } catch {
    throw new ApiUnavailableError(`The CODEFOSSIL API at ${API_URL} is not reachable.`);
  }
  const envelope = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || envelope.data === undefined) {
    throw new ApiRequestError(
      response.status,
      envelope.error?.code ?? 'unknown_error',
      envelope.error?.message ?? `The API answered ${response.status}.`,
      envelope.error?.details,
    );
  }
  return envelope.data;
}

/** Like {@link fossil}, but a 404 becomes `null` instead of an error. */
export async function fossilOrNull<T>(path: string): Promise<T | null> {
  try {
    return await fossil<T>(path);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) return null;
    throw error;
  }
}
