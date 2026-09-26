import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';

/** An error meant for the API client, with a stable machine-readable code. */
export class ApiError extends Error {
  override readonly name = 'ApiError';

  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export interface ErrorBody {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}

/**
 * Map every failure to the `{ error: { code, message } }` envelope. Internal
 * errors are logged with full detail but reported generically, so paths,
 * queries or stack traces never leak to a client.
 */
export function installErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    if (error instanceof ZodError) {
      const body: ErrorBody = {
        error: {
          code: 'validation_error',
          message: 'The request is invalid.',
          details: error.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      };
      return reply.status(400).send(body);
    }
    if (error instanceof ApiError) {
      const body: ErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
      };
      return reply.status(error.statusCode).send(body);
    }
    const status = 'statusCode' in error ? error.statusCode : undefined;
    if (status !== undefined && status >= 400 && status < 500) {
      const code =
        status === 429 ? 'rate_limited' : status === 413 ? 'payload_too_large' : 'bad_request';
      const body: ErrorBody = { error: { code, message: error.message } };
      return reply.status(status).send(body);
    }
    request.log.error({ err: error }, 'request failed');
    const body: ErrorBody = { error: { code: 'internal_error', message: 'Something went wrong.' } };
    return reply.status(500).send(body);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: {
        code: 'not_found',
        message: `No route for ${request.method} ${request.url.split('?')[0] ?? ''}.`,
      },
    };
    return reply.status(404).send(body);
  });
}
