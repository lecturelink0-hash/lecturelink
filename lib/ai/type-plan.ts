/**
 * 문항 유형 배분 계획 — 순수 함수만 둔다 (figure-stem.ts·blind-policy.ts 와 같은 잎 모듈 규칙,
 * import 없음). 회귀 검사 `npm run check:type-plan` 이 이 파일만 불러온다.
 *
 * 왜 필요한가 (2026-08-27 실측, 업로드 effbfdf0 — 지식형·이미지형 10문항 요청)
 * ──────────────────────────────────────────────────────────────────────
 * 결과가 지식형 8 : 이미지형 2 였다. 두 유형을 골랐으면 5:5 여야 한다.
 *
 * 종전 배분은 **전역 목표가 없고 배치별 "최소 1"만** 있었다.
 *   · 5묶음(2문항씩) 중 앞 2묶음은 텍스트 선발사라 이미지를 받을 수 없다 → 지식형 4.
 *   · 이미지 묶음 3개는 각각 imageQuota = round(2/유형수 2) = 1, knowledgeQuota = 1
 *     → 이미지 최대 3 · 지식형 3.
 *   · 합계: 이미지형은 설계상 **최대 3/10**. 실제로는 그중 1개가 후처리(모달리티 불일치)로
 *     연결이 끊겨 2/10 이 됐다.
 * 즉 "유형 수로 나눈 몫"을 묶음 예약에서 한 번, 묶음 안 쿼터에서 또 한 번 적용해
 * 이미지형 몫이 두 번 깎였고, 어느 코드도 전체 합을 세지 않았다.
 *
 * 이제 **전역 목표를 먼저 정하고**(5:5, 4:3:3 …) 그 합이 정확히 맞도록 묶음별 쿼터를 나눈다.
 * 묶음 쿼터의 합 = 전역 목표, 전역 목표의 합 = 요청 문항 수.
 */

export type PlanType = '지식형' | '임상형' | '이미지형';

export const PLAN_TYPES: readonly PlanType[] = ['지식형', '임상형', '이미지형'] as const;

/** 전역 유형 목표. `free` 는 유형 제약 없이 채우는 슬롯(이미지형 단독인데 공급이 모자랄 때). */
export interface TypeTargets {
  knowledge: number;
  clinical: number;
  image: number;
  free: number;
}

/** 묶음 하나의 유형 쿼터 — 합이 묶음 크기와 같다(free 포함). */
export interface BatchQuota {
  image: number;
  knowledge: number;
  clinical: number;
  free: number;
}

/**
 * 나머지 배분 우선순위.
 *
 * 10문항을 3유형으로 나누면 3·3·3 에 1이 남는다. 사용자 예시("3:4:3")처럼 가운데 유형이
 * 4가 되게 임상형에 먼저 준다. 이미지형은 공급(정제에 성공한 그림 수)에 묶여 있어 마지막이다 —
 * 남는 1을 이미지형에 줬다가 공급이 모자라면 또 옮겨야 한다.
 */
const REMAINDER_PRIORITY: readonly PlanType[] = ['임상형', '지식형', '이미지형'];

const KEY: Record<PlanType, keyof Omit<TypeTargets, 'free'>> = {
  '지식형': 'knowledge',
  '임상형': 'clinical',
  '이미지형': 'image',
};

/** 선택 목록을 정규화한다(알 수 없는 값·중복 제거, 고정 순서). */
export function normalizeSelectedTypes(selected: readonly string[] | undefined): PlanType[] {
  const set = new Set((selected ?? []).filter((t): t is PlanType => PLAN_TYPES.includes(t as PlanType)));
  return PLAN_TYPES.filter((t) => set.has(t));
}

/**
 * 전역 유형 목표.
 *
 *  - 선택한 유형에 **거의 같은 수**를 준다: 10문항 2유형 → 5:5, 3유형 → 3:4:3(임상형이 4).
 *  - 이미지형 목표는 공급 상한(`imageSupplyCap`, 정제 성공 장수 × 장당 문항 수)을 넘지 않는다.
 *    넘치는 몫은 다른 선택 유형으로 옮기고, 옮길 유형이 없으면(이미지형 단독) `free` 로 남긴다.
 *  - 아무 유형도 고르지 않았으면 전부 free(제약 없음).
 */
