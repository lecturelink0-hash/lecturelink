/**
 * 오답 기반 유사문제 생성 (사용자 트리거 AI 생성)
 *
 * 흐름:
 *   1. 세션 검증 + 일일 AI 비용 캡 + 문항 quota 사전 체크
 *   2. sub_topic / subject 메타 조회
 *   3. admitGeneratedQuestions 로 1문항 생성·검증·저장 (source=ai_user_triggered)
 *   4. admit 된 문항 수만큼 quota 차감
 *   5. 저장된 문항을 SimilarQuestion 형태로 반환 (오답노트 풀이 패널이 바로 사용)
 *
 * 관리자 전용 /api/questions/generate 와 달리 일반 사용자(requireSession)가 호출한다.
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { admitGeneratedQuestions } from '@/lib/ai/admission';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { requireQuota, consumeQuota } from '@/lib/quota/check';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';

const TIER_BADGE: Record<string, { label: string; color: 'curated' | 'community' | 'beta' }> = {
  curated: { label: '의사 검수', color: 'curated' },
  community: { label: 'AI 검증', color: 'community' },
  beta: { label: '베타', color: 'beta' },
};

const bodySchema = z.object({
  sub_topic_id: z.string().uuid(),
  difficulty: z.number().int().min(1).max(3).optional(),
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const body = bodySchema.parse(await request.json());

  // AI 호출 전 사전 가드
  await requireDailyCostCap();
  await requireQuota(session.userId, 'questions', 1);

  const admin = createAdminClient();

  // sub_topic + subject 메타 조회
  const { data: subTopic, error: stError } = await admin
    .from('sub_topics')
    .select(
      `
      id,
      name,
      exam_relevance,
      is_risk_category,
      subject:subjects ( id, name )
    `,
    )
    .eq('id', body.sub_topic_id)
    .maybeSingle();

  if (stError || !subTopic) {
    throw new ApiException('sub_topic_not_found', 'Sub-topic 을 찾을 수 없습니다.', 404);
  }

  const subject = Array.isArray(subTopic.subject) ? subTopic.subject[0] : subTopic.subject;
  if (!subject) {
    throw new ApiException('subject_not_found', '연결된 과목이 없습니다.', 404);
  }

  // 생성·검증·저장 (오답 기반 사용자 트리거 → ai_user_triggered)
  const result = await admitGeneratedQuestions({
    subjectId: (subject as { id: string }).id,
    subjectName: (subject as { name: string }).name,
    subTopicId: subTopic.id,
    subTopicName: subTopic.name,
    examRelevance: subTopic.exam_relevance as 1 | 2 | 3,
    isRiskCategory: subTopic.is_risk_category,
    difficulty: (body.difficulty ?? 2) as 1 | 2 | 3,
    count: 1,
    style: 'kmle',
    source: 'ai_user_triggered',
    createdBy: session.userId,
    saveToDb: true,
  });

  const admitted = result.admitted.find((a) => a.dbId);
  if (!admitted?.dbId) {
    // 생성은 됐으나 검증을 통과하지 못한 경우 (할당량은 차감하지 않음)
    throw new ApiException(
      'generation_failed',
      '유사문제 생성에 실패했습니다. 잠시 후 다시 시도해주세요.',
      502,
    );
  }

  // 성공한 admit 수만큼만 차감
  await consumeQuota(session.userId, 'questions', 1);

  // 저장된 문항을 SimilarQuestion 형태로 반환
  const { data: row, error: qErr } = await admin
    .from('questions')
    .select(
      `
      id, stem, choices, difficulty, image_url, image_type, tier,
      sub_topic:sub_topics ( id, name, subject:subjects ( id, name ) )
    `,
    )
    .eq('id', admitted.dbId)
    .single();

  if (qErr || !row) {
    throw new ApiException('question_not_found', '생성된 문항을 불러오지 못했습니다.', 500);
  }

  const r = row as Record<string, unknown>;
  const st = r.sub_topic as Record<string, unknown> | null;
  const stSubject = st?.subject as Record<string, unknown> | null;
  const tier = (r.tier as string) ?? 'beta';

  return ok({
    id: r.id as string,
    stem: r.stem as string,
    choices: r.choices as string[],
    difficulty: r.difficulty as 1 | 2 | 3,
    imageUrl: (r.image_url as string) ?? null,
    imageType: (r.image_type as string) ?? null,
    tier,
    badge: TIER_BADGE[tier] ?? TIER_BADGE.community,
    subjectName: (stSubject?.name as string) ?? '기타',
    subTopicName: (st?.name as string) ?? '미분류',
    subTopicId: (st?.id as string) ?? null,
  });
});
