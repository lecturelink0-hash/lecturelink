/**
 * 평가 스크립트 공용 — 시드 고정 난수·표본 뽑기·Cohen's κ. 모델 호출 없음.
 */

/** 시드 고정 난수(mulberry32). */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function pick<T>(xs: readonly T[], n: number, rand: () => number): T[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

/** Cohen's κ (같은 길이의 두 라벨 배열). */
export function cohenKappa<T>(a: readonly T[], b: readonly T[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  const cats = [...new Set([...a, ...b])];
  const n = a.length;
  const po = a.filter((x, i) => x === b[i]).length / n;
  const pe = cats.reduce((s, c) => s + (a.filter((x) => x === c).length / n) * (b.filter((x) => x === c).length / n), 0);
  return pe === 1 ? 1 : (po - pe) / (1 - pe);
}

