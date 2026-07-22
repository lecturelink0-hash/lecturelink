import { z } from 'zod';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const question = z.object({ stem:z.string().min(1), choices:z.array(z.string()).min(2), answerIndex:z.number().int().min(0), explanation:z.string().default(''), objective:z.string().default(''), sourcePages:z.array(z.number()).default([]), cognitiveLevel:z.string().optional(), qualityFlags:z.array(z.string()).default([]) });
const schema = z.object({ title:z.string().min(1), sourceName:z.string().optional(), summary:z.string().optional(), objectives:z.array(z.string()).default([]), questions:z.array(question).min(1) });

export const POST = withErrorHandling(async (request: Request, context: { params: Promise<{ courseId: string }> }) => {
  const session = await requireProfessor();
  const { courseId } = await context.params;
  const input = schema.parse(await request.json());
  const db = await createServerClient() as any;
  const { data: course } = await db.from('courses').select('id').eq('id',courseId).eq('professor_id',session.userId).maybeSingle();
  if (!course) throw new ApiException('course_not_found','강의를 찾을 수 없습니다.',404);
  const { data: artifact, error } = await db.from('learning_artifacts').insert({ course_id:courseId, created_by:session.userId, type:'formative', title:input.title, status:'review', source_name:input.sourceName ?? null, summary:input.summary ?? null, objectives:input.objectives, content:{ kind:'formative' } }).select('id').single();
  if (error || !artifact) throw new ApiException('save_failed','형성평가를 저장하지 못했습니다.',500);
  const rows = input.questions.map((item,index)=>({ artifact_id:artifact.id, position:index, stem:item.stem, choices:item.choices, answer_index:item.answerIndex, explanation:item.explanation, objective:item.objective, source_pages:item.sourcePages, cognitive_level:item.cognitiveLevel ?? null, quality_flags:item.qualityFlags }));
  const { error: itemsError } = await db.from('formative_items').insert(rows);
  if (itemsError) { await db.from('learning_artifacts').delete().eq('id',artifact.id); throw new ApiException('save_failed','문항을 저장하지 못했습니다.',500); }
  return ok({ id: artifact.id }, 201);
});
