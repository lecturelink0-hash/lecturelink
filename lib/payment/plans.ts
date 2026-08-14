/**
 * 플랜 표시 정보 단일 소스.
 *
 * 명칭·가격·설명은 요금제 페이지 기준으로 확정(2026-08 결정):
 * 무료 / 내신대비 7,900 / CPX 11,900 / 통합 16,900원.
 * 마이페이지·헤더·요금제 페이지·결제(PLAN_PRICES)가 모두 여기를 참조한다 —
 * 새 표기가 필요하면 이 파일만 수정할 것.
 */

import type { PlanTier } from '@/lib/types/database';

export interface PlanDisplay {
  name: string;
  price: number; // 월 결제액(KRW). 실제 청구액도 이 값에서 파생된다.
  desc: string;
}

export const PLAN_CATALOG: Record<PlanTier, PlanDisplay> = {
  free: { name: '무료', price: 0, desc: '기본 학습' },
  lite: { name: '내신대비', price: 7_900, desc: '강의자료로 시험 대비를 하고 싶은 학생' },
  standard: { name: 'CPX', price: 11_900, desc: '실전처럼 CPX를 반복 연습하고 싶은 학생' },
  pro: { name: '통합', price: 16_900, desc: '문제 풀이부터 CPX 실전 연습까지 한 번에' },
};

/** 티어 문자열이 카탈로그 밖 값(예: 'unlimited')이어도 안전하게 표시명을 얻는다. */
export function planName(tier: string): string {
  if (tier === 'unlimited') return PLAN_CATALOG.pro.name;
  return PLAN_CATALOG[tier as PlanTier]?.name ?? tier;
}
