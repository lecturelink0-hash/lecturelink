import { createServerClient } from '@/lib/db/server';

type JsonObject = Record<string, unknown>;

type Exchange = {
  userId: string;
  path: string[];
  method: string;
  requestBody?: string;
  responseBody: string;
};

function jsonObject(value: string | undefined): JsonObject {
  if (!value) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as JsonObject
      : {};
  } catch {
    return {};
  }
}

function jsonArray(value: string | undefined): JsonObject[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is JsonObject => Boolean(item) && typeof item === 'object')
      : [];
  } catch {
    return [];
  }
}

async function localSessionId(userId: string, externalSessionId: string): Promise<string | null> {
  const supabase = await createServerClient();
  const { data, error } = await supabase
    .from('cpx_sessions')
    .select('id')
    .eq('user_id', userId)
    .eq('external_session_id', externalSessionId)
    .maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

/**
 * Mirrors successful CPX engine mutations into LectureLink's RLS-protected store.
 * Disabled by default while the migration has not been deployed. Production must enable it.
 */
export async function persistCpxExchange(exchange: Exchange): Promise<void> {
  if (process.env.CPX_PERSIST_TO_SUPABASE !== 'true') return;

  const { userId, path, method, requestBody, responseBody } = exchange;
  if (method !== 'POST' || path[0] !== 'sessions') return;

  const request = jsonObject(requestBody);
  const response = jsonObject(responseBody);
  const supabase = await createServerClient();

  // POST /sessions: the patient engine returns its opaque session ID.
  if (path.length === 1) {
    const externalSessionId = typeof response.sessionId === 'string' ? response.sessionId : null;
    const caseId = typeof request.caseId === 'string' ? request.caseId : null;
    if (!externalSessionId || !caseId) throw new Error('CPX 세션 동기화에 필요한 ID가 없습니다.');
    const persona = response.persona && typeof response.persona === 'object' && !Array.isArray(response.persona)
      ? response.persona as JsonObject
      : {};
    const { error } = await supabase.from('cpx_sessions').upsert({
      user_id: userId,
      external_session_id: externalSessionId,
      case_id: caseId,
      persona,
      status: 'active',
      updated_at: new Date().toISOString(),
    } as never, { onConflict: 'external_session_id' });
    if (error) throw error;
    return;
  }

  const externalSessionId = path[1];
  const action = path[2];
  if (!externalSessionId || !action) return;
  const sessionId = await localSessionId(userId, externalSessionId);
  if (!sessionId) throw new Error('CPX 세션 동기화 레코드를 찾을 수 없습니다.');

  if (action === 'events') {
    const rows = jsonArray(requestBody)
      .filter((event) => typeof event.role === 'string' && typeof event.text === 'string')
      .map((event) => ({
        user_id: userId,
        session_id: sessionId,
        role: event.role,
        text: event.text,
        t_offset_ms: Number.isInteger(event.tOffsetMs) && Number(event.tOffsetMs) >= 0 ? Number(event.tOffsetMs) : 0,
      }));
    if (rows.length > 0) {
      const { error } = await supabase.from('cpx_transcript_events').insert(rows as never);
      if (error) throw error;
    }
    return;
  }

  if (action === 'exam') {
    const { error } = await supabase.from('cpx_physical_exam_events').insert({
      user_id: userId,
      session_id: sessionId,
      button_id: typeof request.buttonId === 'string' ? request.buttonId : 'unknown',
      t_offset_ms: Number.isInteger(request.tOffsetMs) && Number(request.tOffsetMs) >= 0 ? Number(request.tOffsetMs) : 0,
      result: response,
    } as never);
    if (error) throw error;
    return;
  }

  if (action === 'end' || action === 'evaluate') {
    const update: JsonObject = { updated_at: new Date().toISOString() };
    if (action === 'end') {
      update.status = 'ended';
      update.ended_at = new Date().toISOString();
    } else {
      update.result = response;
    }
    const { error } = await supabase
      .from('cpx_sessions')
      .update(update as never)
      .eq('id', sessionId)
      .eq('user_id', userId);
    if (error) throw error;
  }
}
