import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createAdminClient } from '@/lib/db/admin';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

const schema = z.object({ code: z.string().trim().length(6) });

function clientAddress(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'unknown';
}

export const POST = withErrorHandling(async (request: Request) => {
  const input = schema.parse(await request.json());
  const code = input.code.toUpperCase();
  const db = createAdminClient() as any;
  const rateKey = createHash('sha256').update(`${clientAddress(request)}:notice:${code}`).digest('hex');
  const { data: allowed, error: rateError } = await db.rpc('consume_live_assessment_join_attempt', {
    target_key: rateKey,
    window_seconds: 60,
    maximum_attempts: 30,
  });
  if (rateError) throw new ApiException('rate_limit_unavailable', '평가 안내를 확인하지 못했습니다.', 503);
  if (!allowed) throw new ApiException('rate_limit', '확인 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', 429);

  const { data: session } = await db
    .from('live_assessment_sessions')
    .select('title,professor_id,status')
    .eq('join_code', code)
    .maybeSingle();
  if (!session) throw new ApiException('not_found', '참여 코드를 확인해 주세요.', 404);
  if (session.status !== 'lobby') throw new ApiException('closed', '현재 참여할 수 없는 평가입니다.', 409);

  const { data: professor } = await db
    .from('users')
    .select('display_name,school_id')
    .eq('id', session.professor_id)
    .maybeSingle();
  const { data: school } = professor?.school_id
    ? await db.from('schools').select('name').eq('id', professor.school_id).maybeSingle()
    : { data: null };

  return ok({
    title: session.title,
    professorName: professor?.display_name || '평가 개설 교수자',
    institutionName: school?.name || null,
  });
});
