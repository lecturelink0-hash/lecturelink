import { requireStudent } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling } from '@/lib/utils/api';
export const GET=withErrorHandling(async()=>{await requireStudent();const db=await createServerClient() as any;const {data}=await db.from('artifact_publications').select('id,published_at,courses(id,title,code),learning_artifacts(id,title,type,summary,objectives)').eq('is_open',true).order('published_at',{ascending:false});return ok(data??[])});
