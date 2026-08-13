'use client';

import { useEffect, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { AlertCircle, BookOpen, Mail, Lock, CheckCircle } from 'lucide-react';
import { createBrowserClient } from '@/lib/db/browser';
import { authErrorMessage, isExistingAccountError } from '@/lib/auth/auth-error-message';
import {
  isValidPassword,
  PASSWORD_ERROR,
  PASSWORD_HINT,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '@/lib/auth/password-policy';
import { Button } from '@/components/ui/Button';
import loginBrandVisual from '@/public/login-brand-visual.png';

type Mode = 'login' | 'signup';
type AccountType = 'student' | 'professor';

/** 인증 성공 후 이동할 경로 — 보호 경로에서 왔으면 next, 아니면 루트에서 계정 유형별 홈을 판별한다. */
function postAuthDest(): string {
  if (typeof window === 'undefined') return '/';
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('/login')) return next;
  return '/';
}

export default function LoginPage() {
  const [mode, setMode] = useState<Mode>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [accountType, setAccountType] = useState<AccountType>('student');
  const [emailOpen, setEmailOpen] = useState(false);
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  // 랜딩의 "무료체험" CTA 등에서 /login?mode=signup 으로 오면 가입 탭을 기본 선택.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    if (params.get('mode') === 'signup') {
      setMode('signup');
    }
    const authError = params.get('error');
    if (authError) {
      setErrorMsg(
        authError === 'kakao_denied'
          ? '카카오 로그인이 취소되었습니다.'
          : authError === 'callback_failed'
            ? '인증 링크가 만료되었거나 이미 사용되었습니다. 다시 시도해 주세요.'
            : '카카오 로그인 연결을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.',
      );
      const cleanUrl = new URL(window.location.href);
      cleanUrl.searchParams.delete('error');
      window.history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}${cleanUrl.hash}`);
    }
  }, []);

  function switchMode(next: Mode) {
    setMode(next);
    setErrorMsg('');
    setStatus('idle');
    setPassword('');
    setConfirm('');
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');

    if (mode === 'signup') {
      if (!isValidPassword(password)) {
        setErrorMsg(PASSWORD_ERROR);
        return;
      }
      if (password !== confirm) {
        setErrorMsg('비밀번호가 일치하지 않습니다.');
        return;
      }
    }

    setStatus('sending');
    const supabase = createBrowserClient();
    const submittedEmail = email.trim();
    if (submittedEmail !== email) setEmail(submittedEmail);

    if (mode === 'signup') {
      try {
        const { data, error } = await supabase.auth.signUp({
          email: submittedEmail,
          password,
          options: {
            data: { requested_account_type: accountType },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        });

        // 가입 여부를 화면에서 구분하면 계정 존재 여부를 수집할 수 있다.
        // 기가입 주소도 신규 가입과 같은 안내 화면으로 보낸다.
        if (error) {
          if (isExistingAccountError(error)) {
            setStatus('sent');
            return;
          }
          setStatus('error');
          setErrorMsg(authErrorMessage(error));
          return;
        }

        if (data.session) {
          window.location.href = postAuthDest();
        } else {
          setStatus('sent');
        }
      } catch {
        setStatus('error');
        setErrorMsg('연결이 원활하지 않아 가입 요청을 보내지 못했습니다. 잠시 후 다시 시도해 주세요.');
      }
      return;
    }

    // 로그인
    try {
      const { error } = await supabase.auth.signInWithPassword({ email: submittedEmail, password });
      if (error) {
        setStatus('error');
        setErrorMsg(authErrorMessage(error));
        return;
      }
      window.location.href = postAuthDest();
    } catch {
      setStatus('error');
      setErrorMsg('연결이 원활하지 않아 로그인하지 못했습니다. 잠시 후 다시 시도해 주세요.');
    }
  }

  const [forgotState, setForgotState] = useState<'idle' | 'sending' | 'sent'>('idle');
  async function handleForgot() {
    const submittedEmail = email.trim();
    if (!submittedEmail) {
      setErrorMsg('먼저 이메일을 입력해 주세요.');
      return;
    }
    setErrorMsg('');
    setForgotState('sending');
    try {
      const supabase = createBrowserClient();
      // 재설정 페이지로 직접 리다이렉트 — 클라이언트가 URL 토큰(해시/코드)을 자동 감지해 복구 세션 성립.
      const { error } = await supabase.auth.resetPasswordForEmail(submittedEmail, {
        redirectTo: `${window.location.origin}/auth/reset-password`,
      });
      if (error) throw error;
      setForgotState('sent');
    } catch (error) {
      setForgotState('idle');
      setErrorMsg(authErrorMessage(error));
    }
  }

  const [resendState, setResendState] = useState<'idle' | 'sending' | 'done'>('idle');
  async function handleResend() {
    const submittedEmail = email.trim();
    if (!submittedEmail || resendState === 'sending') return;
    setResendState('sending');
    setErrorMsg('');
    try {
      const supabase = createBrowserClient();
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email: submittedEmail,
        options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
      });
      if (error) throw error;
      setResendState('done');
    } catch (error) {
      setResendState('idle');
      setErrorMsg(authErrorMessage(error));
    }
  }

  function handleKakao() {
    setErrorMsg('');
    setStatus('sending');
    if (mode === 'signup') {
      document.cookie = `lecturelink_account_type=${accountType}; Path=/; Max-Age=600; SameSite=Lax`;
    }
    // Supabase 내장 카카오 provider 는 account_email 을 강제 요청해 KOE205 를 유발한다(비즈앱 필요).
    // 이메일을 요구하지 않는 커스텀 카카오 로그인(/api/auth/kakao/start)으로 개시한다.
    const next = new URLSearchParams(window.location.search).get('next');
    const q = next && next.startsWith('/') && !next.startsWith('/login') ? `?next=${encodeURIComponent(next)}` : '';
    window.location.href = `/api/auth/kakao/start${q}`;
  }

  return (
    <div className="ll-auth-page shell">
      <header className="header">
        <div className="header-inner">
          {/* 루트는 미인증 시 정적 랜딩(rewrite) — RSC 프리페치 대상이 아니므로 일반 앵커로 문서 내비게이션 */}
          <Link href="/" className="logo">
            <span className="logo-mark"><BookOpen className="icon" /></span>
            <span className="logo-text">Lecturelink</span>
          </Link>
          <Link href="/" className="header-link">홈으로</Link>
        </div>
      </header>

      <main style={{ placeItems: 'start center' }}>
        <section className="auth-wrap" aria-label="LectureLink 통합 로그인">
          <div className="intro">
            <div className="brand-copy-sr-only">
              <h1>
                <span>의학 교육의 흐름을</span><br />
                하나로 연결합니다
              </h1>
              <p className="lead">
                LectureLink는 수업 준비부터 문제 풀이와 복습까지,<br className="desktop-break" />
                의학 교육의 전 과정을 한 흐름으로 연결합니다.
              </p>
            </div>

            <Image
              src={loginBrandVisual}
              alt="학생과 교수를 위한 의학 교육 플랫폼. 의학 교육의 흐름을 하나로 연결합니다. 손을 들어 인사하는 CPX 환자 캐릭터 주변에 강의자료, 문제 생성, 학습 분석, 복습 완료가 하나의 흐름으로 연결되어 있습니다."
              className="brand-reference-image"
              sizes="(max-width: 900px) calc(100vw - 36px), 636px"
              priority
            />
          </div>

      <div className="login-column">

        {/* Card */}
        <section className="auth-card">
          <div className="card-head">
            <h2>LectureLink 로그인</h2>
            <p>학생과 교수 모두 LectureLink에서 시작하세요.</p>
          </div>
          {!emailOpen && status !== 'sent' && errorMsg && (
            <div role="alert" aria-live="polite" className="mb-5 flex items-start gap-2.5 rounded-lg bg-[var(--color-warn-bg)] p-3.5 text-sm leading-relaxed text-[var(--color-warn)]">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{errorMsg}</span>
            </div>
          )}
          {!emailOpen && status !== 'sent' && (
            <>
              <button
                type="button"
                onClick={handleKakao}
                disabled={status === 'sending'}
                className="kakao"
              >
                <svg width="19" height="19" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path fill="#191600" d="M9 1.5C4.86 1.5 1.5 4.13 1.5 7.38c0 2.1 1.4 3.94 3.5 4.98-.15.53-.56 1.99-.64 2.3-.1.38.14.38.3.27.12-.08 1.95-1.32 2.74-1.86.39.06.79.08 1.2.08 4.14 0 7.5-2.63 7.5-5.87C16.5 4.13 13.14 1.5 9 1.5Z" /></svg>
                카카오로 계속하기
              </button>

              <div className="login-divider" aria-hidden="true">
                <span />
                <b>또는</b>
                <span />
              </div>

              <button type="button" onClick={() => { switchMode('login'); setEmailOpen(true); }} className="email-entry">
                <Mail aria-hidden="true" />
                이메일로 로그인
              </button>

              <p className="signup-entry">
                처음이신가요?
                <button type="button" onClick={() => { switchMode('signup'); setEmailOpen(true); }}>회원가입</button>
              </p>

              <p className="terms">계속 진행하면 <Link href="/terms">이용약관</Link> 및 <Link href="/privacy">개인정보 처리방침</Link>에 동의한 것으로 간주됩니다.</p>
            </>
          )}

          {(emailOpen || status === 'sent') && (
          <div>
          {status === 'sent' ? (
            <div className="text-center py-6">
              <CheckCircle className="w-14 h-14 text-sage-700 mx-auto mb-5" strokeWidth={1.5} />
              <h2 className="text-xl font-bold text-sage-800 mb-3">가입 요청을 확인해 주세요</h2>
              <p className="text-base text-[var(--color-muted)] mb-1">
                <span className="font-semibold text-sage-800">{email}</span> 로
              </p>
              <p className="text-base text-[var(--color-muted)] leading-relaxed">
                가입 가능한 이메일이라면 인증 메일을 보내드립니다. 메일 안의 링크를 누르면 가입이 완료됩니다.
              </p>
              <div className="mt-4 rounded-lg bg-[var(--color-sage-100)] px-4 py-3 text-sm text-sage-800 leading-relaxed">
                메일이 몇 분 내에 오지 않으면 <b>스팸함·프로모션함</b>을 확인하거나 로그인을 시도해 보세요.
                발신: <b>렉처링크 &lt;fornerdsofficial@gmail.com&gt;</b>
              </div>
              {errorMsg && (
                <div role="alert" aria-live="polite" className="mt-4 flex items-start gap-2.5 rounded-lg bg-[var(--color-warn-bg)] p-3.5 text-left text-sm leading-relaxed text-[var(--color-warn)]">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{errorMsg}</span>
                </div>
              )}
              <div className="mt-5 flex flex-col items-center gap-2">
                <button
                  onClick={handleResend}
                  disabled={resendState === 'sending'}
                  className="text-sm font-semibold text-sage-700 underline disabled:opacity-50"
                >
                  {resendState === 'sending' ? '재전송 중…' : resendState === 'done' ? '인증 메일을 다시 보냈어요' : '인증 메일 다시 보내기'}
                </button>
                <button
                  onClick={() => { switchMode('login'); setEmailOpen(false); }}
                  className="text-sm text-[var(--color-muted)] underline"
                >
                  로그인으로 돌아가기
                </button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit}>
              {/* 탭 토글 */}
              <div className="flex bg-[var(--color-sage-100)] rounded-lg p-1 mb-6">
                <button
                  type="button"
                  onClick={() => switchMode('login')}
                  className={`flex-1 h-11 rounded-md text-sm font-semibold transition-colors ${
                    mode === 'login' ? 'bg-white text-sage-800 shadow-sm' : 'text-[var(--color-muted)]'
                  }`}
                >
                  로그인
                </button>
                <button
                  type="button"
                  onClick={() => switchMode('signup')}
                  className={`flex-1 h-11 rounded-md text-sm font-semibold transition-colors ${
                    mode === 'signup' ? 'bg-white text-sage-800 shadow-sm' : 'text-[var(--color-muted)]'
                  }`}
                >
                  회원가입
                </button>
              </div>

              <p className="text-base text-[var(--color-muted)] mb-6 leading-relaxed">
                {mode === 'login'
                  ? '이메일과 비밀번호로 로그인하세요.'
                  : '가입 유형을 선택하세요.'}
              </p>

              <label className="block text-sm font-semibold text-sage-800 mb-2">이메일</label>
              <div className="relative mb-5">
                <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-muted)]" />
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                  autoComplete="email"
                  maxLength={254}
                  aria-invalid={Boolean(errorMsg)}
                  aria-describedby={errorMsg ? 'auth-error' : undefined}
                  disabled={status === 'sending'}
                  className="w-full h-12 pl-11 pr-3.5 rounded-lg border border-[var(--color-border)] focus:border-sage-600 focus:outline-none text-base"
                  placeholder="you@school.ac.kr"
                />
              </div>

              <label className="block text-sm font-semibold text-sage-800 mb-2">비밀번호</label>
              <div className="relative mb-5">
                <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-muted)]" />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={mode === 'signup' ? PASSWORD_MIN_LENGTH : undefined}
                  maxLength={PASSWORD_MAX_LENGTH}
                  pattern={mode === 'signup' ? `(?=.*[A-Za-z]).{${PASSWORD_MIN_LENGTH},${PASSWORD_MAX_LENGTH}}` : undefined}
                  title={mode === 'signup' ? PASSWORD_ERROR : undefined}
                  aria-invalid={Boolean(errorMsg)}
                  aria-describedby={errorMsg ? 'auth-error' : undefined}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  disabled={status === 'sending'}
                  className="w-full h-12 pl-11 pr-3.5 rounded-lg border border-[var(--color-border)] focus:border-sage-600 focus:outline-none text-base"
                  placeholder={mode === 'signup' ? PASSWORD_HINT : '비밀번호'}
                />
              </div>

              {mode === 'signup' && (
                <>
                  <label className="block text-sm font-semibold text-sage-800 mb-2">비밀번호 확인</label>
                  <div className="relative mb-5">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-muted)]" />
                    <input
                      type="password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      required
                      minLength={PASSWORD_MIN_LENGTH}
                      maxLength={PASSWORD_MAX_LENGTH}
                      aria-invalid={Boolean(errorMsg)}
                      aria-describedby={errorMsg ? 'auth-error' : undefined}
                      autoComplete="new-password"
                      disabled={status === 'sending'}
                      className="w-full h-12 pl-11 pr-3.5 rounded-lg border border-[var(--color-border)] focus:border-sage-600 focus:outline-none text-base"
                      placeholder="비밀번호 다시 입력"
                    />
                  </div>
                  <fieldset className="mb-5">
                    <legend className="block text-sm font-semibold text-sage-800 mb-2">가입 유형</legend>
                    <div className="grid grid-cols-2 gap-2" role="group" aria-label="가입 유형">
                      {([['student', '학생', '문제풀이와 복습'], ['professor', '교수', '수업과 형성평가']] as const).map(([value, label, description]) => (
                        <button key={value} type="button" onClick={() => setAccountType(value)} aria-pressed={accountType === value} className={`min-h-16 rounded-lg border px-3 py-2 text-left transition-colors ${accountType === value ? 'border-sage-600 bg-[var(--color-sage-100)] text-sage-800' : 'border-[var(--color-border)] bg-white text-[var(--color-muted)]'}`}>
                          <strong className="block text-sm">{label}</strong>
                          <span className="block mt-0.5 text-xs">{description}</span>
                        </button>
                      ))}
                    </div>
                    {accountType === 'professor' && (
                      <p className="mt-2 text-xs leading-relaxed text-sage-700">
                        교수 계정으로 가입하면 인증 완료 후 교수 도구로 바로 이동합니다.
                      </p>
                    )}
                  </fieldset>
                </>
              )}

              {errorMsg && (
                <div id="auth-error" role="alert" aria-live="polite" className="flex items-start gap-2.5 text-sm leading-relaxed text-[var(--color-warn)] bg-[var(--color-warn-bg)] rounded-lg p-3.5 mb-5">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <Button type="submit" fullWidth size="lg" loading={status === 'sending'}>
                {status === 'sending'
                  ? '처리 중...'
                  : mode === 'login'
                    ? '로그인'
                    : '회원가입'}
              </Button>

              {mode === 'login' && (
                <div className="mt-3 text-center">
                  {forgotState === 'sent' ? (
                    <p className="text-[13px] text-[var(--color-muted)] leading-relaxed">
                      입력한 이메일이 등록된 계정이라면 재설정 메일을 보내드립니다.
                      <br />안 보이면 <b>스팸함</b>도 확인해 주세요.
                    </p>
                  ) : (
                    <button
                      type="button"
                      onClick={handleForgot}
                      disabled={forgotState === 'sending'}
                      className="text-[13px] text-[var(--color-muted)] underline underline-offset-2 hover:text-sage-800 disabled:opacity-50"
                    >
                      {forgotState === 'sending' ? '메일 보내는 중…' : '비밀번호를 잊으셨나요?'}
                    </button>
                  )}
                </div>
              )}

              {/* 구분선 */}
              <div className="flex items-center gap-3 my-6">
                <div className="h-px flex-1 bg-[var(--color-sage-200)]" />
                <span className="text-sm text-[var(--color-muted)]">또는</span>
                <div className="h-px flex-1 bg-[var(--color-sage-200)]" />
              </div>

              {/* 카카오 로그인 */}
              <button
                type="button"
                onClick={handleKakao}
                disabled={status === 'sending'}
                className="w-full flex items-center justify-center gap-2 rounded-lg bg-[#FEE500] text-[#191600] text-base font-semibold h-12 transition hover:brightness-95 disabled:opacity-60"
              >
                <svg width="20" height="20" viewBox="0 0 18 18" fill="none" aria-hidden="true">
                  <path
                    fill="#191600"
                    d="M9 1.5C4.86 1.5 1.5 4.13 1.5 7.38c0 2.1 1.4 3.94 3.5 4.98-.15.53-.56 1.99-.64 2.3-.1.38.14.38.3.27.12-.08 1.95-1.32 2.74-1.86.39.06.79.08 1.2.08 4.14 0 7.5-2.63 7.5-5.87C16.5 4.13 13.14 1.5 9 1.5Z"
                  />
                </svg>
                {mode === 'signup' ? '카카오로 시작하기' : '카카오로 로그인'}
              </button>

              <p className="text-sm text-[var(--color-muted)] text-center mt-6 leading-relaxed">
                계속 진행하면 <a href="/terms" className="underline">이용약관</a> 및{' '}
                <a href="/privacy" className="underline">개인정보 처리방침</a>에 동의하는 것으로 간주됩니다.
              </p>
            </form>
          )}
          </div>
          )}
        </section>
      </div>
        </section>
      </main>
      <footer className="site-footer">
        <div className="footer-inner">
          <p className="m-0">Lecturelink는 학습 보조 도구이며, 생성된 문항과 해설은 검토 후 활용해주세요.</p>
          <div className="footer-links"><Link href="/terms">이용약관</Link><Link href="/privacy">개인정보처리방침</Link><Link href="/contact">문의하기</Link></div>
        </div>
      </footer>
    </div>
  );
}
