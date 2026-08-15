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

/** questions 조회 공통 select — open_image / sub_topic / subject 를 함께 가져온다. */
const QUESTION_SELECT = `
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
`;

type QuestionRow = Record<string, unknown>;

function toQuestionForUser(r: QuestionRow): QuestionForUser {
  const subTopicRaw = (r as { sub_topics: unknown }).sub_topics;
  const subTopic = (Array.isArray(subTopicRaw) ? subTopicRaw[0] : subTopicRaw) as
    | { name: string; subjects: { name: string } | { name: string }[] }
    | undefined;
  const subjectRaw = subTopic?.subjects;
  const subject = (Array.isArray(subjectRaw) ? subjectRaw[0] : subjectRaw) as
    | { name: string }
    | undefined;

  const oiRaw = (r as { open_image: unknown }).open_image;
  const oi = (Array.isArray(oiRaw) ? oiRaw[0] : oiRaw) as
    | { attribution_text: string; license: string; original_url: string }
    | null
    | undefined;

  const tier = r.tier as ContentTier;
  return {
    id: r.id as string,
    stem: r.stem as string,
    choices: r.choices as string[],
    concepts: (r.concepts as string[] | null) ?? [],
    difficulty: r.difficulty as 1 | 2 | 3,
    imageUrl: (r.image_url as string | null) ?? null,
    imageType: (r.image_type as QuestionForUser['imageType']) ?? null,
    tier,
    badge: TIER_BADGE[tier],
    subjectName: subject?.name ?? '',
    subTopicName: subTopic?.name ?? '',
    attribution: oi
      ? { text: oi.attribution_text, license: oi.license, originalUrl: oi.original_url }
      : undefined,
  };
}

export interface RecommendInput {
  userId: string;
  cohortId?: string;
  subjectId?: string;
  /**
   * 약점 세부주제 집중 코스. 지정하면 코호트/밴딧 분배를 건너뛰고
   * 이 sub_topic 문항만 뽑는다. (약점·오답 분석의 "집중 코스" 진입 경로)
   */
  subTopicId?: string;
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
    /** 집중 코스로 요청된 sub_topic (없으면 null) */
    focusSubTopicId: string | null;
    /** 집중 코스 sub_topic 이름 — 문항이 0개여도 화면에 주제를 표시하기 위함 */
    focusSubTopicName: string | null;
    /** 집중 코스 sub_topic 이 속한 과목 이름 */
    focusSubjectName: string | null;
    /**
     * 집중 코스에서 해당 sub_topic 의 공개 문제 풀이 비어 있는지 여부.
     * true 면 클라이언트가 '내 문제집 기반 사전 생성' 경로로 안내한다.
     */
    focusPoolEmpty: boolean;
  };
}

export async function recommendQuestions(
  input: RecommendInput,
): Promise<RecommendResult> {
  const supabase = await createServerClient();
  const admin = createAdminClient();
  const count = input.count ?? 10;
  const excludeAnswered = input.excludeAnswered ?? true;

  // ───── 0. 약점 집중 코스 — sub_topic 이 지정되면 그 주제만 뽑는다 ─────
  // 코호트 점수는 과목 전체에 걸쳐 있어서 밴딧을 태우면 엉뚱한 과목 문항이 섞인다.
  // "대동맥박리 집중 코스"에서 내분비 문항이 나오던 원인이 이것.
  if (input.subTopicId) {
    return focusedRecommend(admin, input.userId, input.subTopicId, count, excludeAnswered);
  }

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

    // 과목이 함께 지정되면 그 과목의 sub_topic 으로 좁힌다.
    // (코호트 점수는 수강 과목 전반을 담고 있어 과목 필터 없이는 다른 과목이 섞인다)
    if (input.subjectId && cohortScores.length > 0) {
      const { data: subjectTopics } = await admin
        .from('sub_topics')
        .select('id')
        .eq('subject_id', input.subjectId);
      const allowed = new Set((subjectTopics ?? []).map((st) => st.id));
      cohortScores = cohortScores.filter((s) => allowed.has(s.subTopicId));
    }
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
        focusSubTopicId: null,
        focusSubTopicName: null,
        focusSubjectName: null,
        focusPoolEmpty: false,
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
        .select(QUESTION_SELECT)
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
        fetched.push(toQuestionForUser(r as QuestionRow));
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
      focusSubTopicId: null,
      focusSubTopicName: null,
      focusSubjectName: null,
      focusPoolEmpty: false,
    },
  };
}

/**
 * 약점 세부주제 집중 코스.
 *
 * 지정된 sub_topic 의 공개 문항만 뽑는다. 안 푼 문항을 먼저 채우되,
 * 모자라면 이미 푼 문항으로 채운다 — 약점 보완 코스는 "틀렸던 문제 다시 풀기"가
 * 오히려 정상 동작이고, 여기서 빈 화면을 주면 코스 자체가 죽는다.
 *
 * 풀에 문항이 아예 없으면 focusPoolEmpty=true 로 알려서
 * 클라이언트가 '내 문제집 기반 사전 생성' 경로를 안내하게 한다.
 */
async function focusedRecommend(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  subTopicId: string,
  count: number,
  excludeAnswered: boolean,
): Promise<RecommendResult> {
  const [{ data: rows }, { data: attempts }, { data: topic }] = await Promise.all([
    admin
      .from('questions')
      .select(QUESTION_SELECT)
      .eq('sub_topic_id', subTopicId)
      .eq('status', 'active')
      .limit(Math.max(count * 3, 30)),
    excludeAnswered
      ? admin
          .from('user_attempts')
          .select('question_id')
          .eq('user_id', userId)
          .not('question_id', 'is', null)
          .order('created_at', { ascending: false })
          .limit(500)
      : Promise.resolve({ data: [] as { question_id: string | null }[] }),
    admin
      .from('sub_topics')
      .select('name, subject:subjects(name)')
      .eq('id', subTopicId)
      .maybeSingle(),
  ]);

  const topicSubjectRaw = topic?.subject;
  const topicSubject = (Array.isArray(topicSubjectRaw) ? topicSubjectRaw[0] : topicSubjectRaw) as
    | { name: string }
    | undefined;

  const answered = new Set(
    (attempts ?? []).map((a) => a.question_id).filter((id): id is string => id !== null),
  );

  const all = (rows ?? []) as QuestionRow[];
  // 안 푼 문항 먼저 → 그 다음 tier(curated > community > beta) 순
  const sorted = [...all].sort((a, b) => {
    const aNew = answered.has(a.id as string) ? 1 : 0;
    const bNew = answered.has(b.id as string) ? 1 : 0;
    if (aNew !== bNew) return aNew - bNew;
    return (
      (TIER_PRIORITY[b.tier as ContentTier] ?? 0) - (TIER_PRIORITY[a.tier as ContentTier] ?? 0)
    );
  });

  return {
    questions: sorted.slice(0, count).map(toQuestionForUser),
    rationale: {
      cohortUsed: null,
      allocations: [{ subTopicId, count: Math.min(count, sorted.length), bucket: 'exploitation' }],
      weakSubTopics: [subTopicId],
      excludedCount: answered.size,
      focusSubTopicId: subTopicId,
      focusSubTopicName: topic?.name ?? null,
      focusSubjectName: topicSubject?.name ?? null,
      focusPoolEmpty: all.length === 0,
    },
  };
}
