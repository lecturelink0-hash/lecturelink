/**
 * 층화 무작위 표본 추출 (성능지표 가이드 §6.2 · 분담표 A12)
 *
 * 가이드 §6.2: "잘 나온 문제만 골라서는 안 된다. 연속 생성 결과를 저장한 뒤 과목,
 * 강의자료 형식, 난이도, 텍스트 또는 이미지 문항, 객관식 형식을 기준으로 무작위 층화 추출한다."
 *
 * **사람 의지가 아니라 도구로 강제한다.** 검수 표본을 손으로 고르면, 악의가 없어도
 * 잘 나온 문항 쪽으로 손이 간다. 그렇게 뽑은 표본으로 낸 승인율은 실제 승인율보다 높고,
 * 그 수치를 대외에 내면 발표 자리에서 무너진다.
 *
 * **재현 가능해야 한다.** seed 를 기록해 두면 "그 표본이 정말 무작위였나"를 나중에
 * 다시 돌려 확인할 수 있다. 감사 가능성이 대표성만큼 중요하다.
 *
 * import 를 두지 않는다 — 검사 스크립트가 이 파일만 불러 산식을 확인할 수 있어야 한다.
 */

export interface Stratum {
  /** 층 이름 — 보고서에 그대로 나간다. */
  key: string;
  /** 항목에서 이 층의 값을 뽑는다. null 이면 '미상' 으로 묶인다. */
  valueOf: (item: Record<string, unknown>) => string | null;
}

export interface StratumAllocation {
  cell: string;
  population: number;
  /** 비례 배분으로 계산된 목표 수. */
  target: number;
  /** 실제로 뽑힌 수. 모집단이 목표보다 적으면 target 보다 작다. */
  taken: number;
  shortfall: number;
}

export interface SampleResult<T> {
  sample: T[];
  seed: string;
  requested: number;
  population: number;
  allocations: StratumAllocation[];
  /** 목표를 못 채운 층이 있으면 여기 남는다 — 조용히 넘어가면 대표성이 깨진 줄 모른다. */
  warnings: string[];
}

/**
 * 결정론적 난수 (mulberry32). Math.random 을 쓰면 같은 seed 로 다시 돌릴 수 없어
 * 표본을 재현할 수 없다 — 그러면 "무작위였다"를 증명할 방법이 사라진다.
 */
export function seededRandom(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i += 1) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates. 원본을 건드리지 않는다. */
export function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function cellKeyOf(item: Record<string, unknown>, strata: Stratum[]): string {
  return strata.map((s) => `${s.key}=${s.valueOf(item) ?? '미상'}`).join(' | ');
}

/**
 * 비례 배분 + 최대잉여법.
 *
 * 단순 반올림으로 층별 목표를 정하면 합계가 요청 수와 어긋난다(모자라거나 넘친다).
 * 최대잉여법은 소수부가 큰 층부터 남은 자리를 채워 합계를 정확히 맞춘다.
 */
function allocate(counts: number[], total: number, size: number): number[] {
  if (total === 0) return counts.map(() => 0);
  const exact = counts.map((c) => (c / total) * size);
  const base = exact.map((v) => Math.floor(v));
  let remaining = size - base.reduce((a, b) => a + b, 0);
  const order = exact
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    // 모집단보다 많이 배정하지 않는다.
    if (base[i] >= counts[i]) continue;
    base[i] += 1;
    remaining -= 1;
  }
  return base;
}

/**
 * 층화 무작위 추출.
 *
 * 층이 잘게 쪼개지면(과목 × 형식 × 난이도 × 이미지 여부) 셀 하나에 1–2건만 남는다.
 * 그런 셀은 배분이 0이 되기 쉬운데, 그러면 그 조합이 검수에서 통째로 빠진다.
 * `minPerCell` 로 비어 있지 않은 셀에 최소 1건을 보장할 수 있다.
 */
