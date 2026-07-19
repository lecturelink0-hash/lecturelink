/**
 * GET /api/private-questions
 *
 * 본인 Private 풀(Track A 생성 문항) 조회.
 *
 * Query:
 *   upload_id?    : 특정 업로드의 문항만
 *   sub_topic_id? : sub_topic 필터
 *   limit?        : 최대 100 (기본 30)
 *   offset?
 */

import { z } from 'zod';
import { requireSession } from '@/lib/auth/session';
import { createServerClient } from '@/lib/db/server';
import { STORAGE_BUCKET } from '@/lib/storage/paths';
import { ok, withErrorHandling } from '@/lib/utils/api';

const querySchema = z.object({
  upload_id: z.string().uuid().optional(),
  sub_topic_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).default(0),
  mode: z.enum(['review', 'quiz']).default('review'),
});

export const GET = withErrorHandling(async (request: Request) => {
  const session = await requireSession();
  const { searchParams } = new URL(request.url);
  const params = querySchema.parse(Object.fromEntries(searchParams));

  const supabase = await createServerClient();

  let query = supabase
    .from('private_questions')
    .select(
      `
      id, stem, choices, answer_index, explanation, concepts, difficulty, sub_topic_id,
      upload_id, created_at,
      images:private_question_images ( storage_path, kind, caption, sort_order ),
      sub_topic:sub_topics ( name, subject:subjects ( name ) ),
      upload:user_uploads ( file_name )
    `,
      { count: 'exact' },
    )
    .eq('user_id', session.userId)
    .order('created_at', { ascending: false })
    .range(params.offset, params.offset + params.limit - 1);

  if (params.upload_id) {
    query = query.eq('upload_id', params.upload_id);
  }
  if (params.sub_topic_id) {
    query = query.eq('sub_topic_id', params.sub_topic_id);
  }

  const { data, count, error } = await query;
  if (error) throw error;

  // 정규화
  type Row = {
    id: string;
    stem: string;
    choices: string[];
    answer_index: number;
    explanation: string | null;
    concepts: string[];
    difficulty: number;
    sub_topic_id: string | null;
    upload_id: string;
    created_at: string;
    images:
      | {
          storage_path: string;
          kind: string | null;
          caption: string | null;
          sort_order: number;
        }[]
      | null;
    sub_topic:
      | { name: string; subject: { name: string } | { name: string }[] | null }
      | { name: string; subject: { name: string } | { name: string }[] | null }[]
      | null;
    upload: { file_name: string } | { file_name: string }[] | null;
  };

  const items = await Promise.all(
    (data ?? []).map(async (r) => {
      const row = r as Row;
      const st = Array.isArray(row.sub_topic)
        ? row.sub_topic[0]
        : row.sub_topic;
      const subjRaw = st ? st.subject : null;
      const subj = Array.isArray(subjRaw) ? subjRaw[0] : subjRaw;
      const up = Array.isArray(row.upload) ? row.upload[0] : row.upload;

      // 연결된 의료 이미지들 — 각각 1시간 유효 signed URL 생성 (user_uploads 는 private 버킷).
      const rawImages = Array.isArray(row.images) ? [...row.images] : [];
      rawImages.sort((a, b) => a.sort_order - b.sort_order);
      const images = (
        await Promise.all(
          rawImages.map(async (im) => {
            const { data: signed } = await supabase.storage
              .from(STORAGE_BUCKET)
              .createSignedUrl(im.storage_path, 3600);
            if (!signed?.signedUrl) return null;
            return {
              url: signed.signedUrl,
              kind: im.kind,
              caption: im.caption,
            };
          }),
        )
      ).filter((i): i is NonNullable<typeof i> => i !== null);

      return {
        id: row.id,
        stem: row.stem,
        choices: row.choices,
        ...(params.mode === 'review'
          ? { answer_index: row.answer_index, explanation: row.explanation }
          : {}),
        concepts: row.concepts,
        difficulty: row.difficulty,
        sub_topic_id: row.sub_topic_id,
        sub_topic_name: st?.name ?? null,
        subject_name: subj?.name ?? null,
        images,
        upload_id: row.upload_id,
        upload_file_name: up?.file_name ?? null,
        created_at: row.created_at,
      };
    }),
  );

  return ok({
    items,
    total: count ?? 0,
    limit: params.limit,
    offset: params.offset,
  });
});
