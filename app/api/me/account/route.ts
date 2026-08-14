import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { createServerClient } from '@/lib/db/server';
import { PASSWORD_MAX_LENGTH } from '@/lib/auth/password-policy';
import { STORAGE_BUCKET } from '@/lib/storage/paths';
import { TEACHING_MATERIAL_BUCKET } from '@/lib/teaching/materials';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

export const runtime = 'nodejs';

const deleteSchema = z.object({
  confirmation: z.literal('회원탈퇴'),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

async function removeInBatches(
  admin: ReturnType<typeof createAdminClient>,
  bucket: string,
  paths: string[],
) {
  const uniquePaths = [...new Set(paths.filter(Boolean))];
  for (let index = 0; index < uniquePaths.length; index += 100) {
    const batch = uniquePaths.slice(index, index + 100);
    const { error } = await admin.storage.from(bucket).remove(batch);
    if (error) {
      throw new ApiException(
        'account_file_delete_failed',
        '저장된 파일을 모두 삭제하지 못해 회원탈퇴를 중단했습니다. 잠시 후 다시 시도해 주세요.',
        503,
      );
    }
  }
}

export const DELETE = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const input = deleteSchema.parse(await request.json());
  const auth = await createServerClient();
  const { data: reauthenticated, error: reauthenticationError } = await auth.auth.signInWithPassword({
    email: session.email,
    password: input.password,
  });
  if (reauthenticationError || reauthenticated.user?.id !== session.userId) {
    throw new ApiException(
      'password_confirmation_failed',
      '현재 비밀번호가 일치하지 않습니다. 다시 확인해주세요.',
      401,
    );
  }
  const admin = createAdminClient();

  const cpxBackend = process.env.CPX_BACKEND_URL;
  const cpxProxySecret = process.env.CPX_PROXY_SHARED_SECRET;
  if (cpxBackend) {
    if (!cpxProxySecret) {
      throw new ApiException('cpx_delete_not_configured', 'CPX 기록 삭제 연결을 확인하지 못해 회원탈퇴를 중단했습니다.', 503);
    }
    let cpxResponse: Response;
    try {
      cpxResponse = await fetch(new URL('/api/account-data', cpxBackend), {
        method: 'DELETE',
        headers: {
          'x-lecturelink-user-id': session.userId,
          'x-cpx-proxy-secret': cpxProxySecret,
        },
        cache: 'no-store',
      });
    } catch {
      throw new ApiException('cpx_delete_failed', 'CPX 기록 삭제 서비스에 연결할 수 없어 회원탈퇴를 중단했습니다.', 503);
    }
    if (!cpxResponse.ok) {
      throw new ApiException('cpx_delete_failed', 'CPX 기록을 삭제하지 못해 회원탈퇴를 중단했습니다.', 503);
    }
  }

  const [uploadsResult, imagesResult, materialsResult] = await Promise.all([
    admin.from('user_uploads').select('storage_path').eq('user_id', session.userId),
    admin.from('private_question_images').select('storage_path').eq('user_id', session.userId),
    admin.from('teaching_materials').select('storage_path').eq('professor_id', session.userId),
  ]);

  if (uploadsResult.error || imagesResult.error || materialsResult.error) {
    throw new ApiException(
      'account_data_inventory_failed',
      '삭제할 계정 자료를 확인하지 못해 회원탈퇴를 중단했습니다.',
      503,
    );
  }

  await removeInBatches(
    admin,
    STORAGE_BUCKET,
    [
      ...(uploadsResult.data ?? []).flatMap((row) => typeof row.storage_path === 'string' ? [row.storage_path] : []),
      ...(imagesResult.data ?? []).flatMap((row) => typeof row.storage_path === 'string' ? [row.storage_path] : []),
    ],
  );
  await removeInBatches(
    admin,
    TEACHING_MATERIAL_BUCKET,
    (materialsResult.data ?? []).flatMap((row) => typeof row.storage_path === 'string' ? [row.storage_path] : []),
  );

  // 탈퇴 시점 이후 갱신 대상으로 처리되지 않도록 먼저 자동 갱신을 해제한다.
  const { error: subscriptionError } = await admin
    .from('subscriptions')
    .update({ auto_renew: false, status: 'cancelled' })
    .eq('user_id', session.userId)
    .eq('status', 'active');
  if (subscriptionError) {
    throw new ApiException(
      'subscription_cancel_failed',
      '구독 갱신 해제를 확인하지 못해 회원탈퇴를 중단했습니다.',
      503,
    );
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(session.userId);
  if (deleteError) {
    throw new ApiException(
      'account_delete_failed',
      '계정을 삭제하지 못했습니다. 잠시 후 다시 시도하거나 고객지원으로 문의해 주세요.',
      503,
    );
  }

  return ok({ deleted: true });
});
