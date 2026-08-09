'use client';

import { Clock3 } from 'lucide-react';

// 결과 화면 공용: 단계별 시간 사용 바 + 신체진찰 면제 안내.
// analysis = evaluate 응답의 timeAnalysis, excludedSections = 채점 제외 영역(진찰 면제 케이스).
const PHASE_COLORS = {
  history_taking: 'var(--color-primary)',
  physical_exam: 'var(--color-gold)',
  patient_education: '#5a8b70',
};

export function formatDuration(seconds) {
  const safe = Math.max(0, Math.round(seconds ?? 0));
  return `${Math.floor(safe / 60)}분 ${String(safe % 60).padStart(2, '0')}초`;
}

export default function CpxTimeAnalysis({ analysis, excludedSections }) {
  if (!analysis && !excludedSections?.length) return null;
  const phases = analysis?.phases || [];
  const total = analysis?.totalSeconds || 0;
  // 단계 합이 총 시간과 다를 수 있어(반올림) 큰 쪽을 분모로 쓴다.
  const denom = Math.max(total, phases.reduce((sum, p) => sum + p.seconds, 0), 1);
  return (
    <div className="space-y-3">
      {analysis && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
          <span className="inline-flex items-center gap-1.5 font-bold text-[var(--color-text)]"><Clock3 className="h-4 w-4 text-[var(--color-primary)]" />단계별 시간 사용</span>
          <span className="tnum text-[var(--color-muted)]">총 {formatDuration(total)}{analysis.timeLimitSeconds ? ` / 제한 ${formatDuration(analysis.timeLimitSeconds)}` : ''}</span>
        </div>
      )}
      {analysis && (phases.length ? (
        <>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-[var(--color-border)]">
            {phases.map((p) => (
              <div key={p.id} style={{ width: `${(p.seconds / denom) * 100}%`, background: PHASE_COLORS[p.id] || 'var(--color-muted)' }} title={`${p.name} ${formatDuration(p.seconds)}`} />
            ))}
          </div>
          <ul className="grid gap-1.5 sm:grid-cols-3">
            {phases.map((p) => (
              <li key={p.id} className="flex items-center gap-2 text-sm">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: PHASE_COLORS[p.id] || 'var(--color-muted)' }} />
                <span className="text-[var(--color-muted)]">{p.name}</span>
                <span className="tnum ml-auto font-bold text-[var(--color-text)]">{formatDuration(p.seconds)}</span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-[var(--color-muted)]">대화 기록으로 단계 전환 시점을 추정한 값입니다.</p>
        </>
      ) : (
        <p className="text-sm text-[var(--color-muted)]">단계 전환을 인식하지 못해 총 진료 시간만 표시합니다.</p>
      ))}
      {excludedSections?.length > 0 && (
        <p className="rounded-[var(--radius-md)] bg-[var(--color-sage-50)] px-3 py-2 text-sm text-[var(--color-muted)]">
          이 시나리오는 신체진찰이 필요하지 않아 <b className="text-[var(--color-text)]">{excludedSections.map((s) => s.name).join(', ')}</b> 영역을 제외하고 100점 만점으로 환산했습니다.
        </p>
      )}
    </div>
  );
}
