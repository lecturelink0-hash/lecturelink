import { ProfessorHome } from '@/components/professor/ProfessorHome';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';

export default async function ProfessorHomePage() {
  const session = await requireProfessor();
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
