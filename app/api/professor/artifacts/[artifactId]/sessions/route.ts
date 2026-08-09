import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { newJoinCode } from '@/lib/live-assessment';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

export const POST=withErrorHandling(async(_r:Request,c:{params:Promise<{artifactId:string}>})=>{
  const user=await requireProfessor(); const {artifactId}=await c.params; const db=await createServerClient() as any;
  const {data:a}=await db.from('learning_artifacts').select('id,course_id,title,formative_items(id,position,stem,choices,answer_index,explanation,objective,image_data_url,approved)').eq('id',artifactId).eq('created_by',user.userId).single();
  if(!a)throw new ApiException('not_found','형성평가를 찾을 수 없습니다.',404);
  const items=(a.formative_items??[]).filter((x:any)=>x.approved).sort((x:any,y:any)=>x.position-y.position);
  if(!items.length)throw new ApiException('questions_required','저장된 문항이 필요합니다.',409);
  let data:any,error:any;
  for(let i=0;i<5;i++){({data,error}=await db.from('live_assessment_sessions').insert({artifact_id:a.id,course_id:a.course_id,professor_id:user.userId,title:a.title,join_code:newJoinCode(),question_snapshot:items.map((x:any)=>({id:x.id,stem:x.stem,choices:x.choices,answerIndex:x.answer_index,explanation:x.explanation,objective:x.objective,imageDataUrl:x.image_data_url}))}).select('id,join_code,status,title').single());if(!error)break;}
  if(error)throw new ApiException('create_failed','평가 세션을 만들지 못했습니다.',500);
  return ok(data);
});
