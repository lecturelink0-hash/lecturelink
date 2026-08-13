import 'server-only';
import { createAdminClient } from '@/lib/db/admin';
import { TERMS_VERSION } from '@/lib/legal/config';

export async function hasCurrentTermsConsent(userId: string) {
  const { data, error } = await createAdminClient()
    .from('legal_consents')
    .select('id')
    .eq('user_id', userId)
    .eq('document_type', 'terms')
    .eq('document_version', TERMS_VERSION)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}
