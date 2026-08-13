import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/auth/session';
import { ProfessorMyPage } from '@/components/professor/ProfessorMyPage';

export default async function ProfessorMyPageRoute() {
  const session = await getCurrentSession();
  if (!session) redirect('/login?next=/professor/mypage');
  if (session.profile.accountType !== 'professor' && session.role !== 'admin') redirect('/mypage');

  return (
    <ProfessorMyPage
      displayName={session.profile.displayName ?? '교수님'}
      email={session.email}
      schoolId={session.profile.school?.id ?? null}
      schoolName={session.profile.school?.name ?? null}
      schoolShortName={session.profile.school?.shortName ?? null}
      facultyStatus={session.profile.facultyStatus}
    />
  );
}
