import { NextResponse, type NextRequest } from 'next/server';
import { API_URL } from '@/lib/api';
import { decideProxy } from '@/lib/proxy';

interface Context {
  readonly params: Promise<{ path: string[] }>;
}

async function forward(request: NextRequest, context: Context): Promise<NextResponse> {
  const { path } = await context.params;
  const decision = decideProxy({
    method: request.method,
    host: request.headers.get('host'),
    contentType: request.headers.get('content-type'),
    segments: path,
  });
  if (!decision.ok) {
    return NextResponse.json(
      { error: { code: decision.code, message: decision.message } },
      { status: decision.status },
    );
  }
  const target = `${API_URL}${decision.apiPath}${request.nextUrl.search}`;
  try {
    const response = await fetch(target, {
      method: request.method,
      cache: 'no-store',
      ...(request.method === 'GET'
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: await request.text() }),
    });
    return new NextResponse(await response.text(), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  } catch {
    return NextResponse.json(
      {
        error: {
          code: 'api_unavailable',
          message: 'The CODEFOSSIL API is not reachable. Is `codefossil serve` running?',
        },
      },
      { status: 502 },
    );
  }
}

export const GET = forward;
export const POST = forward;
