import type { ApiEnvelope } from './types';

export class ClientApiError extends Error {
  override readonly name = 'ClientApiError';

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Call the API from the browser, through this app's own proxy. */
export async function request<T>(
  path: string,
  init?: { method: 'POST'; body: unknown },
): Promise<T> {
  const response = await fetch(`/api/fossil${path}`, {
    method: init?.method ?? 'GET',
    ...(init
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(init.body) }
      : {}),
  });
  const body = (await response.json()) as ApiEnvelope<T>;
  if (!response.ok || body.data === undefined) {
    throw new ClientApiError(
      response.status,
      body.error?.code ?? 'unknown_error',
      body.error?.message ?? `The request failed (${response.status}).`,
      body.error?.details,
    );
  }
  return body.data;
}
