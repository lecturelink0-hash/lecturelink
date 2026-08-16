/**
 * GET    /api/wrong-answers          — 오답노트 목록 (저장된 오답 + 문항 상세)
 * POST   /api/wrong-answers          — 오답노트에 저장 (체크한 문제만)
 * DELETE /api/wrong-answers?id=...    — 오답노트에서 제거
 *
 * question_id(공유 풀) 또는 private_question_id(내 강의노트) 중 하나로 식별.
 */

import { z } from 'zod';
import { requireAuthUser } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { STORAGE_BUCKET } from '@/lib/storage/paths';
import { ok, withErrorHandling, ApiException } from '@/lib/utils/api';
import { resolveQuestionBadgeShort } from '@/lib/content/tier-badge';

/** private_question_images 서명 URL 유효기간(초). /api/private-questions 와 동일. */
const SIGNED_URL_TTL_SECONDS = 3600;

interface QuestionImage {
  url: string;
  kind: string | null;
  caption: string | null;
}

export const GET = withErrorHandling(async () => {
  await requireAuthUser();
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('saved_wrong_questions')
    .select(
      `
      id, source, selected_index, resolved, created_at, sub_topic_id,
      question:questions (
        id, stem, choices, answer_index, explanation, difficulty,
        image_url, image_type, tier, reviewed_by
      ),
      private_question:private_questions (
        id, stem, choices, answer_index, explanation, difficulty,
        images:private_question_images ( storage_path, kind, caption, sort_order )
      ),
      sub_topic:sub_topics (
        id, name, subject:subjects ( id, name )
      )
    `,
    )
    .order('created_at', { ascending: false });

  if (error) throw error;

  const rows = (data ?? []) as Record<string, any>[];

  // 내 자료 기반(private) 문항의 이미지는 private 버킷에 있어 서명 URL 이 필요하다.
  // 행마다 따로 서명하면 왕복이 문항 수만큼 늘어나므로 전체 경로를 모아 한 번에 서명한다.
  const imagePaths = Array.from(
    new Set(
      rows.flatMap((r) =>
        ((r.private_question?.images ?? []) as { storage_path: string }[])
          .map((im) => im.storage_path)
          .filter(Boolean),
      ),
    ),
  );

  const signedByPath = new Map<string, string>();
  if (imagePaths.length > 0) {
    const { data: signed } = await supabase.storage
      .from(STORAGE_BUCKET)
      .createSignedUrls(imagePaths, SIGNED_URL_TTL_SECONDS);
    for (const s of signed ?? []) {
      if (s.signedUrl && s.path) signedByPath.set(s.path, s.signedUrl);
    }
  }

  const items = rows.map((r) => {
    const q = r.question ?? r.private_question;
    const isPrivate = !r.question && !!r.private_question;
    const st = r.sub_topic;
    const subject = st?.subject;

    // 공유 풀은 questions.image_url(공개 URL) 한 장, private 은 연결된 이미지 전부.
    const images: QuestionImage[] = isPrivate
      ? [...((q?.images ?? []) as { storage_path: string; kind: string | null; caption: string | null; sort_order: number }[])]
          .sort((a, b) => a.sort_order - b.sort_order)
          .map((im) => ({
            url: signedByPath.get(im.storage_path) ?? '',
            kind: im.kind,
            caption: im.caption,
          }))
          .filter((im) => im.url !== '')
      : q?.image_url
        ? [{ url: q.image_url as string, kind: (q.image_type as string | null) ?? null, caption: null }]
        : [];

    return {
      id: r.id,
      savedAt: r.created_at,
      source: r.source,
      resolved: r.resolved,
      selectedIndex: r.selected_index,
      isPrivate,
      question: q
        ? {
            id: q.id,
            stem: q.stem,
            choices: q.choices,
            answerIndex: q.answer_index,
            explanation: q.explanation,
            difficulty: q.difficulty,
            images,
            // imageUrl/imageType 은 기존 소비자 호환용(대표 이미지 1장).
            imageUrl: images[0]?.url ?? null,
            imageType: q.image_type ?? images[0]?.kind ?? null,
            tier: q.tier ?? 'community',
            badge: resolveQuestionBadgeShort({ tier: q.tier, reviewedBy: q.reviewed_by }),
          }
        : null,
      subjectName: subject?.name ?? (isPrivate ? '내 강의 노트' : '기타'),
      subTopicName: st?.name ?? '미분류',
      subTopicId: r.sub_topic_id,
    };
  });

  return ok(items);
});

const saveSchema = z
  .object({
    question_id: z.string().uuid().nullable().optional(),
    private_question_id: z.string().uuid().nullable().optional(),
    sub_topic_id: z.string().uuid().nullable().optional(),
    selected_index: z.number().int().min(0).max(4).nullable().optional(),
    source: z.enum(['exam', 'mock', 'practice', 'lecture_note']).default('exam'),
  })
  .refine((v) => v.question_id || v.private_question_id, {
    message: 'question_id 또는 private_question_id 가 필요합니다.',
  });

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireAuthUser();
  const body = saveSchema.parse(await request.json());
  const supabase = await createServerClient();

  const { data, error } = await supabase
    .from('saved_wrong_questions')
    .upsert(
      {
        user_id: session.userId,
        question_id: body.question_id ?? null,
        private_question_id: body.private_question_id ?? null,
        sub_topic_id: body.sub_topic_id ?? null,
        selected_index: body.selected_index ?? null,
        source: body.source,
        resolved: false,
      },
      { onConflict: body.private_question_id ? 'user_id,private_question_id' : 'user_id,question_id' },
    )
    .select('id')
    .single();

  if (error) throw error;
  return ok({ id: data.id, saved: true }, 201);
});

export const DELETE = withErrorHandling(async (request: Request) => {
  const session = await requireAuthUser();
  const { searchParams } = new URL(request.url);
  const id = searchParams.get('id');
  const questionId = searchParams.get('question_id');
  if (!id && !questionId) {
    throw new ApiException('bad_request', 'id 또는 question_id 가 필요합니다.', 400);
  }
  const supabase = await createServerClient();

  let q = supabase.from('saved_wrong_questions').delete().eq('user_id', session.userId);
  if (id) q = q.eq('id', id);
  else if (questionId) q = q.eq('question_id', questionId);

  const { error } = await q;
  if (error) throw error;
  return ok({ deleted: true });
});