export function planTypeTargets(
  desiredCount: number,
  selected: readonly string[] | undefined,
  imageSupplyCap: number = Number.POSITIVE_INFINITY,
): TypeTargets {
  const n = Math.max(0, Math.floor(desiredCount));
  const types = normalizeSelectedTypes(selected);
  const targets: TypeTargets = { knowledge: 0, clinical: 0, image: 0, free: 0 };
  if (types.length === 0) {
    targets.free = n;
    return targets;
  }
  const base = Math.floor(n / types.length);
  let remainder = n - base * types.length;
  for (const t of types) targets[KEY[t]] = base;
  for (const t of REMAINDER_PRIORITY) {
    if (remainder <= 0) break;
    if (!types.includes(t)) continue;
    targets[KEY[t]] += 1;
    remainder -= 1;
  }
  // 이미지 공급 상한 — 넘치는 몫을 다른 선택 유형으로 고르게 옮긴다.
  const cap = Math.max(0, Math.floor(Number.isFinite(imageSupplyCap) ? imageSupplyCap : n));
  if (types.includes('이미지형') && targets.image > cap) {
    let excess = targets.image - cap;
    targets.image = cap;
    const others = REMAINDER_PRIORITY.filter((t) => t !== '이미지형' && types.includes(t));
    if (others.length === 0) {
      targets.free += excess;
    } else {
      // 적은 쪽부터 1씩 — 두 유형이면 번갈아 받는다.
      while (excess > 0) {
        const pick = [...others].sort((a, b) => targets[KEY[a]] - targets[KEY[b]])[0];
        targets[KEY[pick]] += 1;
        excess -= 1;
      }
    }
  }
  return targets;
}

/**
 * 텍스트 유형(임상형·지식형·free)을 슬롯 수만큼 번갈아 배열한다.
 * 임상형과 지식형을 교대로 놓아 한 묶음에 두 유형이 섞이게 한다(묶음이 한 유형으로만
 * 차면 그 묶음의 발문·증례가 서로 닮는다).
 */
function interleaveText(
  clinical: number,
  knowledge: number,
  free: number,
  count: number,
): Array<'clinical' | 'knowledge' | 'free'> {
  const out: Array<'clinical' | 'knowledge' | 'free'> = [];
  let c = Math.max(0, clinical);
  let k = Math.max(0, knowledge);
  let f = Math.max(0, free);
  let turn: 'clinical' | 'knowledge' = c >= k ? 'clinical' : 'knowledge';
  while (out.length < count) {
    if (c === 0 && k === 0) {
      if (f === 0) break;
      out.push('free');
      f -= 1;
      continue;
    }
    if (turn === 'clinical' && c > 0) {
      out.push('clinical');
      c -= 1;
    } else if (k > 0) {
      out.push('knowledge');
      k -= 1;
    } else {
      out.push('clinical');
      c -= 1;
    }
    turn = turn === 'clinical' ? 'knowledge' : 'clinical';
  }
  return out;
}

/**
 * 전역 목표를 묶음별 쿼터로 나눈다.
 *
 *  - 이미지 문항은 `imageEligible[i]` 가 true 인 묶음(이미지를 받을 수 있는 묶음)에만
 *    고르게 놓는다(5문항·3묶음 → 2·2·1). 자격 묶음의 용량이 모자라면 남는 몫은 텍스트로 옮긴다.
 *  - 남은 칸은 임상형·지식형을 교대로 채운다. 묶음 쿼터의 합은 항상 묶음 크기와 같다.
 */
