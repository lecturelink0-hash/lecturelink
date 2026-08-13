import { NextResponse } from 'next/server';

const ALLOWED_ROOTS = new Set(['cases', 'sessions', 'exam-buttons', 'history', 'review-notes', 'usage']);

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  if (process.env.NODE_ENV !== 'development' || process.env.LOCAL_STUDENT_UI_PREVIEW !== 'true') {
    return NextResponse.json({ detail: 'Not found.' }, { status: 404 });
  }

  const { path } = await context.params;
  if (!path.length || !ALLOWED_ROOTS.has(path[0])) {
    return NextResponse.json({ detail: 'CPX preview path not found.' }, { status: 404 });
  }

  if (request.method === 'GET' && path.length === 1 && path[0] === 'cases') {
    return NextResponse.json({
      cases: [
        { id: 'preview-sleep-1', category: '수면장애', title: '알코올 관련 수면장애', description: '수면 문제의 원인을 평가하고 환자교육을 진행합니다.' },
        { id: 'preview-abdomen-1', category: '급성 복통', title: '급성충수염', description: '급성 복통 환자의 병력과 신체진찰을 평가합니다.' },
        { id: 'preview-chest-1', category: '가슴 통증', title: '급성 관상동맥증후군', description: '흉통의 위험 신호를 확인하고 초기 대응을 연습합니다.' },
        { id: 'preview-anxiety-1', category: '불안', title: '공황장애', description: '불안 증상을 구조적으로 평가하고 설명합니다.' },
      ],
    }, { headers: { 'cache-control': 'no-store' } });
  }

  if (request.method === 'GET' && path.length === 1 && path[0] === 'history') {
    return NextResponse.json({
      sessions: [{
        sessionId: 'preview-session-1',
        caseId: 'preview-sleep-1',
        startedAt: new Date(0).toISOString(),
        totalScore: 48,
        weakestSection: { id: 'patient-education', name: '환자교육', score: 0, weightPercent: 12 },
      }],
    }, { headers: { 'cache-control': 'no-store' } });
  }

  if (request.method === 'GET' && path.length === 1 && path[0] === 'exam-buttons') {
    return NextResponse.json({ buttons: [] }, { headers: { 'cache-control': 'no-store' } });
  }

  const base = process.env.CPX_BACKEND_URL;
  const proxySecret = process.env.CPX_PROXY_SHARED_SECRET;
  if (!base || !proxySecret) {
    return NextResponse.json({ detail: 'Local CPX preview backend is not configured.' }, { status: 503 });
  }

  const incoming = new URL(request.url);
  const endpoint = new URL(`/api/${path.map(encodeURIComponent).join('/')}`, base);
  endpoint.search = incoming.search;
  const method = request.method;
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.text();
  const response = await fetch(endpoint, {
    method,
    headers: {
      ...(body ? { 'content-type': request.headers.get('content-type') ?? 'application/json' } : {}),
      'x-lecturelink-user-id': '00000000-0000-4000-8000-000000000001',
      'x-cpx-proxy-secret': proxySecret,
    },
    body,
    cache: 'no-store',
  });

  return new NextResponse(await response.text(), {
    status: response.status,
    headers: { 'content-type': response.headers.get('content-type') ?? 'application/json', 'cache-control': 'no-store' },
  });
}

export const GET = forward;
export const POST = forward;
