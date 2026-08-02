'use client';

// 전체 대화록 뷰 — 채점 직후 결과 화면과 '나의 CPX 기록' 상세에서 공용.
// events: [{ role: 'student'|'patient'|'system', text, tOffsetMs }] (시간순 정렬은 호출부 책임 아님 — 여기서 보정)

function formatOffset(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export default function CpxTranscriptView({ events }) {
  const rows = (Array.isArray(events) ? events : [])
    .filter((event) => event && typeof event.text === 'string' && event.text.trim())
    .slice()
    .sort((a, b) => (a.tOffsetMs ?? 0) - (b.tOffsetMs ?? 0));

  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-[var(--color-muted)]">저장된 대화 기록이 없습니다.</p>;
  }

  return (
    <div className="max-h-[480px] space-y-3 overflow-y-auto pr-1">
      {rows.map((event, index) => {
        const isStudent = event.role === 'student';
        return (
          <div key={`${event.tOffsetMs ?? 0}-${index}`} className={isStudent ? 'text-right' : 'text-left'}>
            <div className={`mb-0.5 flex items-baseline gap-1.5 text-[11px] text-[var(--color-muted)] ${isStudent ? 'justify-end' : 'justify-start'}`}>
              <span className="font-semibold">{isStudent ? '학생 의사' : '환자'}</span>
              {formatOffset(event.tOffsetMs) && <span className="tnum">{formatOffset(event.tOffsetMs)}</span>}
            </div>
            <span className={`inline-block max-w-[88%] whitespace-pre-wrap break-words rounded-[var(--radius-md)] px-3 py-2 text-left text-sm ${isStudent ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-sage-100)] text-[var(--color-text)]'}`}>
              {event.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
