import { z } from 'zod';
import { createAdminClient } from '@/lib/db/admin';
import { newAccessToken, tokenHash } from '@/lib/live-assessment';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';
const schema=z.object({code:z.string().trim().length(6),name:z.string().trim().min(1).max(40)});
export const POST=withErrorHandling(async(r:Request)=>{const i=schema.parse(await r.json());const db=createAdminClient() as any;const {data:s}=await db.from('live_assessment_sessions').select('id,title,status').eq('join_code',i.code.toUpperCase()).single();if(!s)throw new ApiException('not_found','참여 코드를 확인해주세요.',404);if(s.status!=='lobby')throw new ApiException('closed','이미 시작된 평가입니다. 새로 참여할 수 없습니다.',409);const token=newAccessToken();const {data:p,error}=await db.from('live_assessment_participants').insert({session_id:s.id,name:i.name,access_token_hash:tokenHash(token)}).select('id').single();if(error)throw new ApiException('join_failed','참여하지 못했습니다.',500);return ok({sessionId:s.id,participantId:p.id,token,title:s.title,status:s.status})});
