'use client';

/**
 * 학습 신호 수집 UI (분담표 A14 · 가이드 §8.1)
 *
 * 가이드가 요구하는 신호 중 지금 안 모으는 셋 — 확신도·해설 열람·오류 신고 — 을
 * 한 곳에 모아 둔다. 풀이 화면이 여섯 개라 각자 구현하면 곧 갈라지고,
 * 갈라진 순간 "확신도"가 화면마다 다른 뜻이 된다.
 *
 * **소급이 불가능한 신호다.** 파일럿이 시작된 뒤에 넣으면 그 이전 풀이에는 영원히
 * 값이 없다. 그래서 학생이 들어오기 전에 넣는다.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
// 측정(클라이언트)과 판정(서버)이 같은 임계값을 써야 한다 — 각자 두면 한쪽만 고쳤을 때
// "3초 봤는데 안 읽은 것으로 기록됨" 같은 조용한 불일치가 생긴다.
import { EXPLANATION_VIEWED_MS, MAX_EXPLANATION_DWELL_MS } from '@/lib/study/signals';

export type Confidence = 1 | 2 | 3;

const CONFIDENCE_OPTIONS: Array<{ value: Confidence; label: string; hint: string }> = [
  { value: 1, label: '잘 모르겠음', hint: '찍었거나 근거가 약하다' },
  { value: 2, label: '보통', hint: '맞을 것 같지만 확신은 없다' },
  { value: 3, label: '확실함', hint: '근거를 대고 고를 수 있다' },
];

/**
 * 확신도 선택 — 답을 제출하기 **전에** 묻는다.
 *
 * 제출 후에 물으면 정답 여부를 본 뒤의 기억이 섞여(사후과잉확신) 보정 지표가 무의미해진다.
 * 강제하지 않는 이유: 매 문항 응답을 요구하면 학생이 회피하거나 대충 찍어 신호가
 * 오히려 나빠진다. 미응답은 null 로 두고 분모에서 뺀다.
 */
