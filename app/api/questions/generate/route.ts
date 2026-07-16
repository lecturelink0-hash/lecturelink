/**
 * POST /api/questions/generate
 *
 * 문항 풀에 새 문항을 생성·추가하는 admin 엔드포인트.
 *
 * 호출 흐름:
 *   1. 요청 검증 (sub_topic_id 등 유효성)
 *   2. sub_topic 정보 조회 (subject 이름·위험 영역 여부 등)
 *   3. admitGeneratedQuestions 파이프라인 실행
 *   4. 결과 반환 (admission 통계 + 비용)
 *
 * 권한:
 *   - `requireAdmin()` 단일 가드. admin role(`users.role = 'admin'`) 만 통과.
 *   - 실패 시 401/403 — 일반 인증 사용자도 호출 불가.
 *
 * 사용량 제한:
 *   - 일일 최대 비용: env MAX_DAILY_AI_COST_USD
 *   - 단일 요청 최대 문항: env MAX_QUESTIONS_PER_REQUEST
 */

import { z } from 'zod';
import { requireAdmin } from '@/lib/auth/session';
import { createAdminClient } from '@/lib/db/admin';
import { admitGeneratedQuestions } from '@/lib/ai/admission';
import { requireDailyCostCap } from '@/lib/ai/cost-cap';
import { requireQuota, consumeQuota } from '@/lib/quota/check';
import { validateImageUrl } from '@/lib/storage/url-safety';
import { selectOpenImages } from '@/lib/open-images/select';
import {
  ok,
  withErrorHandling,
  ApiException,
} from '@/lib/utils/api';
import type {
  ContentSource,
  MedicalImageType,
} from '@/lib/types/database';

const bodySchema = z.object({
  sub_topic_id: z.string().uuid(),
  count: z.number().int().min(1).max(20),
  difficulty: z.number().int().min(1).max(3).default(2),
  style: z.enum(['kmle', 'professor', 'internal']).default('kmle'),
  source: z
    .enum(['team_seed', 'ai_generated', 'ai_user_triggered', 'kmle_style_seed'])
    .default('ai_generated'),
  image_context: z
    .object({
      image_url: z.string().url(),
      image_type: z.enum([
        'xray',
        'ct',
        'mri',
        'ecg',
        'pathology',
        'microscope',
        'ultrasound',
        'other',
      ]),
    })
    .optional(),
  image_source: z.enum(['none', 'user', 'open_library']).default('none'),
  open_image_query: z.string().optional(),
  open_image_modality: z
    .enum(['xray', 'ct', 'mri', 'ecg', 'pathology', 'microscope', 'ultrasound', 'other'])
    .optional(),
  save_to_db: z.boolean().default(true),
});

