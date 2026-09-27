/**
 * Rules for the browser-facing proxy to the API. The proxy must not be a
 * weaker door than the API itself, so it applies the same local-only checks
 * and only forwards the routes the UI needs.
 */

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** API routes the browser may reach through the proxy: `method path-pattern`. */
const ALLOWED: readonly (readonly [string, RegExp])[] = [
  ['GET', /^repositories\/\d+\/(files|commits|dependencies|investigations|timeline|impact|graph)$/],
  ['GET', /^repositories\/\d+\/(files\/\d+|symbols\/\d+|investigations\/\d+)$/],
  ['POST', /^repositories\/\d+\/(investigate|query|ask)$/],
];

export interface ProxyRequest {
  readonly method: string;
  readonly host: string | null;
  readonly contentType: string | null;
  /** Path segments after `/api/fossil/`. */
  readonly segments: readonly string[];
}

export type ProxyDecision =
  | { readonly ok: true; readonly apiPath: string }
  | {
      readonly ok: false;
      readonly status: number;
      readonly code: string;
      readonly message: string;
    };

function hostnameOf(host: string): string {
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0] ?? '';
}

/**
 * Whether a `Host` header names this machine. Checked on every request so a
 * page elsewhere cannot read the UI through a rebound DNS name.
 */
export function isLocalHost(host: string | null): boolean {
  return host !== null && LOCAL_HOSTS.has(hostnameOf(host).toLowerCase());
}

export function decideProxy(request: ProxyRequest): ProxyDecision {
  if (!isLocalHost(request.host)) {
    return {
      ok: false,
      status: 403,
      code: 'forbidden_host',
      message: 'Only localhost may use this UI.',
    };
  }
  if (
    request.method !== 'GET' &&
    !(request.contentType ?? '').toLowerCase().startsWith('application/json')
  ) {
    return {
      ok: false,
      status: 415,
      code: 'unsupported_media_type',
      message: 'Send requests that change state as application/json.',
    };
  }
  // Reject anything that could step outside the allow-list once joined.
  if (request.segments.some((s) => s === '' || s === '.' || s === '..' || /[/\\?#%]/.test(s))) {
    return { ok: false, status: 400, code: 'bad_path', message: 'Invalid path.' };
  }
  const path = request.segments.join('/');
  const allowed = ALLOWED.some(
    ([method, pattern]) => method === request.method && pattern.test(path),
  );
  if (!allowed) {
    return { ok: false, status: 404, code: 'not_found', message: 'No such route.' };
  }
  return { ok: true, apiPath: `/api/${path}` };
}
