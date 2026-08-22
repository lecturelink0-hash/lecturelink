'use client';

// 영역 만점 = weightPercent(총점 100 기준). 없으면 점수를 만점으로 간주(100%).
export function sectionMax(s) {
  return typeof s.weightPercent === 'number' ? s.weightPercent : (s.maxScore ?? s.score ?? 0);
}

// 게이지 채움 색 — 등급별. 우수=초록, 미흡=경고, 그 외(보통)=차분한 세이지.
export function gaugeColor(grade) {
  if (grade === '우수') return 'var(--color-primary)';
  if (grade === '미흡') return 'var(--color-warn)';
  return '#5a8b70';
}

// 가로 점수 게이지 (라벨 + 내점수/만점 + 막대).
// 채점 상세(CpxResultDetail)와 진료 직후 결과(CpxPractice)가 같이 쓴다 —
// 만점 규칙이 바뀌면 sectionMax 한 곳만 고치면 되도록 여기 모아둔다.
export default function ScoreGauge({ section }) {
  const max = sectionMax(section);
  const pct = max > 0 ? Math.max(0, Math.min(100, (section.score / max) * 100)) : 0;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-[var(--color-text)]">{section.name}</span>
        <span className="tnum text-[var(--color-muted)]">
          <b className="text-[var(--color-text)]">{section.score}</b> / {max}점
          {section.gradeLabel ? <span className="ml-1">· {section.gradeLabel}</span> : null}
        </span>
      </div>
      <div className="h-2.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
        <div className="h-full rounded-full transition-[width] duration-500" style={{ width: `${pct}%`, background: gaugeColor(section.gradeLabel) }} />
      </div>
    </div>
  );
}
