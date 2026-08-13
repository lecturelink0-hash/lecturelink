import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/auth/session';
import { hasCurrentTermsConsent } from '@/lib/legal/consent';
import { ProfessorOnboardingForm } from './ProfessorOnboardingForm';
import './professor-onboarding.css';

export default async function ProfessorOnboardingPage() {
  const session = await getCurrentSession();
  const localPreview =
    process.env.NODE_ENV === 'development' &&
    process.env.LOCAL_FACULTY_ONBOARDING_PREVIEW === 'true';
  if (!session) redirect('/login?next=/professor-onboarding');
  if (!session.email) redirect('/complete-profile');
  if (!localPreview && !(await hasCurrentTermsConsent(session.userId))) redirect('/legal-consent');
  if (session.profile.accountType !== 'professor' && session.role !== 'admin') redirect('/onboarding');
  if (session.profile.onboardedAt) redirect('/professor');

  return <ProfessorOnboardingForm initialName={session.profile.displayName ?? ''} />;
}
