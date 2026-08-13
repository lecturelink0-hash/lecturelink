import { z } from 'zod';
import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';
const patch=z.object({action:z.enum(['start','end']),confirm:z.boolean().optional()});

export const GET=withErrorHandling(async(_r:Request,c:{params:Promise<{sessionId:string}>})=>{
 const user=await requireProfessor();const {sessionId}=await c.params;const db=await createServerClient() as any;
 const {data:s}=await db.from('live_assessment_sessions').select('*').eq('id',sessionId).eq('professor_id',user.userId).single();if(!s)throw new ApiException('not_found','세션을 찾을 수 없습니다.',404);
 const {data:p}=await db.from('live_assessment_participants').select('id,name,status,auto_submitted,score,total,joined_at,submitted_at,live_assessment_answers(item_id,selected_index,is_correct)').eq('session_id',sessionId).neq('status','removed').order('joined_at');
 const {data:artifact}=await db.from('learning_artifacts').select('material_id,teaching_materials(file_name,file_type,storage_path)').eq('id',s.artifact_id).single();
 let sourceMaterial:any=null;const material=artifact?.teaching_materials;
 if(material?.storage_path){const {data:signed}=await db.storage.from('teaching-materials').createSignedUrl(material.storage_path,3600);sourceMaterial={fileName:material.file_name,fileType:material.file_type,url:signed?.signedUrl??null};}
 return ok({session:s,participants:p??[],sourceMaterial});
});
export const PATCH=withErrorHandling(async(r:Request,c:{params:Promise<{sessionId:string}>})=>{
 const user=await requireProfessor();const {sessionId}=await c.params;const input=patch.parse(await r.json());const db=await createServerClient() as any;
 const {data:s}=await db.from('live_assessment_sessions').select('status').eq('id',sessionId).eq('professor_id',user.userId).single();if(!s)throw new ApiException('not_found','세션을 찾을 수 없습니다.',404);
 if(input.action==='start'){if(s.status!=='lobby')throw new ApiException('invalid_state','대기 중인 세션만 시작할 수 있습니다.',409);const {error:startError}=await db.rpc('start_live_assessment',{target_session:sessionId});if(startError)throw new ApiException('start_failed','평가를 시작하지 못했습니다.',500);}
 else {if(!input.confirm)throw new ApiException('confirmation_required','종료 확인이 필요합니다.',400);const {error}=await db.rpc('finish_live_assessment',{target_session:sessionId});if(error)throw new ApiException('finish_failed','평가를 종료하지 못했습니다.',500);}
 return ok({status:input.action==='start'?'live':'ended'});
});
export const DELETE=withErrorHandling(async(r:Request,c:{params:Promise<{sessionId:string}>})=>{const user=await requireProfessor();const {sessionId}=await c.params;const participantId=new URL(r.url).searchParams.get('participantId');if(!participantId)throw new ApiException('invalid','참여자가 필요합니다.',400);const db=await createServerClient() as any;const {data:s}=await db.from('live_assessment_sessions').select('id').eq('id',sessionId).eq('professor_id',user.userId).eq('status','lobby').single();if(!s)throw new ApiException('invalid_state','대기실에서만 내보낼 수 있습니다.',409);const {error}=await db.from('live_assessment_participants').update({status:'removed'}).eq('id',participantId).eq('session_id',sessionId);if(error)throw new ApiException('remove_failed','학생을 내보내지 못했습니다.',500);return ok({removed:true})});
