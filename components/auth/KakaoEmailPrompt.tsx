'use client';

/**
 * 카카오(합성 이메일) 사용자에게 실제 이메일 등록을 유도한다.
 *  - 첫 진입(온보딩 유도): 이메일 등록 모달(건너뛰기 가능)
 *  - 이후 방문: 하루 최초 1회 상단 배너(닫기 가능)
 * 실제 이메일이 이미 있거나, 등록 요청을 한 사용자에게는 표시하지 않는다.
 */
import { useEffect, useState } from 'react';
import { createBrowserClient } from '@/lib/db/browser';
import { Mail, X } from 'lucide-react';

const SYNTHETIC_SUFFIX = '@kakao.users.lecturelink.kro.kr';
const K_SKIPPED = 'll_email_prompt_dismissed'; // 모달 건너뛰기함
const K_BANNER = 'll_email_banner_date';       // 배너 닫은 날짜(YYYY-MM-DD)
const K_PENDING = 'll_email_pending';          // 등록 요청 완료(재유도 중단)

type Mode = 'none' | 'interstitial' | 'banner';

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

export function KakaoEmailPrompt() {
  const [mode, setMode] = useState<Mode>('none');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    createBrowserClient().auth.getUser().then(({ data }) => {
      const addr = data.user?.email ?? '';
      if (!addr.endsWith(SYNTHETIC_SUFFIX)) return;              // 카카오 합성 이메일만
      if (localStorage.getItem(K_PENDING)) return;               // 이미 등록 요청함
      if (!localStorage.getItem(K_SKIPPED)) { setMode('interstitial'); return; }
      if (localStorage.getItem(K_BANNER) !== todayKey()) setMode('banner');
    }).catch(() => {});
  }, []);

  async function register() {
    const em = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) {
      setError('올바른 이메일 주소를 입력해 주세요.');
      return;
    }
    if (em.endsWith(SYNTHETIC_SUFFIX)) {
      setError('사용할 수 없는 주소입니다.');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const supabase = createBrowserClient();
      const { error: e } = await supabase.auth.updateUser(
        { email: em },
        { emailRedirectTo: `${window.location.origin}/auth/callback` },
      );
      if (e) {
        setError(e.message.includes('registered') ? '이미 사용 중인 이메일입니다.' : '이메일 등록에 실패했습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }
      localStorage.setItem(K_PENDING, '1'); // 등록 요청 후 재유도 중단
      setSent(true);
    } finally {
      setSubmitting(false);
    }
  }

  function skipInterstitial() {
    localStorage.setItem(K_SKIPPED, '1');
    setMode('none');
  }
  function dismissBanner() {
    localStorage.setItem(K_BANNER, todayKey());
    setMode('none');
  }

  if (mode === 'none') return null;

  // ── 상단 배너 ──
  if (mode === 'banner') {
    return (
      <div className="mb-5 flex items-center gap-3 rounded-[var(--radius-md)] border border-[var(--color-primary)] bg-[var(--color-sage-50)] px-4 py-3">
        <Mail className="h-5 w-5 shrink-0 text-[var(--color-primary)]" />
        <p className="min-w-0 flex-1 text-sm text-[var(--color-text)]">
          카카오로 가입하셨어요. <b>이메일을 등록</b>하면 비밀번호 재설정·중요 알림을 받을 수 있어요.
        </p>
        <button
          type="button"
          onClick={() => { setError(''); setEmail(''); setSent(false); setMode('interstitial'); }}
          className="shrink-0 rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-sm font-bold text-white"
        >
          등록하기
        </button>
        <button type="button" onClick={dismissBanner} aria-label="닫기" className="shrink-0 text-[var(--color-muted)] hover:text-[var(--color-text)]">
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  // ── 첫 진입 유도 모달 ──
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-7 shadow-xl">
        <div className="mb-4 flex items-start gap-3">
          <span className="ll-chip" style={{ width: '2.75rem', height: '2.75rem' }}>
            <Mail className="h-5 w-5" strokeWidth={2} />
          </span>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-sage-800">이메일을 등록해 주세요</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)] leading-relaxed">
              카카오로 가입하셨어요. 비밀번호 재설정·중요 알림 메일을 받으려면 이메일을 등록해 주세요. (선택 사항)
            </p>
          </div>
        </div>

        {sent ? (
          <div className="rounded-lg bg-[var(--color-sage-100)] px-4 py-3 text-sm text-sage-800 leading-relaxed">
            입력하신 주소로 <b>확인 메일</b>을 보냈습니다. 메일의 링크를 누르면 등록이 완료됩니다.
            <br />몇 분 내에 오지 않으면 <b>스팸함</b>도 확인해 주세요.
            <div className="mt-4 text-right">
              <button type="button" onClick={() => setMode('none')} className="text-sm font-semibold text-sage-700 underline">
                닫기
              </button>
            </div>
          </div>
        ) : (
          <>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="이메일 주소 입력"
              className="mb-3 h-12 w-full rounded-lg border border-[var(--color-border)] px-4 text-base outline-none focus:border-sage-600"
            />
            {error && <p className="mb-3 text-sm text-[var(--color-warn)]">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={skipInterstitial}
                className="h-12 flex-1 rounded-lg border border-[var(--color-border)] font-semibold text-[var(--color-muted)] hover:bg-[var(--color-sage-100)]"
              >
                나중에 하기
              </button>
              <button
                type="button"
                onClick={register}
                disabled={submitting || !email.trim()}
                className="h-12 flex-1 rounded-lg bg-[var(--color-primary)] font-bold text-white disabled:opacity-50"
              >
                {submitting ? '등록 중…' : '이메일 등록'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
