import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/auth/session';
import { hasCurrentTermsConsent } from '@/lib/legal/consent';
import { TermsConsentForm } from '@/components/account/TermsConsentForm';

export default async function LegalConsentPage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login?next=/legal-consent');
  if (await hasCurrentTermsConsent(session.userId)) {
    redirect(session.profile.accountType === 'professor' ? '/professor' : '/dashboard');
  }
  return <TermsConsentForm destination={session.profile.accountType === 'professor' ? '/professor' : '/dashboard'} />;
}
