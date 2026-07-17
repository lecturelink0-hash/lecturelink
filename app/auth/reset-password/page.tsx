'use client';

/**
 * 비밀번호 재설정 — 이메일 링크(복구 세션) 클릭 후 새 비밀번호 설정.
 * /auth/callback 에서 recovery 토큰을 세션으로 교환한 뒤 이 페이지로 온다.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createBrowserClient } from '@/lib/db/browser';
import { CheckCircle, AlertCircle } from 'lucide-react';

export default function ResetPasswordPage() {
  const [ready, setReady] = useState<'checking' | 'ok' | 'no-session'>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'done' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  useEffect(() => {
    const supabase = createBrowserClient();
    let settled = false;
    const done = () => { if (!settled) { settled = true; setReady('ok'); } };
    // 복구 세션은 URL 토큰(해시/코드) 감지 후 비동기로 성립 → 이벤트와 초기 조회를 함께 대기.
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) done();
    });
    supabase.auth.getSession().then(({ data }) => { if (data.session) done(); });
    const timer = setTimeout(() => { if (!settled) setReady('no-session'); }, 5000);
    return () => { sub.subscription.unsubscribe(); clearTimeout(timer); };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    if (password.length < 8) {
      setErrorMsg('비밀번호는 8자 이상이어야 합니다.');
      return;
    }
    if (password !== confirm) {
      setErrorMsg('비밀번호가 일치하지 않습니다.');
      return;
    }
    setStatus('saving');
    const supabase = createBrowserClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setStatus('error');
      setErrorMsg('비밀번호 변경에 실패했습니다. 링크가 만료되었을 수 있어요.');
      return;
    }
    setStatus('done');
    setTimeout(() => { window.location.href = '/dashboard'; }, 1500);
  }

  return (
    <div className="ll-auth-page shell">
      <header className="header">
        <div className="header-inner">
          <Link href="/" className="logo">
            <span className="logo-text">Lecturelink</span>
          </Link>
          <Link href="/login" className="header-link">로그인</Link>
        </div>
      </header>
      <main className="grid place-items-center px-4 py-16">
        <div className="w-full max-w-md rounded-2xl border border-[var(--color-border)] bg-white p-8 shadow-sm">
          <h1 className="text-xl font-bold text-sage-800 mb-2">비밀번호 재설정</h1>

          {ready === 'checking' && (
            <p className="text-sm text-[var(--color-muted)] py-6 text-center">확인 중…</p>
          )}

          {ready === 'no-session' && (
            <div className="text-center py-4">
              <AlertCircle className="w-12 h-12 text-[var(--color-warn)] mx-auto mb-4" strokeWidth={1.5} />
              <p className="text-sm text-[var(--color-muted)] leading-relaxed">
                재설정 링크가 유효하지 않거나 만료되었습니다.<br />로그인 화면에서 다시 요청해 주세요.
              </p>
              <Link href="/login" className="inline-block mt-5 text-sm font-semibold text-sage-700 underline">
                로그인으로 이동
              </Link>
            </div>
          )}

          {ready === 'ok' && status === 'done' && (
            <div className="text-center py-4">
              <CheckCircle className="w-12 h-12 text-sage-700 mx-auto mb-4" strokeWidth={1.5} />
              <p className="text-sm text-sage-800">비밀번호가 변경되었습니다. 잠시 후 이동합니다…</p>
            </div>
          )}

          {ready === 'ok' && status !== 'done' && (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-[var(--color-muted)] mb-2">새 비밀번호를 입력해 주세요.</p>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="새 비밀번호 (8자 이상)"
                className="w-full h-12 rounded-lg border border-[var(--color-border)] px-4 text-sm outline-none focus:border-[var(--color-primary)]"
              />
              <input
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="새 비밀번호 확인"
                className="w-full h-12 rounded-lg border border-[var(--color-border)] px-4 text-sm outline-none focus:border-[var(--color-primary)]"
              />
              {errorMsg && <p className="text-sm text-[var(--color-warn)]">{errorMsg}</p>}
              <button
                type="submit"
                disabled={status === 'saving'}
                className="w-full h-12 rounded-lg bg-[var(--color-primary)] text-white font-bold disabled:opacity-50"
              >
                {status === 'saving' ? '변경 중…' : '비밀번호 변경'}
              </button>
            </form>
          )}
        </div>
      </main>
    </div>
  );
}
