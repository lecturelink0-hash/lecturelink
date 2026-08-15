/**
 * 약점 주제의 오답 수집
 *
 * 오답 사유를 판정하려면 "틀렸다"가 아니라 **무엇을 골라서 틀렸는가**가 필요하다.
 * user_attempts.selected_index 가 그 정보를 갖고 있으므로, 문항 본문과 다시 이어
 * 붙여 lib/ai/error-analysis.ts 에 넘길 형태로 만든다.
 *
 * 공개 풀 문항(question_id)과 내 문제집 문항(private_question_id) 양쪽을 본다.
 * 00018 마이그레이션 이후 두 종류가 같은 테이블에 섞여 있고, 학생 입장에서는
 * 어느 쪽을 틀렸든 똑같은 약점이다.
 *
 * 같은 세부주제 오답을 먼저 채우고, 모자라면 같은 과목으로 넓힌다. 세부주제 하나에
 * 문항이 한두 개뿐일 때 — 애초에 이 코스가 문제가 됐던 상황 — 표본이 0건이 되는 것을
 * 막기 위함이다.
 */

import type { createAdminClient } from '@/lib/db/admin';
import type { WrongAttemptItem } from '@/lib/ai/prompts/error-analysis';

/** 최근 오답을 몇 건까지 훑을지. 오래된 오답은 현재 실력을 대변하지 못한다. */
const ATTEMPT_SCAN_LIMIT = 200;

interface QuestionBody {
  stem: string;
  choices: string[];
  answer_index: number;
  explanation: string | null;
  sub_topic_id: string | null;
}

export interface CollectedWrongAttempts {
  items: WrongAttemptItem[];
  /** 같은 세부주제에서 나온 오답 수. 나머지는 같은 과목에서 온 것. */
  fromSubTopic: number;
}

export async function collectWrongAttempts(
  admin: ReturnType<typeof createAdminClient>,
  params: {
    userId: string;
    subTopicId: string;
    /** 같은 과목의 세부주제 id 목록(subTopicId 포함). 넓힘 범위를 정한다. */
    siblingSubTopicIds: string[];
    limit: number;
  },
): Promise<CollectedWrongAttempts> {
  const { data: attempts } = await admin
    .from('user_attempts')
    .select('question_id, private_question_id, selected_index, time_spent_seconds, created_at')
    .eq('user_id', params.userId)
    .eq('is_correct', false)
    .order('created_at', { ascending: false })
    .limit(ATTEMPT_SCAN_LIMIT);

  const rows = attempts ?? [];
  if (rows.length === 0) return { items: [], fromSubTopic: 0 };

  const publicIds = [...new Set(rows.map((a) => a.question_id).filter((id): id is string => !!id))];
  const privateIds = [
    ...new Set(rows.map((a) => a.private_question_id).filter((id): id is string => !!id)),
  ];

  const scope = new Set(params.siblingSubTopicIds);
  const bodies = new Map<string, QuestionBody>();

  const [pub, priv] = await Promise.all([
    publicIds.length > 0
      ? admin
          .from('questions')
          .select('id, stem, choices, answer_index, explanation, sub_topic_id')
          .in('id', publicIds)
      : Promise.resolve({ data: [] as Array<QuestionBody & { id: string }> }),
    privateIds.length > 0
      ? admin
          .from('private_questions')
          .select('id, stem, choices, answer_index, explanation, sub_topic_id')
          .in('id', privateIds)
      : Promise.resolve({ data: [] as Array<QuestionBody & { id: string }> }),
  ]);

  for (const row of [...(pub.data ?? []), ...(priv.data ?? [])] as Array<
    QuestionBody & { id: string }
  >) {
    if (!row.sub_topic_id || !scope.has(row.sub_topic_id)) continue;
    bodies.set(row.id, row);
  }

  // 같은 세부주제 → 같은 과목 순으로 채운다. 최근 순서는 위 쿼리에서 이미 잡혀 있다.
  const sameTopic: WrongAttemptItem[] = [];
  const sameSubject: WrongAttemptItem[] = [];

  for (const attempt of rows) {
    const id = attempt.question_id ?? attempt.private_question_id;
    if (!id) continue;
    const body = bodies.get(id);
    if (!body) continue;
    if (!Array.isArray(body.choices) || body.choices.length < 2) continue;

    const item: WrongAttemptItem = {
      stem: body.stem,
      choices: body.choices as string[],
      answerIndex: body.answer_index,
      selectedIndex: attempt.selected_index,
      explanation: body.explanation,
      timeSpentSeconds: attempt.time_spent_seconds,
    };
    (body.sub_topic_id === params.subTopicId ? sameTopic : sameSubject).push(item);
  }

  const items = [...sameTopic, ...sameSubject].slice(0, params.limit);
  return { items, fromSubTopic: Math.min(items.length, sameTopic.length) };
}
