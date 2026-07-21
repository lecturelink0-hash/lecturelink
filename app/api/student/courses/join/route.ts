import { z } from 'zod';
import { requireStudent } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
export const POST=withErrorHandling(async(request:Request)=>{await requireStudent();const {code}=z.object({code:z.string().trim().min(4).max(12)}).parse(await request.json());const db=await createServerClient() as any;const {data,error}=await db.rpc('join_course',{join_code:code});if(error)throw new ApiException('join_failed','강의 코드를 확인해주세요.',404);return ok({courseId:data})});
