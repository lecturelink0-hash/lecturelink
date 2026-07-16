/**
 * 추천 엔진 — Track B 사용자 풀이용
 *
 * 흐름:
 *   1. 사용자 코호트 조회 → cohort_sub_topic_scores 가져옴
 *   2. 사용자 약점 영역 조회 → user_weak_areas
 *   3. Multi-armed bandit 으로 sub_topic 별 노출 수 결정 (80/15/5)
 *   4. 각 sub_topic 에서 문항 추출 (이미 푼 문항 제외)
 *   5. 신뢰 등급(tier) 순으로 우선 정렬 — curated > community > beta
 */

import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import { allocateCount, type BanditAllocation, type BanditSubTopicInput } from './bandit';
import type { QuestionForUser } from '@/lib/types/domain';
import type { ContentTier } from '@/lib/types/database';

const TIER_PRIORITY: Record<ContentTier, number> = {
  curated: 3,
  community: 2,
  beta: 1,
};

const TIER_BADGE: Record<ContentTier, { label: string; color: 'curated' | 'community' | 'beta' }> = {
  curated: { label: '✓ 의사 검수 완료', color: 'curated' },
  community: { label: 'AI 검증', color: 'community' },
  beta: { label: '⚠ 베타', color: 'beta' },
};

export interface RecommendInput {
  userId: string;
  cohortId?: string;
  subjectId?: string;
  count?: number;          // 기본 10
  excludeAnswered?: boolean; // 이미 푼 문항 제외 (기본 true)
}

export interface RecommendResult {
  questions: QuestionForUser[];
  rationale: {
    cohortUsed: string | null;
    allocations: BanditAllocation[];
    weakSubTopics: string[];
    excludedCount: number;
  };
}