export function planBatchQuotas(
  batchSizes: readonly number[],
  targets: TypeTargets,
  imageEligible: readonly boolean[],
): BatchQuota[] {
  const quotas: BatchQuota[] = batchSizes.map(() => ({ image: 0, knowledge: 0, clinical: 0, free: 0 }));
  const eligible = batchSizes.map((_, i) => i).filter((i) => imageEligible[i]);
  let imageLeft = Math.max(0, targets.image);
  // 라운드로빈으로 1문항씩 — 앞 묶음이 몫을 독식해 꼬리 묶음이 0장이 되는 일을 막는다.
  let progressed = true;
  while (imageLeft > 0 && progressed) {
    progressed = false;
    for (const i of eligible) {
      if (imageLeft <= 0) break;
      if (quotas[i].image < batchSizes[i]) {
        quotas[i].image += 1;
        imageLeft -= 1;
        progressed = true;
      }
    }
  }
  // 이미지 용량이 모자라 남은 몫은 텍스트 유형으로 옮긴다(planTypeTargets 와 같은 규칙).
  let clinical = targets.clinical;
  let knowledge = targets.knowledge;
  let free = targets.free;
  if (imageLeft > 0) {
    if (clinical === 0 && knowledge === 0) free += imageLeft;
    else {
      while (imageLeft > 0) {
        if (clinical <= knowledge && targets.clinical > 0) clinical += 1;
        else if (targets.knowledge > 0) knowledge += 1;
        else clinical += 1;
        imageLeft -= 1;
      }
    }
  }
  const textSlots = batchSizes.reduce((sum, size, i) => sum + Math.max(0, size - quotas[i].image), 0);
  const seq = interleaveText(clinical, knowledge, free, textSlots);
  let cursor = 0;
  for (let i = 0; i < batchSizes.length; i++) {
    const room = Math.max(0, batchSizes[i] - quotas[i].image);
    for (let r = 0; r < room; r++) {
      const t = seq[cursor++];
      if (t === 'clinical') quotas[i].clinical += 1;
      else if (t === 'knowledge') quotas[i].knowledge += 1;
      else quotas[i].free += 1;
    }
  }
  return quotas;
}

/**
 * 묶음이 실제로 받은 이미지 공급이 계획보다 적을 때(정제 탈락) 모자란 이미지 몫을
 * 텍스트 유형으로 옮긴다. 합은 그대로 묶음 크기다.
 *
 * `imageQuota` 는 실제 공급으로 조인 값(≤ planned.image).
 */
export function spillImageShortfall(
  planned: BatchQuota,
  imageQuota: number,
  selected: readonly string[] | undefined,
): BatchQuota {
  const types = normalizeSelectedTypes(selected);
  const q: BatchQuota = { ...planned, image: Math.max(0, Math.min(planned.image, imageQuota)) };
  let spill = planned.image - q.image;
  const hasC = types.includes('임상형');
  const hasK = types.includes('지식형');
  while (spill > 0) {
    if (hasC && hasK) {
      if (q.clinical <= q.knowledge) q.clinical += 1;
      else q.knowledge += 1;
    } else if (hasC) q.clinical += 1;
    else if (hasK) q.knowledge += 1;
    else q.free += 1;
    spill -= 1;
  }
  return q;
}

export interface TypeCounts {
  knowledge: number;
  clinical: number;
  image: number;
}

/** 유형별 부족분(양수)·초과분(음수). 저장된 kind 집계와 목표를 대조한다. */
export function typeDeficits(targets: TypeTargets, actual: TypeCounts): TypeCounts {
  return {
    knowledge: targets.knowledge - actual.knowledge,
    clinical: targets.clinical - actual.clinical,
    image: targets.image - actual.image,
  };
}

/**
 * 보충 묶음의 쿼터 — 빈 슬롯을 **모자란 유형**으로 채운다.
 *
 * 종전 보충은 묶음마다 "유형 수로 나눈 최소 1"을 또 적용해, 이미지 문항이 폐기될 때마다
 * 텍스트로 치환되고 비율이 계속 밀렸다. 이제 부족한 유형부터 채운다:
 * 이미지 부족분은 그 묶음이 실을 수 있는 이미지 용량(`imageCapacities[i]`) 안에서, 나머지는
 * 임상형·지식형 부족분을 교대로. 부족분이 다 떨어지면 선택 유형 중 적게 나온 쪽에 준다.
 */
