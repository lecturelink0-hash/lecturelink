import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { ApiErrors } from '@/lib/utils/api';
import { persistCpxExchange } from '@/lib/cpx/persistence';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_ROOTS = new Set(['cases', 'sessions', 'exam-buttons', 'history', 'review-notes']);

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const session = await requireSession();
  const { path } = await context.params;
  if (!path.length || !ALLOWED_ROOTS.has(path[0])) return ApiErrors.notFound('CPX API');

  const base = process.env.CPX_BACKEND_URL;
  const proxySecret = process.env.CPX_PROXY_SHARED_SECRET;
  if (!base) {
    return NextResponse.json(
      { detail: 'CPX_BACKEND_URL이 설정되지 않았습니다. CPX FastAPI 서비스를 연결해주세요.' },
      { status: 503 },
    );
  }
  if (!proxySecret) {
    return NextResponse.json(
      { detail: 'CPX_PROXY_SHARED_SECRET이 설정되지 않았습니다. CPX 프록시와 백엔드를 같은 값으로 설정해주세요.' },
      { status: 503 },
    );
  }

  const incoming = new URL(request.url);
  const endpoint = new URL(`/api/${path.map(encodeURIComponent).join('/')}`, base);
  endpoint.search = incoming.search;
  const method = request.method;
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text();

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method,
      headers: {
        ...(body ? { 'content-type': request.headers.get('content-type') ?? 'application/json' } : {}),
        'x-lecturelink-user-id': session.userId,
        'x-cpx-proxy-secret': proxySecret,
      },
      body,
      cache: 'no-store',
    });
  } catch {
    return NextResponse.json({ detail: 'CPX 서비스에 연결할 수 없습니다.' }, { status: 502 });
  }

  const responseBody = await response.text();
  if (response.ok && process.env.CPX_PERSIST_TO_SUPABASE === 'true') {
    try {
      await persistCpxExchange({
        userId: session.userId,
        path,
        method,
        requestBody: body,
        responseBody,
      });
    } catch (error) {
      console.error('[cpx persistence] mirror failed:', error);
      return NextResponse.json(
        { detail: 'CPX 기록을 저장하지 못했습니다. 입력은 보존되어 재시도할 수 있습니다.' },
        { status: 503 },
      );
    }
  }

  return new NextResponse(responseBody, {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
  });
}

export const GET = forward;
export const POST = forward;
