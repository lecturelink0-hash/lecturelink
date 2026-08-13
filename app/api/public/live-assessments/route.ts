import { z } from 'zod';
import { createHash } from 'node:crypto';
import { createAdminClient } from '@/lib/db/admin';
import { newAccessToken, tokenHash } from '@/lib/live-assessment';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';
import { PRIVACY_VERSION } from '@/lib/legal/config';
const schema=z.object({code:z.string().trim().length(6),name:z.string().trim().min(1).max(40),privacyAccepted:z.literal(true),privacyVersion:z.literal(PRIVACY_VERSION)});
const MAX_PARTICIPANTS = 300;

function clientAddress(request: Request) {
  return request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || request.headers.get('x-real-ip')?.trim()
    || 'unknown';
}

export const POST=withErrorHandling(async(r:Request)=>{
  const i=schema.parse(await r.json());
  const code=i.code.toUpperCase();
  const db=createAdminClient() as any;
  const address=clientAddress(r);
  const rateKeys=[
    {key:createHash('sha256').update(`${address}:${code}`).digest('hex'),maximum:120},
    {key:createHash('sha256').update(`${address}:${code}:${i.name.toLocaleLowerCase('ko-KR')}`).digest('hex'),maximum:10},
  ];
  for(const limit of rateKeys){
    const {data:allowed,error:rateError}=await db.rpc('consume_live_assessment_join_attempt',{target_key:limit.key,window_seconds:60,maximum_attempts:limit.maximum});
    if(rateError)throw new ApiException('rate_limit_unavailable','참여 요청을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.',503);
    if(!allowed)throw new ApiException('rate_limit','참여 요청이 너무 많습니다. 1분 후 다시 시도해주세요.',429);
  }
  const {data:s}=await db.from('live_assessment_sessions').select('id,title,status').eq('join_code',code).single();
  if(!s)throw new ApiException('not_found','참여 코드를 확인해주세요.',404);
  if(s.status!=='lobby')throw new ApiException('closed','이미 시작된 평가입니다. 새로 참여할 수 없습니다.',409);
  const normalizedName=i.name.replace(/\s+/g,' ').trim();
  const token=newAccessToken();
  const {data:joinResult,error}=await db.rpc('join_live_assessment',{target_session:s.id,target_name:normalizedName,target_token_hash:tokenHash(token),maximum_participants:MAX_PARTICIPANTS});
  if(error)throw new ApiException('join_failed','참여하지 못했습니다.',500);
  if(joinResult?.error==='duplicate_name')throw new ApiException('duplicate_name','같은 이름으로 이미 참여 중입니다. 이름 뒤에 번호를 붙여주세요.',409);
  if(joinResult?.error==='session_full')throw new ApiException('session_full','참여 인원이 가득 찼습니다. 교수자에게 문의해주세요.',409);
  if(joinResult?.error==='closed')throw new ApiException('closed','이미 시작된 평가입니다. 새로 참여할 수 없습니다.',409);
  if(!joinResult?.participant_id)throw new ApiException('join_failed','참여하지 못했습니다.',500);
  const {error:consentError}=await db.from('legal_consents').insert({
    user_id:null,
    subject_reference:joinResult.participant_id,
    document_type:'live_assessment_privacy',
    document_version:i.privacyVersion,
    action:'acknowledged',
    source:'public_live_assessment',
    evidence:{session_id:s.id,client_address_hash:createHash('sha256').update(address).digest('hex')},
  });
  if(consentError){
    await db.from('live_assessment_participants').delete().eq('id',joinResult.participant_id);
    throw new ApiException('privacy_record_failed','개인정보 안내 확인을 기록하지 못해 참여를 중단했습니다.',503);
  }
  return ok({sessionId:s.id,participantId:joinResult.participant_id,token,title:s.title,status:s.status});
});