export function planFillQuotas(
  fillSizes: readonly number[],
  deficits: TypeCounts,
  imageCapacities: readonly number[],
  selected: readonly string[] | undefined,
): BatchQuota[] {
  const types = normalizeSelectedTypes(selected);
  const quotas: BatchQuota[] = fillSizes.map(() => ({ image: 0, knowledge: 0, clinical: 0, free: 0 }));
  let imageNeed = types.includes('이미지형') ? Math.max(0, deficits.image) : 0;
  for (let i = 0; i < fillSizes.length; i++) {
    const cap = Math.max(0, Math.min(fillSizes[i], imageCapacities[i] ?? 0, imageNeed));
    quotas[i].image = cap;
    imageNeed -= cap;
  }
  let clinicalNeed = types.includes('임상형') ? Math.max(0, deficits.clinical) : 0;
  let knowledgeNeed = types.includes('지식형') ? Math.max(0, deficits.knowledge) : 0;
  const hasC = types.includes('임상형');
  const hasK = types.includes('지식형');
  for (let i = 0; i < fillSizes.length; i++) {
    const room = Math.max(0, fillSizes[i] - quotas[i].image);
    for (let r = 0; r < room; r++) {
      if (clinicalNeed > 0 && (clinicalNeed >= knowledgeNeed || knowledgeNeed === 0)) {
        quotas[i].clinical += 1;
        clinicalNeed -= 1;
      } else if (knowledgeNeed > 0) {
        quotas[i].knowledge += 1;
        knowledgeNeed -= 1;
      } else if (hasC && hasK) {
        // 부족분이 없으면 덜 나온 쪽(음수 부족분이 작은 쪽)에 준다.
        if (deficits.clinical >= deficits.knowledge) quotas[i].clinical += 1;
        else quotas[i].knowledge += 1;
      } else if (hasC) quotas[i].clinical += 1;
      else if (hasK) quotas[i].knowledge += 1;
      else quotas[i].free += 1;
    }
  }
  return quotas;
}

/**
 * 유형 비율 교정에서 **지울** 초과 유형의 문항 수.
 *
 * 부족한 유형이 있고 그 유형을 다시 만들 수 있을 때만(이미지형은 남은 이미지 용량 안에서)
 * 초과 유형 문항을 그만큼 지우고 보충이 부족 유형으로 다시 채운다. 반환값은 유형별 삭제 수.
 */
export function planTypeRepair(
  deficits: TypeCounts,
  imageCapacity: number,
  selected: readonly string[] | undefined,
): { deleteFrom: TypeCounts; regenerate: TypeCounts } {
  const types = normalizeSelectedTypes(selected);
  const regenerate: TypeCounts = { knowledge: 0, clinical: 0, image: 0 };
  if (types.includes('이미지형')) regenerate.image = Math.max(0, Math.min(deficits.image, imageCapacity));
  if (types.includes('임상형')) regenerate.clinical = Math.max(0, deficits.clinical);
  if (types.includes('지식형')) regenerate.knowledge = Math.max(0, deficits.knowledge);
  let toDelete = regenerate.image + regenerate.clinical + regenerate.knowledge;
  const deleteFrom: TypeCounts = { knowledge: 0, clinical: 0, image: 0 };
  // 초과분이 큰 유형부터 지운다.
  const surplus: Array<[keyof TypeCounts, number]> = (
    [
      ['knowledge', -deficits.knowledge],
      ['clinical', -deficits.clinical],
      ['image', -deficits.image],
    ] as Array<[keyof TypeCounts, number]>
  )
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1]);
  for (const [k, s] of surplus) {
    if (toDelete <= 0) break;
    const take = Math.min(s, toDelete);
    deleteFrom[k] = take;
    toDelete -= take;
  }
  // 지울 초과분이 재생성 수보다 적으면(요청 수 미달 등) 재생성도 그만큼만.
  const deletable = deleteFrom.knowledge + deleteFrom.clinical + deleteFrom.image;
  let over = regenerate.image + regenerate.clinical + regenerate.knowledge - deletable;
  for (const k of ['knowledge', 'clinical', 'image'] as const) {
    if (over <= 0) break;
    const cut = Math.min(regenerate[k], over);
    regenerate[k] -= cut;
    over -= cut;
  }
  return { deleteFrom, regenerate };
}
