/**
 * 문항 카드 신뢰 배지 — 단일 출처
 *
 * 배지는 **DB에 근거가 남아 있는 사실만** 말한다.
 *
 * 왜 이 파일이 생겼는가(2026-08-16 실측):
 *   운영 DB의 tier='curated' 문항 160건은 전부 reviewed_by 가 NULL 이었다.
 *   그런데도 화면에는 "✓ 의사 검수 완료"가 찍히고 있었다. 150건은 2026-08-04
 *   하루에 일괄 삽입됐고 created_by 도 NULL 이며, reviewed_at 은 created_at 과
 *   초 단위까지 같았다 — 삽입 시각을 그대로 복사한 값이지 검수 시각이 아니다.
 *   즉 "의사가 검수했다"는 주장을 뒷받침하는 기록이 한 건도 없었다.
 *
 *   tier 는 운영자가 아무 근거 없이 바꿀 수 있는 라벨이라 그것만으로 검수를
 *   주장하면 안 된다. 그래서 검수 주장은 **검수자(reviewed_by)가 실제로 기록된
 *   문항에만** 붙인다. 검수를 마쳤는데 배지가 안 나온다면, 그건 배지가 아니라
 *   questions.reviewed_by / reviewed_at 을 채워야 한다는 뜻이다.
 *
 * 배지 문구와 근거:
 *   ✓ 의사 검수 완료  — reviewed_by 가 기록됨. 검수자를 특정할 수 있다.
 *   ⚠ 베타           — tier='beta'. 검증에서 지적이 남아 사람 검수 대기 중.
 *   AI 생성 · 검수 전  — 그 외. AI 파이프라인 산출물이고 의사 검수 기록은 없다.
 */

import type { ContentTier } from '@/lib/types/database';

export type BadgeColor = 'curated' | 'community' | 'beta';

export interface QuestionBadge {
  label: string;
  color: BadgeColor;
}

export interface BadgeEvidence {
  tier: ContentTier | string | null | undefined;
  /** questions.reviewed_by — 검수자 user id. 이것이 있어야만 검수를 주장한다. */
  reviewedBy?: string | null;
}

/** 검수 주장을 뒷받침하는 기록이 있는지. */
export function hasReviewEvidence(evidence: BadgeEvidence): boolean {
  return typeof evidence.reviewedBy === 'string' && evidence.reviewedBy.length > 0;
}

/**
 * 문항 하나의 배지를 판정한다.
 *
 * reviewed_by 를 select 하지 않은 호출부는 undefined 를 넘기게 되는데, 그때는
 * "모른다"이지 "검수됐다"가 아니므로 검수 주장을 하지 않는다. 조용히 과장하는
 * 쪽으로 기울지 않도록 기본값을 이렇게 잡았다.
 */
export function resolveQuestionBadge(evidence: BadgeEvidence): QuestionBadge {
  if (hasReviewEvidence(evidence)) {
    return { label: '✓ 의사 검수 완료', color: 'curated' };
  }
  if (evidence.tier === 'beta') {
    return { label: '⚠ 베타', color: 'beta' };
  }
  return { label: 'AI 생성 · 검수 전', color: 'community' };
}

/** 목록 화면의 풀 통계 등에서 쓰는 짧은 형태. */
export function resolveQuestionBadgeShort(evidence: BadgeEvidence): QuestionBadge {
  const full = resolveQuestionBadge(evidence);
  if (full.color === 'curated') return { label: '의사 검수', color: 'curated' };
  if (full.color === 'beta') return { label: '베타', color: 'beta' };
  return { label: 'AI 생성', color: 'community' };
}
