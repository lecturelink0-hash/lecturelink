import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

export const GET = withErrorHandling(async (
  _request: Request,
  context: { params: Promise<{ courseId: string }> },
) => {
  const session = await requireProfessor();
  const { courseId } = await context.params;
  const db = await createServerClient() as any;
  const { data: course } = await db
    .from('courses')
    .select('id,title')
    .eq('id', courseId)
    .eq('professor_id', session.userId)
    .single();
  if (!course) throw new ApiException('course_not_found', '강의를 찾을 수 없습니다.', 404);

  const { data: publications } = await db
    .from('artifact_publications')
    .select('id,artifact_id,learning_artifacts(id,title),formative_attempts(id,score,total,status,student_id,formative_answers(item_id,is_correct))')
    .eq('course_id', courseId);
  const attempts = (publications ?? [])
    .flatMap((publication: any) => publication.formative_attempts ?? [])
    .filter((attempt: any) => attempt.status === 'submitted');
  const answered = attempts.reduce((count: number, attempt: any) => count + (attempt.total ?? 0), 0);
  const correct = attempts.reduce((count: number, attempt: any) => count + (attempt.score ?? 0), 0);
  const itemMap = new Map<string, { answers: number; correct: number }>();
  for (const attempt of attempts) {
    for (const answer of attempt.formative_answers ?? []) {
      const value = itemMap.get(answer.item_id) ?? { answers: 0, correct: 0 };
      value.answers++;
      if (answer.is_correct) value.correct++;
      itemMap.set(answer.item_id, value);
    }
  }
  const artifacts = (publications ?? []).map((publication: any) => {
    const artifactAttempts = (publication.formative_attempts ?? [])
      .filter((attempt: any) => attempt.status === 'submitted');
    const artifactAnswered = artifactAttempts.reduce(
      (count: number, attempt: any) => count + (attempt.total ?? 0),
      0,
    );
    const artifactCorrect = artifactAttempts.reduce(
      (count: number, attempt: any) => count + (attempt.score ?? 0),
      0,
    );
    return {
      artifactId: publication.artifact_id ?? publication.learning_artifacts?.id,
      submittedCount: artifactAttempts.length,
      averagePercent: artifactAnswered
        ? Math.round((artifactCorrect / artifactAnswered) * 100)
        : null,
    };
  });

  return ok({
    course,
    publicationCount: (publications ?? []).length,
    submittedCount: attempts.length,
    averagePercent: answered ? Math.round((correct / answered) * 100) : null,
    artifacts,
    items: [...itemMap.entries()]
      .map(([itemId, value]) => ({
        itemId,
        ...value,
        correctPercent: Math.round((value.correct / value.answers) * 100),
      }))
      .sort((a, b) => a.correctPercent - b.correctPercent),
  });
});