export function stratifiedSample<T extends Record<string, unknown>>(
  items: T[],
  options: {
    size: number;
    strata: Stratum[];
    seed: string;
    /** 비어 있지 않은 층마다 최소 몇 건을 보장할지 (기본 0 = 순수 비례). */
    minPerCell?: number;
  },
): SampleResult<T> {
  const { size, strata, seed } = options;
  const minPerCell = options.minPerCell ?? 0;
  const random = seededRandom(seed);
  const warnings: string[] = [];

  const cells = new Map<string, T[]>();
  for (const item of items) {
    const key = cellKeyOf(item, strata);
    const list = cells.get(key);
    if (list) list.push(item);
    else cells.set(key, [item]);
  }
  // 셀 순서를 이름순으로 고정한다 — 입력 순서가 배분에 영향을 주면 재현성이 깨진다.
  const cellKeys = [...cells.keys()].sort();
  const counts = cellKeys.map((k) => cells.get(k)!.length);
  const population = items.length;

  if (size >= population) {
    warnings.push(`요청 ${size}건이 모집단 ${population}건 이상이라 전수를 반환한다.`);
    return {
      sample: shuffle(items, random),
      seed,
      requested: size,
      population,
      allocations: cellKeys.map((cell, i) => ({
        cell, population: counts[i], target: counts[i], taken: counts[i], shortfall: 0,
      })),
      warnings,
    };
  }

  let targets = allocate(counts, population, size);

  if (minPerCell > 0) {
    // 최소 보장을 채우고, 그만큼을 여유 있는 층에서 큰 쪽부터 뺀다.
    for (let i = 0; i < targets.length; i += 1) {
      const want = Math.min(minPerCell, counts[i]);
      while (targets[i] < want) {
        let donor = -1;
        let best = -1;
        for (let j = 0; j < targets.length; j += 1) {
          if (j === i) continue;
          const spare = targets[j] - Math.min(minPerCell, counts[j]);
          if (spare > 0 && targets[j] > best) {
            best = targets[j];
            donor = j;
          }
        }
        if (donor < 0) {
          warnings.push(`최소 보장(${minPerCell})을 채울 여유가 없다 — 요청 수를 늘려야 한다.`);
          break;
        }
        targets[donor] -= 1;
        targets[i] += 1;
      }
    }
  }

  const allocations: StratumAllocation[] = [];
  const sample: T[] = [];
  cellKeys.forEach((cell, i) => {
    const pool = shuffle(cells.get(cell)!, random);
    const taken = Math.min(targets[i], pool.length);
    sample.push(...pool.slice(0, taken));
    const shortfall = targets[i] - taken;
    if (shortfall > 0) {
      warnings.push(`층 "${cell}": 목표 ${targets[i]}건 중 ${taken}건만 있음 (${shortfall}건 부족).`);
    }
    allocations.push({ cell, population: pool.length, target: targets[i], taken, shortfall });
  });

  const missing = size - sample.length;
  if (missing > 0) {
    // 부족분은 아직 안 뽑힌 것 중에서 무작위로 채운다. 층 비율은 조금 흐트러지지만
    // 요청한 표본 수를 못 채우는 것보다 낫다 — 그 사실은 warnings 에 남는다.
    const chosen = new Set(sample);
    const rest = shuffle(items.filter((item) => !chosen.has(item)), random);
    sample.push(...rest.slice(0, missing));
    warnings.push(`층별 목표로 ${missing}건이 모자라 무작위로 보충했다 — 층 비율이 정확히 유지되지 않는다.`);
  }

  return { sample: shuffle(sample, random), seed, requested: size, population, allocations, warnings };
}

/**
 * 가이드 §6.2 가 이름을 든 축들. 데이터 모양이 달라도 이 이름으로 보고하면
 * 문서와 코드가 갈라지지 않는다.
 */
export function defaultQuestionStrata(): Stratum[] {
  return [
    { key: '과목', valueOf: (item) => asText(item.subject ?? item.subject_name) },
    { key: '자료형식', valueOf: (item) => asText(item.materialType ?? item.file_type) },
    { key: '난이도', valueOf: (item) => asText(item.difficulty) },
    {
      key: '이미지문항',
      valueOf: (item) => {
        const hasImage = item.hasImage ?? item.image_url ?? item.open_image_id;
        if (hasImage === undefined || hasImage === null) return '아니오';
        return hasImage === false || hasImage === '' ? '아니오' : '예';
      },
    },
  ];
}

function asText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text === '' ? null : text;
}
