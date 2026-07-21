import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/auth/session';
import { ProfessorShell } from '@/components/professor/ProfessorShell';

export default async function ProfessorLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) redirect('/login?next=/professor');
  if (session.profile.accountType !== 'professor' && session.role !== 'admin') redirect('/dashboard');
  return <ProfessorShell displayName={session.profile.displayName ?? '교수님'} schoolName={session.profile.school?.shortName ?? null}>{children}</ProfessorShell>;
}