export const POST = withErrorHandling(async (request: Request) => {
  const session = await requireAdmin();
  const body = bodySchema.parse(await request.json());

  // 단일 요청 최대 문항 제한
  const maxPerRequest = parseInt(
    process.env.MAX_QUESTIONS_PER_REQUEST ?? '50',
    10,
  );
  if (body.count > maxPerRequest) {
    throw new ApiException(
      'count_exceeded',
      `한 번에 최대 ${maxPerRequest}개까지 생성 가능합니다.`,
      400,
    );
  }

  // P0-3: 일일 AI 비용 캡 사전 체크
  await requireDailyCostCap();

  // P0-4: image_url SSRF 차단 (user 모드만)
  if (body.image_source === 'user' && body.image_context?.image_url) {
    await validateImageUrl(body.image_context.image_url);
  }

  // P0-6: quota 사전 체크 (문항 + 이미지 별도)
  await requireQuota(session.userId, 'questions', body.count);
  const usesImage =
    body.image_source === 'user' && !!body.image_context;
  const usesOpenLibrary = body.image_source === 'open_library';
  if (usesImage || usesOpenLibrary) {
    await requireQuota(session.userId, 'images', body.count);
  }

  // sub_topic 조회
  const admin = createAdminClient();
  const { data: subTopic, error: stError } = await admin
    .from('sub_topics')
    .select(
      `
      id,
      code,
      name,
      exam_relevance,
      is_risk_category,
      subject:subjects (
        id,
        name
      )
    `,
    )
    .eq('id', body.sub_topic_id)
    .maybeSingle();

  if (stError || !subTopic) {
    throw new ApiException('sub_topic_not_found', 'Sub-topic 을 찾을 수 없습니다.', 404);
  }

  const subject = Array.isArray(subTopic.subject)
    ? subTopic.subject[0]
    : subTopic.subject;

  if (!subject) {
    throw new ApiException('subject_not_found', '연결된 과목이 없습니다.', 404);
  }

  // image_source 별 분기
  type ImageCtx = {
    imageUrl: string;
    imageType: MedicalImageType;
    openImageId?: string;
    attribution?: string;
  };
  let imageContext: ImageCtx | undefined;
  const openImagesUsed: string[] = [];

  if (body.image_source === 'user' && body.image_context) {
    imageContext = {
      imageUrl: body.image_context.image_url,
      imageType: body.image_context.image_type as MedicalImageType,
    };
  } else if (body.image_source === 'open_library') {
    const picked = await selectOpenImages({
      subTopicId: subTopic.id,
      modality: body.open_image_modality as MedicalImageType | undefined,
      query: body.open_image_query ?? subTopic.name,
      count: 1,
    });
    if (picked.length === 0) {
      throw new ApiException(
        'open_image_not_found',
        'open_library 에서 조건에 맞는 이미지를 찾지 못했습니다.',
        404,
      );
    }
    const oi = picked[0];
    // Vision 입력은 imageUrl (storage_path 의 Supabase public URL 또는 direct image URL).
    // originalUrl 은 attribution 표시 전용이므로 Vision 에 절대 넘기지 않는다.
    // open_library 의 imageUrl 은 신뢰 도메인 — allowOpenImageHosts=true 로 검증.
    await validateImageUrl(oi.imageUrl, { allowOpenImageHosts: true });
    imageContext = {
      imageUrl: oi.imageUrl,
      imageType: oi.modality,
      openImageId: oi.id,
      attribution: oi.attributionText,
    };
    openImagesUsed.push(oi.id);
  }

  // 파이프라인 실행
  const result = await admitGeneratedQuestions({
    subjectId: (subject as { id: string }).id,
    subjectName: (subject as { name: string }).name,
    subTopicId: subTopic.id,
    subTopicName: subTopic.name,
    examRelevance: subTopic.exam_relevance as 1 | 2 | 3,
    isRiskCategory: subTopic.is_risk_category,
    difficulty: body.difficulty as 1 | 2 | 3,
    count: body.count,
    style: body.style,
    source: body.source as ContentSource,
    imageContext,
    createdBy: session.userId,
    saveToDb: body.save_to_db,
  });

  // open_library 사용 시 admitted 문항에 open_image_id 매핑
  if (openImagesUsed.length > 0 && result.admitted.length > 0 && body.save_to_db) {
    const dbIds = result.admitted.map((a) => a.dbId).filter(Boolean) as string[];
    if (dbIds.length > 0) {
      await admin
        .from('questions')
        .update({ open_image_id: openImagesUsed[0] })
        .in('id', dbIds);
    }
  }

  // 성공 후 quota 차감 (admit 된 문항 수 기준)
  //
  // 정책: "post-success admitted count" — 생성/검증/저장이 성공한 admit 수만큼만 차감.
  // 이 라우트는 atomic check+consume 으로 전환하지 않고 기존 consumeQuota 를 유지한다.
  // 이유:
  //   1) admit 수는 AI 생성+검증 후에 정해지므로 사전 reserve 모델로 바꾸려면 admitted<count
  //      만큼 refund 가 필요한데, 현재 refund RPC 가 없고 admission 부분 롤백은 비용이 큼.
  //   2) 만약 atomic 차감을 도입해 한도 초과로 차감이 실패해도, admitted 문항은 이미 DB 에
  //      들어가 있어 quota_exceeded 401 응답이 사용자에게 일관되지 않게 보임.
  // 결과적으로 동시 요청이 사전 requireQuota 를 동시에 통과한 뒤 admitted 가 한도를 살짝
  // 넘기는 race overage 는 운영 알림으로 감지하는 best-effort 정책을 유지한다.
  //
  // 1 회 1 단위가 확정되는 업로드 큐 같은 경로에서는 consumeQuotaCheckedStrict 를 사용해
  // race 를 원천 차단한다 (lib/queue/process-upload.ts).
  const admittedCount = result.admitted.length;
  if (admittedCount > 0) {
    await consumeQuota(session.userId, 'questions', admittedCount);
    if (usesImage || usesOpenLibrary) {
      await consumeQuota(session.userId, 'images', admittedCount);
    }
  }

  return ok(result);
});
