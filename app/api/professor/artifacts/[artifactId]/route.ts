import { z } from 'zod';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const item = z.object({ id:z.string().uuid(), stem:z.string().min(1), choices:z.array(z.string()).min(2), answerIndex:z.number().int().min(0), explanation:z.string(), objective:z.string() });
const schema = z.object({ title:z.string().min(1).optional(), items:z.array(item).min(1) });

export const GET = withErrorHandling(async (_request:Request, context:{params:Promise<{artifactId:string}>})=>{
  await requireProfessor(); const {artifactId}=await context.params; const db=await createServerClient() as any;
  const {data,error}=await db.from('learning_artifacts').select('id,course_id,title,status,summary,objectives,formative_items(id,position,stem,choices,answer_index,explanation,objective,source_pages,cognitive_level,quality_flags,image_data_url,approved)').eq('id',artifactId).single();
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
  if(input.title)await db.from('learning_artifacts').update({title:input.title,status:'approved',approved_at:new Date().toISOString()}).eq('id',artifactId);
  const {data:existing}=await db.from('formative_items').select('id').eq('artifact_id',artifactId);
  const existingIds=new Set((existing??[]).map((row:any)=>row.id));
  for(const [position,x] of input.items.entries()){
    const values={position,stem:x.stem,choices:x.choices,answer_index:x.answerIndex,explanation:x.explanation,objective:x.objective,approved:true,updated_at:new Date().toISOString()};
    const result=existingIds.has(x.id)
      ? await db.from('formative_items').update(values).eq('id',x.id).eq('artifact_id',artifactId)
      : await db.from('formative_items').insert({id:x.id,artifact_id:artifactId,...values,source_pages:[],quality_flags:[]});
    if(result.error)throw new ApiException('save_failed','문항 수정사항을 저장하지 못했습니다.',500);
  }
  const incomingIds=input.items.map(x=>x.id);
  const {error:deleteError}=await db.from('formative_items').delete().eq('artifact_id',artifactId).not('id','in',`(${incomingIds.join(',')})`);
  if(deleteError)throw new ApiException('save_failed','삭제한 문항을 반영하지 못했습니다.',500);
  return ok({saved:true});
});
