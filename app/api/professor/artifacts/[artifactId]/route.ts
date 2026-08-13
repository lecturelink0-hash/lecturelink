import { z } from 'zod';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const item = z.object({ id:z.string().uuid(), stem:z.string().trim().min(1).max(5000), choices:z.array(z.string().trim().min(1).max(1000)).min(2).max(10), answerIndex:z.number().int().min(0), explanation:z.string().max(10000), objective:z.string().max(1000) })
  .refine((value)=>value.answerIndex<value.choices.length,{message:'정답 번호가 선택지 범위를 벗어났습니다.',path:['answerIndex']});
const schema = z.object({ title:z.string().trim().min(1).max(160), items:z.array(item).min(1).max(100) })
  .refine((value)=>new Set(value.items.map((entry)=>entry.id)).size===value.items.length,{message:'중복된 문항이 있습니다.',path:['items']});

export const GET = withErrorHandling(async (_request:Request, context:{params:Promise<{artifactId:string}>})=>{
  await requireProfessor(); const {artifactId}=await context.params; const db=await createServerClient() as any;
  const {data,error}=await db.from('learning_artifacts').select('id,course_id,title,status,source_name,summary,objectives,formative_items(id,position,stem,choices,answer_index,explanation,objective,source_pages,cognitive_level,quality_flags,image_data_url,approved)').eq('id',artifactId).single();
  if(error||!data)throw new ApiException('artifact_not_found','결과를 찾을 수 없습니다.',404);
  const { data: publication } = await db
    .from('artifact_publications')
    .select('formative_attempts(id,score,total,status)')
    .eq('artifact_id', artifactId)
    .maybeSingle();
  const attempts = (publication?.formative_attempts ?? [])
    .filter((attempt:any) => attempt.status === 'submitted');
  const answered = attempts.reduce(
    (count:number, attempt:any) => count + (attempt.total ?? 0),
    0,
  );
  const correct = attempts.reduce(
    (count:number, attempt:any) => count + (attempt.score ?? 0),
    0,
  );
  return ok({
    ...data,
    analytics: {
      submittedCount: attempts.length,
      averagePercent: answered ? Math.round((correct / answered) * 100) : null,
    },
  });
});

export const PATCH = withErrorHandling(async(request:Request,context:{params:Promise<{artifactId:string}>})=>{
  await requireProfessor(); const {artifactId}=await context.params; const input=schema.parse(await request.json()); const db=await createServerClient() as any;
  const {error}=await db.rpc('save_formative_artifact',{
    target_artifact:artifactId,
    target_title:input.title,
    target_items:input.items,
  });
  if(error)throw new ApiException('save_failed','문항 수정사항을 저장하지 못했습니다. 변경 내용은 반영되지 않았습니다.',500);
  return ok({saved:true});
});
