import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ApiErrors, withErrorHandling } from '@/lib/utils/api';
import { persistCpxExchange } from '@/lib/cpx/persistence';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ALLOWED_ROOTS = new Set(['cases', 'sessions', 'exam-buttons', 'history', 'review-notes']);

async function persistedHistory(userId: string) {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from('cpx_sessions')
    .select('external_session_id, case_id, persona, result, started_at')
    .eq('user_id', userId)
    .not('result', 'is', null)
    .order('started_at', { ascending: false })
    .limit(50);
  if (error) {
    console.error('[cpx history] load failed:', error);
    return NextResponse.json({ detail: 'CPX 기록을 불러오지 못했습니다.' }, { status: 503 });
  }
  return NextResponse.json({
    sessions: (data ?? []).map((row) => {
      const result = row.result && typeof row.result === 'object' && !Array.isArray(row.result)
        ? row.result as Record<string, unknown>
        : {};
      return {
        sessionId: row.external_session_id,
        caseId: row.case_id,
        startedAt: row.started_at,
        persona: row.persona,
        totalScore: result.totalScore,
        gradeLabel: result.overallGradeLabel,
      };
    }),
  }, { headers: { 'cache-control': 'no-store' } });
}

// 저장된 세션의 전체 채점 결과(sections·judgments·feedback·itemTexts 등)를 Supabase에서 조회.
// evaluate 응답 전체가 cpx_sessions.result 에 미러링돼 있으므로 Fly 백엔드를 거치지 않는다.
// (persist 모드에서는 과거 세션이 Fly SQLite에 없어 evaluate가 404가 되므로 이 경로가 필요.)
async function persistedSessionResult(userId: string, sessionId: string) {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from('cpx_sessions')
    .select('external_session_id, case_id, persona, result, started_at')
    .eq('user_id', userId)
    .eq('external_session_id', sessionId)
    .maybeSingle();
  if (error) {
    console.error('[cpx session detail] load failed:', error);
    return NextResponse.json({ detail: 'CPX 채점 기록을 불러오지 못했습니다.' }, { status: 503 });
  }
  const result = data?.result && typeof data.result === 'object' && !Array.isArray(data.result)
    ? (data.result as Record<string, unknown>)
    : null;
  if (!result) {
    return NextResponse.json({ detail: '세션 없음' }, { status: 404 });
  }
  return NextResponse.json(
    {
      ...result,
      caseId: result.caseId ?? data?.case_id,
      persona: result.persona ?? data?.persona,
      startedAt: data?.started_at,
    },
    { headers: { 'cache-control': 'no-store' } },
  );
}

// 저장된 세션의 전체 대화록을 Supabase 미러에서 조회.
// 학생·환자 발화(cpx_transcript_events)에 신체진찰 선언(cpx_physical_exam_events.result.declaration)을
// 시간순으로 병합 — Fly SQLite에는 진찰 선언이 student 발화로 함께 저장되지만, 미러에서는
// 두 테이블로 나뉘어 있으므로 여기서 합쳐 Fly transcript 응답과 같은 events 형태를 만든다.
async function persistedSessionTranscript(userId: string, sessionId: string) {
  const supabase = await createServerClient();
  const { data: session, error: sessionError } = await supabase
    .from('cpx_sessions')
    .select('id')
    .eq('user_id', userId)
    .eq('external_session_id', sessionId)
    .maybeSingle();
  if (sessionError) {
    console.error('[cpx transcript] session lookup failed:', sessionError);
    return NextResponse.json({ detail: '대화록을 불러오지 못했습니다.' }, { status: 503 });
  }
  if (!session) {
    return NextResponse.json({ detail: '세션 없음' }, { status: 404 });
  }
  const [talk, exams] = await Promise.all([
    supabase
      .from('cpx_transcript_events')
      .select('role, text, t_offset_ms')
      .eq('user_id', userId)
      .eq('session_id', session.id)
      .order('t_offset_ms', { ascending: true })
      .order('id', { ascending: true }),
    supabase
      .from('cpx_physical_exam_events')
      .select('result, t_offset_ms')
      .eq('user_id', userId)
      .eq('session_id', session.id)
      .order('t_offset_ms', { ascending: true }),
  ]);
  if (talk.error || exams.error) {
    console.error('[cpx transcript] events load failed:', talk.error ?? exams.error);
    return NextResponse.json({ detail: '대화록을 불러오지 못했습니다.' }, { status: 503 });
  }
  const events = [
    ...(talk.data ?? []).map((row) => ({ role: row.role, text: row.text, tOffsetMs: row.t_offset_ms })),
    ...(exams.data ?? []).flatMap((row) => {
      const result = row.result && typeof row.result === 'object' && !Array.isArray(row.result)
        ? row.result as Record<string, unknown>
        : {};
      return typeof result.declaration === 'string' && result.declaration
        ? [{ role: 'student', text: result.declaration, tOffsetMs: row.t_offset_ms }]
        : [];
    }),
  ].sort((a, b) => a.tOffsetMs - b.tOffsetMs);
  return NextResponse.json({ events }, { headers: { 'cache-control': 'no-store' } });
}

async function forward(request: Request, context: { params: Promise<{ path: string[] }> }) {
  const session = await requireSession();
  const { path } = await context.params;
  if (!path.length || !ALLOWED_ROOTS.has(path[0])) return ApiErrors.notFound('CPX API');

  if (request.method === 'GET' && path.length === 1 && path[0] === 'history'
      && process.env.CPX_PERSIST_TO_SUPABASE === 'true') {
    return persistedHistory(session.userId);
  }

  // GET /history/{sessionId} → 저장된 세션의 전체 채점 결과 (세부 채점표 화면용)
  if (request.method === 'GET' && path.length === 2 && path[0] === 'history'
      && process.env.CPX_PERSIST_TO_SUPABASE === 'true') {
    return persistedSessionResult(session.userId, path[1]);
  }

  // GET /history/{sessionId}/transcript → 저장된 세션의 전체 대화록 (기록 상세 [전체 대화록] 버튼용)
  if (request.method === 'GET' && path.length === 3 && path[0] === 'history' && path[2] === 'transcript'
      && process.env.CPX_PERSIST_TO_SUPABASE === 'true') {
    return persistedSessionTranscript(session.userId, path[1]);
  }

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

export const GET = withErrorHandling(forward);
export const POST = withErrorHandling(forward);
