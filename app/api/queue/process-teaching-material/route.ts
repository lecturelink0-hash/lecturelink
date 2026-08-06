import { Receiver } from '@upstash/qstash';
import { z } from 'zod';
import { processTeachingMaterial } from '@/lib/teaching/process-material';

export const maxDuration = 120;
const schema = z.object({ materialId: z.string().uuid(), professorId: z.string().uuid() });

export async function POST(request: Request) {
  const body = await request.text();
  const signature = request.headers.get('upstash-signature') ?? '';
  const currentSigningKey = process.env.QSTASH_CURRENT_SIGNING_KEY;
  const nextSigningKey = process.env.QSTASH_NEXT_SIGNING_KEY;
  if (!currentSigningKey || !nextSigningKey) return new Response('Queue signing keys unavailable', { status: 503 });
  const receiver = new Receiver({ currentSigningKey, nextSigningKey });
  if (!(await receiver.verify({ signature, body }).catch(() => false))) return new Response('Invalid signature', { status: 401 });
  const parsed = schema.safeParse(JSON.parse(body));
  if (!parsed.success) return new Response('Invalid payload', { status: 400 });
  try {
    await processTeachingMaterial(parsed.data.materialId, parsed.data.professorId);
    return new Response('OK');
  } catch (error) {
    return new Response(error instanceof Error ? error.message : 'Processing failed', { status: 500 });
  }
}
