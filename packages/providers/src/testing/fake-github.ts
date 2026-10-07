import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeResponse {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: unknown;
}

/** A request's method and body, for routes that answer POSTs (GraphQL). */
export interface FakeRequest {
  readonly method: string;
  readonly body: string;
}

/** Returns the response for a request, or undefined for a 404. `url` includes the query. */
export type FakeRoute = (url: URL, request: FakeRequest) => FakeResponse | undefined;

export interface RecordedRequest extends FakeRequest {
  readonly url: URL;
  readonly headers: IncomingHttpHeaders;
}

export interface FakeGitHub {
  /** Base URL to use as the API URL, e.g. `http://127.0.0.1:51234`. */
  readonly apiUrl: string;
  readonly requests: readonly RecordedRequest[];
  /** Forget recorded requests, e.g. between two runs of a test. */
  clearRequests(): void;
  close(): Promise<void>;
}

/**
 * A local HTTP server standing in for the GitHub REST API in tests, so the
 * real client code (fetch, headers, pagination, errors) runs without network.
 */
export async function startFakeGitHub(route: FakeRoute): Promise<FakeGitHub> {
  const requests: RecordedRequest[] = [];
  let apiUrl = '';
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', apiUrl);
      const request = { method: req.method ?? 'GET', body: Buffer.concat(chunks).toString('utf8') };
      requests.push({ url, headers: req.headers, ...request });
      const response = route(url, request);
      res.writeHead(response?.status ?? (response ? 200 : 404), {
        'content-type': 'application/json',
        ...response?.headers,
      });
      res.end(JSON.stringify(response?.body ?? { message: 'Not Found' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  apiUrl = `http://127.0.0.1:${port}`;
  return {
    apiUrl,
    requests,
    clearRequests: () => {
      requests.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
  };
}

/** Serve `items` in pages of `pageSize`, with GitHub-style `Link` headers. */
export function paged(url: URL, items: readonly unknown[], pageSize = 2): FakeResponse {
  const page = Number(url.searchParams.get('page') ?? '1');
  const slice = items.slice((page - 1) * pageSize, page * pageSize);
  const headers: Record<string, string> = {};
  if (page * pageSize < items.length) {
    const next = new URL(url);
    next.searchParams.set('page', String(page + 1));
    headers.link = `<${next.toString()}>; rel="next"`;
  }
  return { body: slice, headers };
}
