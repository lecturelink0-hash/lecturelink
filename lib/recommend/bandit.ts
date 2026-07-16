/**
 * Multi-Armed Bandit 추천 알고리즘
 *
 * 학교 코호트 기반 sub_topic inclusion_score 와
 * 사용자 약점 가중치를 결합하여 sub_topic 분포를 결정한다.
 *
 * 노출 비율:
 *   - 80% exploitation : 코호트 점수 높은 sub_topic 위주
 *   - 15% exploration  : 점수 중간 영역
 *   -  5% wild card    : 점수 낮거나 미지의 영역 (교육과정 개편 감지)
 *
 * 약점 가중치가 있는 sub_topic 은 exploitation 풀에서 부스트.
 */

export interface BanditSubTopicInput {
  subTopicId: string;
  /** 0~1: 코호트의 시험 범위 inclusion_score × confidence */
  weightedScore: number;
  /** 0~1: 사용자 약점 심각도 (선택적, 없으면 0) */
  weaknessBoost?: number;
}

export interface BanditAllocation {
  subTopicId: string;
  count: number;
  bucket: 'exploitation' | 'exploration' | 'wild_card';
}

export interface BanditOptions {
  exploitationRate?: number;
  explorationRate?: number;
  wildCardRate?: number;
  /** 약점 가중치를 exploitation 점수에 얼마나 반영할지 (0~1) */
  weaknessWeight?: number;
}

const DEFAULT_OPTIONS: Required<BanditOptions> = {
  exploitationRate: 0.8,
  explorationRate: 0.15,
  wildCardRate: 0.05,
  weaknessWeight: 0.4,
};

/**
 * sub_topic 들을 점수 분포에 따라 3개의 버킷으로 분류.
 */
export function bucketizeSubTopics(
  inputs: BanditSubTopicInput[],
  options: BanditOptions = {},
): {
  exploitation: BanditSubTopicInput[];
  exploration: BanditSubTopicInput[];
  wildCard: BanditSubTopicInput[];
} {
  const opt = { ...DEFAULT_OPTIONS, ...options };

  // 가중 점수 계산 — 약점 부스트 적용
  const scored = inputs.map((input) => ({
    ...input,
    finalScore:
      input.weightedScore * (1 - opt.weaknessWeight) +
      (input.weaknessBoost ?? 0) * opt.weaknessWeight,
  }));

  // 점수 기준 내림차순 정렬
  scored.sort((a, b) => b.finalScore - a.finalScore);

  // 상위 ~33% exploitation, 중간 ~50% exploration, 하위 ~17% wild card
  // (실제 노출 비율은 allocateCount 에서 다시 적용)
  const n = scored.length;
  if (n === 0) {
    return { exploitation: [], exploration: [], wildCard: [] };
  }

  const exploitCount = Math.max(1, Math.floor(n * 0.4));
  const wildCount = Math.max(1, Math.floor(n * 0.2));

  return {
    exploitation: scored.slice(0, exploitCount),
    exploration: scored.slice(exploitCount, n - wildCount),
    wildCard: scored.slice(n - wildCount),
  };
}

/**
 * 총 N개의 문항을 sub_topic 별로 할당.
 *
 * 각 버킷에 정해진 비율의 문항을 분배하고,
 * 버킷 내에서는 점수 비례 가중치로 sub_topic 을 샘플링.
 */
export function allocateCount(
  inputs: BanditSubTopicInput[],
  totalCount: number,
  options: BanditOptions = {},
): BanditAllocation[] {
  const opt = { ...DEFAULT_OPTIONS, ...options };
  const buckets = bucketizeSubTopics(inputs, opt);

  const exploitN = Math.round(totalCount * opt.exploitationRate);
  const exploreN = Math.round(totalCount * opt.explorationRate);
  const wildN = totalCount - exploitN - exploreN;

  const allocations: BanditAllocation[] = [];

  // 각 버킷에서 점수 비례 샘플링
  allocations.push(...sampleWithinBucket(buckets.exploitation, exploitN, 'exploitation'));
  allocations.push(...sampleWithinBucket(buckets.exploration, exploreN, 'exploration'));
  allocations.push(...sampleWithinBucket(buckets.wildCard, wildN, 'wild_card'));

  // 같은 sub_topic 중복 병합
  const merged = new Map<string, BanditAllocation>();
  for (const a of allocations) {
    const existing = merged.get(a.subTopicId);
    if (existing) {
      existing.count += a.count;
    } else {
      merged.set(a.subTopicId, { ...a });
    }
  }
  return Array.from(merged.values()).filter((a) => a.count > 0);
}

/**
 * 버킷 내에서 점수 비례 가중치로 N개 샘플 (replacement 허용).
 */
function sampleWithinBucket(
  bucket: Array<BanditSubTopicInput & { finalScore?: number }>,
  count: number,
  bucketName: 'exploitation' | 'exploration' | 'wild_card',
): BanditAllocation[] {
  if (bucket.length === 0 || count <= 0) return [];

  // exploration·wild_card 는 균등 분포
  // exploitation 만 점수 비례
  const useScoreWeighting = bucketName === 'exploitation';
  const totalWeight = useScoreWeighting
    ? bucket.reduce((sum, b) => sum + (b.finalScore ?? b.weightedScore), 0)
    : bucket.length;

  if (totalWeight === 0) return [];

  // 라운드 로빈 + 확률 가중 (단순 round-robin 으로 분배)
  const counts = new Map<string, number>();
  for (let i = 0; i < count; i++) {
    let target: BanditSubTopicInput;
    if (useScoreWeighting) {
      const r = Math.random() * totalWeight;
      let cum = 0;
      target = bucket[bucket.length - 1];
      for (const b of bucket) {
        cum += b.finalScore ?? b.weightedScore;
        if (r <= cum) {
          target = b;
          break;
        }
      }
    } else {
      target = bucket[i % bucket.length];
    }
    counts.set(target.subTopicId, (counts.get(target.subTopicId) ?? 0) + 1);
  }

  return Array.from(counts.entries()).map(([subTopicId, c]) => ({
    subTopicId,
    count: c,
    bucket: bucketName,
  }));
}
