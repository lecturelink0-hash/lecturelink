import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { ok, withErrorHandling } from '@/lib/utils/api';
import { PRIVACY_VERSION, TERMS_VERSION } from '@/lib/legal/config';

const noticeSchema = z.discriminatedUnion('documentType', [
  z.object({ documentType: z.literal('cpx_processing_notice'), documentVersion: z.literal(PRIVACY_VERSION) }),
  z.object({ documentType: z.literal('terms'), documentVersion: z.literal(TERMS_VERSION) }),
]);

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const notice = noticeSchema.parse(await request.json());
  const admin = createAdminClient();

  const { data: existing, error: selectError } = await admin
    .from('legal_consents')
    .select('id')
    .eq('user_id', session.userId)
    .eq('document_type', notice.documentType)
    .eq('document_version', notice.documentVersion)
    .maybeSingle();
  if (selectError) throw selectError;

  if (!existing) {
    const { error } = await admin.from('legal_consents').insert({
      user_id: session.userId,
      subject_reference: session.userId,
      document_type: notice.documentType,
      document_version: notice.documentVersion,
      action: notice.documentType === 'terms' ? 'accepted' : 'acknowledged',
      source: notice.documentType === 'terms' ? 'terms_update_web' : 'cpx_web',
      evidence: notice.documentType === 'terms'
        ? { explicit_checkbox: true }
        : { processing: ['microphone_audio', 'transcript', 'ai_evaluation'] },
    });
    if (error) throw error;
  }

  return ok({ recorded: true });
});
