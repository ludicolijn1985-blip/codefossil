import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { ApiContext } from './context.js';
import { installErrorHandler } from './errors.js';
import { analyzeRoutes } from './routes/analyze.js';
import { exploreRoutes } from './routes/explore.js';
import { investigateRoutes } from './routes/investigate.js';
import { repositoryRoutes } from './routes/repositories.js';
import { installSecurity } from './security.js';

export const API_VERSION = '0.1.0';

export interface ServerOptions extends ApiContext {
  readonly logger?: FastifyServerOptions['logger'];
  /** Requests per client per minute (default 300). */
  readonly rateLimitPerMinute?: number;
  /** Host names to accept besides localhost. */
  readonly allowedHosts?: readonly string[];
}

/** Build the CODEFOSSIL API. Call `listen` on the result, or use `inject` in tests. */
export async function buildServer(options: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024,
  });
  installErrorHandler(app);
  await app.register(rateLimit, {
    max: options.rateLimitPerMinute ?? 300,
    timeWindow: '1 minute',
  });
  installSecurity(app, options.allowedHosts ? { allowedHosts: options.allowedHosts } : {});

  app.get('/health', () => ({ data: { status: 'ok', version: API_VERSION } }));
  repositoryRoutes(app, options);
  exploreRoutes(app, options);
  investigateRoutes(app, options);
  analyzeRoutes(app, options);
  return app;
}
