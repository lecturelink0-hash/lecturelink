import { requireStudent } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
export const GET=withErrorHandling(async(_request:Request,context:{params:Promise<{publicationId:string}>})=>{await requireStudent();const {publicationId}=await context.params;const db=await createServerClient() as any;const {data,error}=await db.from('artifact_publications').select('id,learning_artifacts(id,title,summary,formative_items(id,position,stem,choices,image_data_url))').eq('id',publicationId).eq('is_open',true).single();if(error||!data)throw new ApiException('not_found','배포된 형성평가를 찾을 수 없습니다.',404);return ok(data)});
