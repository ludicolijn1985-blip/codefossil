import { NextResponse, type NextRequest } from 'next/server';
import { isLocalHost } from '@/lib/proxy';

/** Every page and route answers only requests addressed to this machine. */
export function proxy(request: NextRequest): NextResponse {
  if (!isLocalHost(request.headers.get('host'))) {
    return NextResponse.json(
      { error: { code: 'forbidden_host', message: 'Only localhost may use this UI.' } },
      { status: 403 },
    );
  }
  return NextResponse.next();
}
