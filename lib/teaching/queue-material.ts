import { Client as QStashClient } from '@upstash/qstash';

export async function enqueueTeachingMaterial(materialId: string, professorId: string, recovered = false) {
  const base = process.env.NEXT_PUBLIC_APP_URL ?? process.env.QSTASH_TARGET_URL;
  const token = process.env.QSTASH_TOKEN;
  if (!base || !token) return { mode: 'inline' as const };
  const origin = base.startsWith('http') ? base : `https://${base}`;
  const url = new URL('/api/queue/process-teaching-material', origin).toString();
  const result = await new QStashClient({ token }).publishJSON({
    url, body: { materialId, professorId }, retries: 3,
    deduplicationId: recovered ? `${materialId}:recover:${Date.now()}` : materialId,
  });
  return { mode: 'qstash' as const, messageId: result.messageId };
}
