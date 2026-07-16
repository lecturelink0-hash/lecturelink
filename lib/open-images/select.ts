/**
 * 오픈 이미지 풀에서 문항 생성용 이미지 선택.
 *
 * 사용 패턴:
 *   1. sub_topic 키워드/이름으로 임베딩 → match_open_images RPC
 *   2. 매칭이 충분치 않으면 modality 기준으로 랜덤 샘플
 *   3. 이미 같은 sub_topic 에서 사용된 open_image 는 후순위
 */

import { createAdminClient } from '@/lib/db/admin';
import { embedText } from '@/lib/ai/embed';
import type { MedicalImageType } from '@/lib/types/database';

/**
 * 오픈 이미지 풀의 Supabase Storage 버킷.
 * 운영자가 사전에 생성 + admin 만 write 가능하도록 RLS 설정 필요.
 * storage_path 컬럼은 본 버킷 내 경로를 가리킨다.
 */
export const OPEN_IMAGES_BUCKET = 'open_images';

export interface SelectedOpenImage {
  id: string;
  modality: MedicalImageType;
  subTopicId: string | null;
  caption: string | null;
  /**
   * AI Vision 입력으로 사용할 실제 이미지 URL.
   * - storage_path 가 있으면 Supabase Storage public URL
   * - 없으면 original_url 을 direct image URL 로 가정 (manifest 보장 필요)
   */
  imageUrl: string;
  /**
   * 출처 페이지 URL — 라이선스 attribution 표시 전용. AI Vision 에 전달 금지.
   */
  originalUrl: string;
  attributionText: string;
  license: string;
  storagePath: string | null;
}

/**
 * open_images 행 → SelectedOpenImage 변환. AI 입력용 imageUrl 과 attribution 용
 * originalUrl 을 분리해서 호출자가 잘못 섞어 쓰지 않도록 한다.
 *
 * storage_path 가 있으면 Supabase Storage `open_images` 버킷의 public URL 을 imageUrl 로,
 * 없으면 original_url 을 direct image URL 로 간주.
 */
function toSelected(row: Record<string, unknown>): SelectedOpenImage {
  const storagePath = (row.storage_path as string | null) ?? null;
  const originalUrl = row.original_url as string;
  let imageUrl = originalUrl;
  if (storagePath) {
    const admin = createAdminClient();
    const { data } = admin.storage
      .from(OPEN_IMAGES_BUCKET)
      .getPublicUrl(storagePath);
    if (data?.publicUrl) {
      imageUrl = data.publicUrl;
    }
  }
  return {
    id: row.id as string,
    modality: row.modality as MedicalImageType,
    subTopicId: (row.sub_topic_id as string) ?? null,
    caption: (row.caption as string) ?? null,
    imageUrl,
    originalUrl,
    attributionText: row.attribution_text as string,
    license: row.license as string,
    storagePath,
  };
}

export interface SelectOptions {
  subTopicId?: string;
  modality?: MedicalImageType;
  query?: string; // 자연어 키워드 (없으면 modality 기반 랜덤)
  count?: number; // 기본 5
  excludeIds?: string[];
}

export async function selectOpenImages(
  options: SelectOptions,
): Promise<SelectedOpenImage[]> {
  const admin = createAdminClient();
  const count = options.count ?? 5;

  let candidates: SelectedOpenImage[] = [];

  // 1) 키워드 → 임베딩 매칭
  if (options.query) {
    const { embedding } = await embedText({
      text: options.query,
      inputType: 'query',
    });
    const { data, error } = await admin.rpc('match_open_images', {
      query_embedding: embedding,
      match_threshold: 0.7,
      match_count: count * 3,
      modality_filter: options.modality ?? null,
      sub_topic_filter: options.subTopicId ? [options.subTopicId] : null,
    });
    if (error) {
      console.error('[open-images] match RPC error:', error);
    } else {
      // RPC 는 storage_path 를 반환하지 않을 수 있으므로 후속 select 에서 보강.
      const matchIds = (data ?? []).map(
        (r: Record<string, unknown>) => r.id as string,
      );
      if (matchIds.length > 0) {
        const { data: full } = await admin
          .from('open_images')
          .select(
            'id, modality, sub_topic_id, caption, original_url, attribution_text, license, storage_path',
          )
          .in('id', matchIds);
        candidates = (full ?? []).map((r) =>
          toSelected(r as unknown as Record<string, unknown>),
        );
      }
    }
  }

  // 2) 부족하면 modality 기반 랜덤 (RPC 가 아닌 직접 select)
  if (candidates.length < count) {
    let q = admin
      .from('open_images')
      .select(
        'id, modality, sub_topic_id, caption, original_url, attribution_text, license, storage_path',
      )
      .eq('is_active', true);
    if (options.modality) q = q.eq('modality', options.modality);
    if (options.subTopicId) q = q.eq('sub_topic_id', options.subTopicId);
    if (options.excludeIds?.length) q = q.not('id', 'in', `(${options.excludeIds.join(',')})`);
    q = q.limit(count * 4);
    const { data, error } = await q;
    if (!error && data) {
      const seen = new Set(candidates.map((c) => c.id));
      for (const r of data) {
        if (seen.has(r.id)) continue;
        candidates.push(toSelected(r as unknown as Record<string, unknown>));
      }
    }
  }

  // 3) excludeIds 제외 + 셔플 + 자르기
  const excluded = new Set(options.excludeIds ?? []);
  const filtered = candidates.filter((c) => !excluded.has(c.id));
  for (let i = filtered.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [filtered[i], filtered[j]] = [filtered[j], filtered[i]];
  }
  return filtered.slice(0, count);
}
