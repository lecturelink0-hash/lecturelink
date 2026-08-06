import { requireProfessor } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { enqueueTeachingMaterial } from '@/lib/teaching/queue-material';
import { processTeachingMaterial } from '@/lib/teaching/process-material';
import { ApiException, ok, withErrorHandling } from '@/lib/utils/api';

export const maxDuration = 120;

export const POST = withErrorHandling(async (_request: Request, context: { params: Promise<{ materialId: string }> }) => {
  const session = await requireProfessor();
  const { materialId } = await context.params;
  const db = await createServerClient() as any;
  const { data: material } = await db.from('teaching_materials').select('id,status,updated_at')
    .eq('id', materialId).eq('professor_id', session.userId).maybeSingle();
  if (!material) throw new ApiException('material_not_found', '강의자료를 찾을 수 없습니다.', 404);
  if (material.status === 'ready') return ok(material);
  const queued = await enqueueTeachingMaterial(materialId, session.userId, true);
  if (queued.mode === 'inline') await processTeachingMaterial(materialId, session.userId);
  return ok({ id: materialId, status: 'processing' }, 202);
});
