import { ProfessorHome } from '@/components/professor/ProfessorHome';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';

export default async function ProfessorHomePage() {
  const session = await requireProfessor();
  const localPreview =
    process.env.NODE_ENV === 'development' &&
    process.env.LOCAL_FACULTY_UI_PREVIEW === 'true';

  if (localPreview) {
    return (
      <ProfessorHome
        displayName={session.profile.displayName ?? '교수'}
        courses={[
          { id: 'preview-cardiology', title: '순환기학', term: '2026년 2학기', created_at: '2026-07-20T00:00:00.000Z' },
          { id: 'preview-arrhythmia', title: '부정맥 약물', term: '임상약리학', created_at: '2026-07-18T00:00:00.000Z' },
        ]}
        recentArtifacts={[]}
      />
    );
  }

  const db = await createServerClient() as any;
  const { data: courses } = await db
    .from('courses')
    .select('id,title,term,created_at')
    .eq('professor_id', session.userId)
    .order('created_at', { ascending: false });

  const courseList = courses ?? [];
  let recentArtifacts: any[] = [];
  if (courseList.length > 0) {
    const { data } = await db
      .from('learning_artifacts')
      .select('id,course_id,type,title,status,created_at')
      .in('course_id', courseList.map((course: any) => course.id))
      .order('created_at', { ascending: false })
      .limit(4);
    recentArtifacts = data ?? [];
  }

  return (
    <ProfessorHome
      displayName={session.profile.displayName ?? '교수'}
      courses={courseList}
      recentArtifacts={recentArtifacts}
    />
  );
}
