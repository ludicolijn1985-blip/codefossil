import type { FastifyInstance } from 'fastify';
import { ApiError } from './errors.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** `host:port` or `[::1]:port` → host. */
function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith('[')) return hostHeader.slice(0, hostHeader.indexOf(']') + 1);
  return hostHeader.split(':')[0] ?? '';
}

export interface SecurityOptions {
  /** Extra Host names to accept (e.g. when deliberately served on a LAN name). */
  readonly allowedHosts?: readonly string[];
}

/**
 * Protections for a server that runs on the user's machine:
 * - the Host header must name this machine, which defeats DNS rebinding
 *   (a web page pointing its own domain at 127.0.0.1 to read the API);
 * - requests that change state must be `application/json`, which browsers
 *   cannot send cross-origin without a CORS preflight this server never
 *   grants — so other web pages cannot forge them.
 */
export function installSecurity(app: FastifyInstance, options: SecurityOptions = {}): void {
  const allowed = new Set([...LOCAL_HOSTS, ...(options.allowedHosts ?? [])]);
  app.addHook('onRequest', (request, _reply, done) => {
    const host = request.headers.host;
    if (!host || !allowed.has(hostnameOf(host).toLowerCase())) {
      done(
        new ApiError(
          403,
          'forbidden_host',
          'This server only answers requests addressed to localhost.',
        ),
      );
      return;
    }
    const type = request.headers['content-type'] ?? '';
    if (
      request.method !== 'GET' &&
      request.method !== 'HEAD' &&
      !type.toLowerCase().startsWith('application/json')
    ) {
      done(
        new ApiError(
          415,
          'unsupported_media_type',
          'Send requests that change state as application/json.',
        ),
      );
      return;
    }
    done();
  });
}
