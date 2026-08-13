import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/auth/session';
import { ProfessorShell } from '@/components/professor/ProfessorShell';
import { Footer } from '@/components/layout/Footer';
import { hasCurrentTermsConsent } from '@/lib/legal/consent';

export default async function ProfessorLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  const localPreview = process.env.NODE_ENV === 'development' && process.env.LOCAL_FACULTY_UI_PREVIEW === 'true';
  if (!session) redirect('/login?next=/professor');
  if (session.profile.accountType !== 'professor' && session.role !== 'admin') redirect('/dashboard');
  if (!localPreview && !(await hasCurrentTermsConsent(session.userId))) redirect('/legal-consent');
  if (!session.profile.onboardedAt && session.role !== 'admin') redirect('/professor-onboarding');
  return (
    <div className="ll-app-shell">
      <ProfessorShell displayName={session.profile.displayName ?? '교수님'} schoolName={session.profile.school?.shortName ?? null}>
        {children}
      </ProfessorShell>
      <Footer variant="faculty" />
    </div>
  );
}
