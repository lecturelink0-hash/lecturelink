/**
 * POST /api/me/email — 이메일 미보유 계정(예: 카카오 로그인)의 이메일 등록.
 *
 * 카카오는 이메일 수집에 비즈니스 앱이 필요해, 이메일 없이 로그인된 사용자에게서
 * 앱 차원에서 이메일을 필수로 받는다. auth.users 의 email 을 갱신(email_confirm=true).
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const bodySchema = z.object({
  email: z.string().trim().email('올바른 이메일 형식이 아닙니다.'),
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const { email } = bodySchema.parse(await request.json());
  const admin = createAdminClient();

  const { error } = await admin.auth.admin.updateUserById(session.userId, {
    email,
    email_confirm: true,
  });

  if (error) {
    // 다른 계정이 이미 사용 중인 이메일 등
    const dup = /registered|already|exists|duplicate/i.test(error.message);
    throw new ApiException(
      dup ? 'email_taken' : 'email_update_failed',
      dup ? '이미 다른 계정에서 사용 중인 이메일입니다.' : error.message,
      400,
    );
  }

  return ok({ email });
});
