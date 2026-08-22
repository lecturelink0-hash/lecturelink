/**
 * POST /api/attempts/[id]/explanation-view
 *
 * 해설을 실제로 읽었는지 기록한다 (분담표 A14 · 가이드 §8.1 '해설 열람 여부').
 *
 * 왜 별도 엔드포인트인가: 해설은 답을 제출한 **뒤에** 보이므로, 풀이 기록을 만들 때는
 * 아직 읽었는지 알 수 없다. 풀이 저장과 열람 기록의 시점이 다르다.
 *
 * 왜 '열었는지'가 아니라 '보인 시간'인가: 이 서비스의 해설은 채점 직후 화면에 그대로
 * 펼쳐진다. 접혀 있지 않으니 "열었다"는 값이 항상 참이 되어 신호가 되지 않는다.
 * 화면에 실제로 보인 누적 시간을 받아 임계를 넘으면 읽은 것으로 본다.
 * (해설을 접어 두는 UX 변경은 학습 경험을 바꾸는 제품 결정이라 계측이 정할 일이 아니다.)
 */
import { z } from 'zod';
import { requireAuthUser } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiErrors } from '@/lib/utils/api';
// 상수는 lib/study/signals 에 둔다 — Next 는 route.ts 의 export 를 정해진 것만 허용해서
// 여기서 export 하면 빌드가 거절한다. 클라이언트도 같은 값을 쓴다.
import { EXPLANATION_VIEWED_MS, MAX_EXPLANATION_DWELL_MS } from '@/lib/study/signals';

const bodySchema = z.object({
  // 클라이언트가 잰 누적 노출 시간. 상한을 두지 않으면 탭을 켜 둔 채 자리를 비운
  // 세션이 몰입도 지표를 통째로 왜곡한다.
  dwellMs: z.number().int().min(0).max(MAX_EXPLANATION_DWELL_MS),
});

export const POST = withErrorHandling(
  async (request: Request, context: { params: Promise<{ id: string }> }) => {
    const session = await requireAuthUser();
    const { id } = await context.params;
    const { dwellMs } = bodySchema.parse(await request.json());

    const supabase = await createServerClient();
    const { data: attempt, error: loadError } = await supabase
      .from('user_attempts')
      .select('id, explanation_dwell_ms')
      .eq('id', id)
      .eq('user_id', session.userId)
      .maybeSingle();
    if (loadError) throw loadError;
    if (!attempt) return ApiErrors.notFound('풀이 기록');

    // 누적한다. 학생이 해설을 봤다가 다른 문항을 보고 돌아오는 경우가 있어,
    // 마지막 값으로 덮으면 그 앞의 열람 시간이 사라진다.
    const total = Math.min((attempt.explanation_dwell_ms ?? 0) + dwellMs, MAX_EXPLANATION_DWELL_MS);
    const { error: updateError } = await supabase
      .from('user_attempts')
      .update({
        explanation_dwell_ms: total,
        explanation_viewed: total >= EXPLANATION_VIEWED_MS,
      } as never)
      .eq('id', id)
      .eq('user_id', session.userId);

    // 00044 미적용이면 조용히 넘어간다 — 학습 신호가 풀이를 실패시키면 안 된다.
    if (updateError) {
      if (/explanation_(viewed|dwell_ms)/i.test(updateError.message ?? '')) {
        console.warn('[attempts] 해설 열람 컬럼 없음 (마이그레이션 00044 미적용).');
        return ok({ recorded: false, dwellMs: 0, viewed: false });
      }
      throw updateError;
    }
    return ok({ recorded: true, dwellMs: total, viewed: total >= EXPLANATION_VIEWED_MS });
  },
);
