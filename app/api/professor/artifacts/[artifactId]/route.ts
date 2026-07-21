import { z } from 'zod';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const item = z.object({ id:z.string().uuid(), stem:z.string().min(1), choices:z.array(z.string()).min(2), answerIndex:z.number().int().min(0), explanation:z.string(), objective:z.string(), approved:z.boolean() });
const schema = z.object({ title:z.string().min(1).optional(), items:z.array(item).min(1) });

export const GET = withErrorHandling(async (_request:Request, context:{params:Promise<{artifactId:string}>})=>{
  await requireProfessor(); const {artifactId}=await context.params; const db=await createServerClient() as any;
  const {data,error}=await db.from('learning_artifacts').select('id,course_id,title,status,summary,objectives,formative_items(id,position,stem,choices,answer_index,explanation,objective,source_pages,cognitive_level,quality_flags,approved)').eq('id',artifactId).single();
  if(error||!data)throw new ApiException('artifact_not_found','결과를 찾을 수 없습니다.',404); return ok(data);
});

export const PATCH = withErrorHandling(async(request:Request,context:{params:Promise<{artifactId:string}>})=>{
  await requireProfessor(); const {artifactId}=await context.params; const input=schema.parse(await request.json()); const db=await createServerClient() as any;
  if(input.title)await db.from('learning_artifacts').update({title:input.title,status:input.items.every(x=>x.approved)?'approved':'review',approved_at:input.items.every(x=>x.approved)?new Date().toISOString():null}).eq('id',artifactId);
  for(const x of input.items){const {error}=await db.from('formative_items').update({stem:x.stem,choices:x.choices,answer_index:x.answerIndex,explanation:x.explanation,objective:x.objective,approved:x.approved,updated_at:new Date().toISOString()}).eq('id',x.id).eq('artifact_id',artifactId);if(error)throw new ApiException('save_failed','문항 수정사항을 저장하지 못했습니다.',500)}
  return ok({saved:true});
});
