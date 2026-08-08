import { requireStudent } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { bearer, tokenHash } from '@/lib/live-assessment';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

export const POST = withErrorHandling(
  async (request: Request, context: { params: Promise<{ sessionId: string }> }) => {
    const session = await requireStudent();
    const { sessionId } = await context.params;
    const token = bearer(request);
    if (!token) throw new ApiException('missing_token', '응시 정보를 찾을 수 없습니다.', 401);

    const admin = createAdminClient() as any;
    const { data, error } = await admin.rpc('save_live_assessment_to_library', {
      target_session: sessionId,
      target_token_hash: tokenHash(token),
      target_user: session.userId,
    });

    if (error) {
      if (error.code === '23505') {
        throw new ApiException('already_claimed', '이미 다른 계정에 저장된 응시 결과입니다.', 409);
      }
      if (error.message?.includes('assessment_not_ended')) {
        throw new ApiException('not_ended', '평가 종료 후 저장할 수 있습니다.', 409);
      }
      if (error.message?.includes('participation_not_found')) {
        throw new ApiException('not_found', '응시 정보를 찾을 수 없습니다.', 404);
      }
      throw new ApiException('save_failed', '문항을 문제집에 저장하지 못했습니다.', 500, error);
    }

    return ok({ uploadId: data });
  },
);
