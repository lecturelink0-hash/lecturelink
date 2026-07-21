'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { BookOpen, Upload, ChartNoAxesCombined, Mail, Lock, CheckCircle } from 'lucide-react';
import { createBrowserClient } from '@/lib/db/browser';
import { authErrorMessage } from '@/lib/auth/auth-error-message';
import { Button } from '@/components/ui/Button';

type Mode = 'login' | 'signup';
type AccountType = 'student' | 'professor';

/** 인증 성공 후 이동할 경로 — 보호 경로에서 왔으면 next, 아니면 앱 홈(/dashboard). (/ 는 이제 랜딩) */
function postAuthDest(): string {
  if (typeof window === 'undefined') return '/dashboard';
  const next = new URLSearchParams(window.location.search).get('next');
  if (next && next.startsWith('/') && !next.startsWith('/login')) return next;
  return '/dashboard';
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
    if (typeof window !== 'undefined' &&
        new URLSearchParams(window.location.search).get('mode') === 'signup') {
      setMode('signup');
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
      if (password.length < 6) {
        setErrorMsg('비밀번호는 6자 이상이어야 합니다.');
        return;
      }
      if (password !== confirm) {
        setErrorMsg('비밀번호가 일치하지 않습니다.');
        return;
      }
    }

    setStatus('sending');
    const supabase = createBrowserClient();

    if (mode === 'signup') {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback`,
          data: { requested_account_type: accountType },
        },
      });
      if (error) {
        setStatus('error');
        setErrorMsg(authErrorMessage(error));
        return;
      }
      // 이미 가입된 이메일 — 이메일 확인이 켜진 경우 Supabase 는 보안상(이메일 존재
      // 노출 방지) 가짜 성공을 반환하되 identities 를 빈 배열로 돌려준다. 이걸로 중복 감지.
      if (data.user && (data.user.identities?.length ?? 0) === 0) {
        setStatus('error');
        setErrorMsg('이미 가입된 이메일입니다. 로그인해 주세요.');
        return;
      }
      // 이메일 확인이 켜져 있으면 session 이 없음 → 확인 메일 안내.
      // 꺼져 있으면 바로 세션 생성 → 홈으로.
      if (data.session) {
        window.location.href = '/';
      } else {
        setStatus('sent');
      }
      return;
    }

    // 로그인
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
      setStatus('error');
      setErrorMsg(authErrorMessage(error));
      return;
    }
    window.location.href = '/';
  }

  async function handleKakao() {
    setErrorMsg('');
    setStatus('sending');
    const supabase = createBrowserClient();
    if (mode === 'signup') {
      document.cookie = `lecturelink_account_type=${accountType}; Path=/; Max-Age=600; SameSite=Lax`;
    }
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'kakao',
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        // 주의: GoTrue 가 카카오 기본 scope(account_email·profile_image·profile_nickname)를 항상
        // 함께 요청하므로 여기서 이메일을 제거할 수 없다. KOE205 는 카카오 콘솔의 "동의항목"
        // (닉네임 필수 + 이메일 선택 동의 등)을 설정해야 해소된다. 아래 scopes 는 보강용.
        scopes: 'profile_nickname',
      },
    });
    // 성공 시 카카오로 리다이렉트되므로 이 아래는 실행되지 않는다.
    if (error) {
      setStatus('error');
      setErrorMsg(authErrorMessage(error));
    }
  }

  return (
    <div className="ll-auth-page shell">
      <header className="header">
        <div className="header-inner">
          <Link href="/" className="logo">
            <span className="logo-mark"><BookOpen className="icon" /></span>
            <span className="logo-text">Lecturelink</span>
          </Link>
          <Link href="/" className="header-link">홈으로</Link>
        </div>
      </header>

      <main>
        <section className="auth-wrap" aria-label="Lecturelink 카카오 로그인">
          <div className="intro">
            <span className="eyebrow">
              <CheckCircle className="icon" /> 의학 학습자를 위한 AI 문제 생성
            </span>
            <h1>
              강의자료를 올리면<br /><span>시험 대비</span>가 이어집니다
            </h1>
            <p className="lead">
              Lecturelink는 강의자료 분석, 예상문제 생성, 오답 복습을 한 흐름으로 연결해 학교 시험과 국가고시 대비를 돕습니다.
            </p>
            <div className="proofs">
              <div className="proof"><span className="proof-icon"><Upload className="icon" /></span><div><strong>강의자료 기반 문제 생성</strong><p>PDF와 수업자료를 바탕으로 단원별 문제를 만들 수 있습니다.</p></div></div>
              <div className="proof"><span className="proof-icon"><ChartNoAxesCombined className="icon" /></span><div><strong>오답과 취약 개념 분석</strong><p>틀린 문제를 모아 복습 우선순위와 추천 문제를 정리합니다.</p></div></div>
            </div>
          </div>

      <div>

        {/* Card */}
        <section className="auth-card">
          <div className="card-head">
            <h2>Lecturelink 로그인</h2>
            <p>카카오 계정으로 빠르게 접속하고 학습을 이어갈 수 있습니다.</p>
          </div>
          {!emailOpen && status !== 'sent' && (
            <>
              <div className="auth-note">
                <strong>간편 로그인으로 학습 기록을 이어갑니다</strong>
                카카오 로그인 후 업로드한 자료, 생성한 문제집, 오답 복습 기록을 한 계정에서 관리합니다.
              </div>
              <button
                type="button"
                onClick={handleKakao}
                disabled={status === 'sending'}
                className="kakao"
              >
                <svg width="19" height="19" viewBox="0 0 18 18" fill="none" aria-hidden="true"><path fill="#191600" d="M9 1.5C4.86 1.5 1.5 4.13 1.5 7.38c0 2.1 1.4 3.94 3.5 4.98-.15.53-.56 1.99-.64 2.3-.1.38.14.38.3.27.12-.08 1.95-1.32 2.74-1.86.39.06.79.08 1.2.08 4.14 0 7.5-2.63 7.5-5.87C16.5 4.13 13.14 1.5 9 1.5Z" /></svg>
                카카오로 로그인
              </button>
              <p className="terms">계속 진행하면 <Link href="/terms">이용약관</Link> 및 <Link href="/privacy">개인정보 처리방침</Link>에 동의한 것으로 간주됩니다.</p>
              <button type="button" onClick={() => setEmailOpen(true)} className="mt-5 w-full text-center text-[13px] font-semibold text-[#1f5c43] underline underline-offset-4">이메일로 로그인 또는 회원가입</button>
            </>
          )}

          {(emailOpen || status === 'sent') && (
          <div>
          {status === 'sent' ? (
            <div className="text-center py-6">
              <CheckCircle className="w-14 h-14 text-sage-700 mx-auto mb-5" strokeWidth={1.5} />
              <h2 className="text-xl font-bold text-sage-800 mb-3">메일을 확인해주세요</h2>
              <p className="text-base text-[var(--color-muted)] mb-1">
                <span className="font-semibold text-sage-800">{email}</span> 로
              </p>
              <p className="text-base text-[var(--color-muted)] leading-relaxed">
                인증 메일을 보냈습니다. 메일 안의 링크를 누르면 가입이 완료됩니다.
              </p>
              <button
                onClick={() => { switchMode('login'); setEmailOpen(false); }}
                className="text-sm text-sage-700 mt-6 underline"
              >
                로그인으로 돌아가기
              </button>
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
                  : '이메일로 가입하세요. 학교 이메일을 쓰면 학생 인증이 자동 적용됩니다.'}
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
                  minLength={6}
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  disabled={status === 'sending'}
                  className="w-full h-12 pl-11 pr-3.5 rounded-lg border border-[var(--color-border)] focus:border-sage-600 focus:outline-none text-base"
                  placeholder={mode === 'signup' ? '6자 이상' : '비밀번호'}
                />
              </div>

              {mode === 'signup' && (
                <>
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
                  </fieldset>
                  <label className="block text-sm font-semibold text-sage-800 mb-2">비밀번호 확인</label>
                  <div className="relative mb-5">
                    <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-[var(--color-muted)]" />
                    <input
                      type="password"
                      value={confirm}
                      onChange={(e) => setConfirm(e.target.value)}
                      required
                      autoComplete="new-password"
                      disabled={status === 'sending'}
                      className="w-full h-12 pl-11 pr-3.5 rounded-lg border border-[var(--color-border)] focus:border-sage-600 focus:outline-none text-base"
                      placeholder="비밀번호 다시 입력"
                    />
                  </div>
                </>
              )}

              {errorMsg && (
                <div className="text-sm text-[var(--color-warn)] bg-[var(--color-warn-bg)] rounded-lg p-3.5 mb-5">
                  {errorMsg}
                </div>
              )}

              <Button type="submit" fullWidth size="lg" loading={status === 'sending'}>
                {status === 'sending'
                  ? '처리 중...'
                  : mode === 'login'
                    ? '로그인'
                    : '회원가입'}
              </Button>

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
                카카오로 시작하기
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