export async function recommendQuestions(
  input: RecommendInput,
): Promise<RecommendResult> {
  const supabase = await createServerClient();
  const admin = createAdminClient();
  const count = input.count ?? 10;
  const excludeAnswered = input.excludeAnswered ?? true;

  // ───── 1. 코호트 sub_topic 점수 조회 ─────
  let cohortScores: BanditSubTopicInput[] = [];

  if (input.cohortId) {
    const { data: scores } = await admin
      .from('cohort_sub_topic_scores')
      .select('sub_topic_id, weighted_score')
      .eq('cohort_id', input.cohortId);

    cohortScores = (scores ?? []).map((s) => ({
      subTopicId: s.sub_topic_id,
      weightedScore: s.weighted_score,
    }));
  }

  // 점수가 없거나 코호트가 없을 경우 — subject 의 모든 sub_topic 균등 분포
  if (cohortScores.length === 0 && input.subjectId) {
    const { data: subTopics } = await admin
      .from('sub_topics')
      .select('id, exam_relevance')
      .eq('subject_id', input.subjectId);

    cohortScores = (subTopics ?? []).map((st) => ({
      subTopicId: st.id,
      weightedScore: (st.exam_relevance ?? 2) / 3,
    }));
  }

  if (cohortScores.length === 0) {
    return {
      questions: [],
      rationale: {
        cohortUsed: input.cohortId ?? null,
        allocations: [],
        weakSubTopics: [],
        excludedCount: 0,
      },
    };
  }

  // ───── 2. 사용자 약점 영역 조회 → boost ─────
  const { data: weakAreas } = await admin
    .from('user_weak_areas')
    .select('sub_topic_id, error_rate, severity')
    .eq('user_id', input.userId)
    .order('severity', { ascending: false })
    .limit(10);

  const weakMap = new Map<string, number>();
  for (const w of weakAreas ?? []) {
    // severity 1~3 + error_rate 0~1 결합 → 0~1
    const boost = Math.min(1, (w.severity ?? 1) / 3 + (w.error_rate ?? 0) * 0.5);
    weakMap.set(w.sub_topic_id, boost);
  }

  const banditInputs: BanditSubTopicInput[] = cohortScores.map((s) => ({
    ...s,
    weaknessBoost: weakMap.get(s.subTopicId) ?? 0,
  }));

  // ───── 3. Bandit 할당 ─────
  const allocations = allocateCount(banditInputs, count);

  // ───── 4. 이미 푼 문항 ID 수집 ─────
  let excludeIds: string[] = [];
  if (excludeAnswered) {
    const { data: attempts } = await admin
      .from('user_attempts')
      .select('question_id')
      .eq('user_id', input.userId)
      .not('question_id', 'is', null) // private 풀이(question_id null)는 public 추천 제외와 무관
      .order('created_at', { ascending: false })
      .limit(500);
    excludeIds = (attempts ?? [])
      .map((a) => a.question_id)
      .filter((id): id is string => id !== null);
  }

  // ───── 5. 각 sub_topic 에서 문항 추출 ─────
  const fetched: QuestionForUser[] = [];

  await Promise.all(
    allocations.map(async (alloc) => {
      // tier 우선순위 순으로 정렬. open_image FK 도 JOIN 해서 attribution 정보 가져옴.
      let query = admin
        .from('questions')
        .select(
          `
          id,
          stem,
          choices,
          concepts,
          difficulty,
          image_url,
          image_type,
          tier,
          sub_topic_id,
          open_image_id,
          open_image:open_images (
            attribution_text,
            license,
            original_url
          ),
          sub_topics!inner (
            name,
            subjects!inner ( name )
          )
        `,
        )
        .eq('sub_topic_id', alloc.subTopicId)
        .eq('status', 'active');

      if (excludeIds.length > 0) {
        query = query.not('id', 'in', `(${excludeIds.join(',')})`);
      }

      const { data: rows } = await query
        .order('tier', { ascending: false })  // curated > community > beta (string desc 가 우연히 맞지 않음)
        .limit(alloc.count * 2);  // 부족할 경우 대비 2배 가져옴

      if (!rows) return;

      // tier 우선순위로 재정렬 (string desc 가 안 맞으므로 명시 정렬)
      const sorted = [...rows].sort(
        (a, b) =>
          (TIER_PRIORITY[b.tier as ContentTier] ?? 0) -
          (TIER_PRIORITY[a.tier as ContentTier] ?? 0),
      );

      for (const r of sorted.slice(0, alloc.count)) {
        const subTopic = Array.isArray(r.sub_topics) ? r.sub_topics[0] : r.sub_topics;
        const subject = subTopic && Array.isArray((subTopic as { subjects: unknown }).subjects)
          ? ((subTopic as { subjects: { name: string }[] }).subjects[0])
          : ((subTopic as { subjects: { name: string } } | undefined)?.subjects);

        const oi = Array.isArray(r.open_image) ? r.open_image[0] : r.open_image;

        fetched.push({
          id: r.id,
          stem: r.stem,
          choices: r.choices as string[],
          concepts: r.concepts ?? [],
          difficulty: r.difficulty as 1 | 2 | 3,
          imageUrl: r.image_url,
          imageType: r.image_type,
          tier: r.tier as ContentTier,
          badge: TIER_BADGE[r.tier as ContentTier],
          subjectName: subject?.name ?? '',
          subTopicName: (subTopic as { name: string } | undefined)?.name ?? '',
          attribution: oi
            ? {
                text: (oi as { attribution_text: string }).attribution_text,
                license: (oi as { license: string }).license,
                originalUrl: (oi as { original_url: string }).original_url,
              }
            : undefined,
        });
      }
    }),
  );

  // 셔플 (사용자가 같은 sub_topic 만 연속으로 받지 않도록)
  for (let i = fetched.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [fetched[i], fetched[j]] = [fetched[j], fetched[i]];
  }

  return {
    questions: fetched.slice(0, count),
    rationale: {
      cohortUsed: input.cohortId ?? null,
      allocations,
      weakSubTopics: Array.from(weakMap.keys()),
      excludedCount: excludeIds.length,
    },
  };
}