export function ConfidenceSelector({
  value,
  onChange,
  disabled = false,
}: {
  value: Confidence | null;
  onChange: (value: Confidence | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-3">
      <div className="text-xs text-[var(--color-muted)] mb-1.5">
        얼마나 확신하나요? <span className="opacity-70">(선택)</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {CONFIDENCE_OPTIONS.map((option) => {
          const active = value === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={disabled}
              title={option.hint}
              aria-pressed={active}
              // 한 번 더 누르면 해제 — 잘못 눌렀을 때 되돌릴 방법이 없으면
              // 학생이 아무거나 눌러 두고 넘어가 신호가 오염된다.
              onClick={() => onChange(active ? null : option.value)}
              className={`px-2.5 py-1 rounded-full text-xs border transition-colors ${
                active
                  ? 'bg-sage-800 text-white border-sage-800'
                  : 'bg-white text-sage-800 border-[var(--color-border)] hover:border-sage-400'
              } ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}


/**
 * 해설 노출 시간 측정.
 *
 * 이 서비스의 해설은 채점 직후 그대로 펼쳐진다 — 접혀 있지 않으니 "열었다"는 값이 항상
 * 참이라 신호가 되지 않는다. 그래서 **실제로 화면에 보인 시간**을 잰다.
 * IntersectionObserver 로 뷰포트 진입을, visibilitychange 로 탭 전환을 함께 본다.
 * (해설을 접어 두는 UX 변경은 학습 경험을 바꾸는 제품 결정이라 계측이 정할 일이 아니다.)
 */
export function useExplanationDwell(attemptId: string | null | undefined) {
  const ref = useRef<HTMLDivElement | null>(null);
  const startedAt = useRef<number | null>(null);
  const accumulated = useRef(0);
  const sent = useRef(0);

  const flush = useCallback(() => {
    if (!attemptId) return;
    if (startedAt.current !== null) {
      accumulated.current += Date.now() - startedAt.current;
      startedAt.current = null;
    }
    const total = Math.min(accumulated.current, MAX_EXPLANATION_DWELL_MS);
    const delta = total - sent.current;
    // 1초 미만 증가분은 보내지 않는다 — 스크롤할 때마다 요청이 나가면
    // 계측이 서비스보다 비싸진다.
    if (delta < 1000) return;
    sent.current = total;
    void fetch(`/api/attempts/${attemptId}/explanation-view`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dwellMs: delta }),
      keepalive: true,
    }).catch(() => {
      // 계측 실패는 삼킨다. 해설을 읽는 데 방해가 되면 안 된다.
      sent.current = total - delta;
    });
  }, [attemptId]);

  useEffect(() => {
    const node = ref.current;
    if (!node || !attemptId) return undefined;
    accumulated.current = 0;
    sent.current = 0;
    startedAt.current = null;

    const resume = () => {
      if (startedAt.current === null && document.visibilityState === 'visible') {
        startedAt.current = Date.now();
      }
    };
    const pause = () => {
      if (startedAt.current !== null) {
        accumulated.current += Date.now() - startedAt.current;
        startedAt.current = null;
      }
    };

    let visible = false;
    const observer = new IntersectionObserver(
      ([entry]) => {
        // 절반 이상 보일 때만 '보고 있다'로 센다. 화면 끝에 1픽셀 걸친 것은 읽는 게 아니다.
        visible = entry.isIntersecting && entry.intersectionRatio >= 0.5;
        if (visible) resume();
        else pause();
      },
      { threshold: [0, 0.5, 1] },
    );
    observer.observe(node);

    const onVisibility = () => {
      if (document.visibilityState === 'hidden') pause();
      else if (visible) resume();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // 주기 전송 — 문항을 넘기기 전에 끊겨도 그때까지의 시간은 남는다.
    const timer = window.setInterval(flush, 5000);
    window.addEventListener('pagehide', flush);

    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pagehide', flush);
      window.clearInterval(timer);
      flush();
    };
  }, [attemptId, flush]);

  return { ref, viewedThresholdMs: EXPLANATION_VIEWED_MS };
}

const REPORT_REASONS = [
  { value: 'wrong_answer', label: '정답이 틀렸어요' },
  { value: 'multiple_answers', label: '정답이 여러 개예요' },
  { value: 'stem_error', label: '지문에 오류가 있어요' },
  { value: 'choice_error', label: '선지에 오류가 있어요' },
  { value: 'explanation_error', label: '해설에 오류가 있어요' },
  { value: 'image_problem', label: '그림이 없거나 안 맞아요' },
  { value: 'out_of_scope', label: '강의 범위 밖이에요' },
  { value: 'other', label: '기타' },
] as const;

/**
 * 문항 오류 신고.
 *
 * 신고는 문항 통계(A13)와 함께 읽어야 의미가 있다 — point-biserial 이 음수인 문항에
 * '정답이 틀렸어요' 신고가 겹치면 거의 확실한 결함이다.
 */
export function QuestionReportButton({
  questionId,
  isPrivate,
  attemptId,
}: {
  questionId: string;
  isPrivate: boolean;
  attemptId?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [state, setState] = useState<'idle' | 'sending' | 'done' | 'error'>('idle');

  if (state === 'done') {
    return (
      <div className="mt-2 text-xs text-[var(--color-muted)]">
        신고해주셔서 감사합니다. 검토 후 반영하겠습니다.
      </div>
    );
  }

  const submit = async () => {
    if (!reason) return;
    setState('sending');
    try {
      const response = await fetch('/api/question-reports', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(isPrivate ? { private_question_id: questionId } : { question_id: questionId }),
          attempt_id: attemptId ?? null,
          reason,
          note: note.trim() || undefined,
        }),
      });
      // 중복 신고(이미 접수)도 사용자에게는 성공으로 보인다 — 서버가 409 가 아니라
      // duplicate:true 로 돌려주는 이유다.
      setState(response.ok ? 'done' : 'error');
    } catch {
      setState('error');
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-2 text-xs text-[var(--color-muted)] underline underline-offset-2 hover:text-sage-800"
      >
        이 문항에 문제가 있나요?
      </button>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-[var(--color-border)] bg-white p-3">
      <div className="text-xs font-bold text-sage-800 mb-2">문항 오류 신고</div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {REPORT_REASONS.map((option) => (
          <button
            key={option.value}
            type="button"
            onClick={() => setReason(option.value)}
            className={`px-2 py-1 rounded-full text-xs border ${
              reason === option.value
                ? 'bg-sage-800 text-white border-sage-800'
                : 'bg-white text-sage-800 border-[var(--color-border)]'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 1000))}
        placeholder="어떤 점이 문제인지 적어주시면 검토에 큰 도움이 됩니다. (선택)"
        rows={2}
        className="w-full text-xs border border-[var(--color-border)] rounded-md p-2 mb-2"
      />
      {state === 'error' && (
        <div className="text-xs text-red-600 mb-2">신고를 보내지 못했습니다. 잠시 후 다시 시도해주세요.</div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          disabled={!reason || state === 'sending'}
          onClick={submit}
          className="px-3 py-1 rounded-md text-xs bg-sage-800 text-white disabled:opacity-50"
        >
          {state === 'sending' ? '보내는 중…' : '신고'}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="px-3 py-1 rounded-md text-xs border border-[var(--color-border)] text-sage-800"
        >
          취소
        </button>
      </div>
    </div>
  );
}
