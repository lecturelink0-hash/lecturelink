'use client';

/**
 * 비밀번호 재설정 — 이메일 링크(복구 세션) 클릭 후 새 비밀번호 설정.
 * 로그인 페이지와 동일한 ll-auth-page / auth-card 디자인을 사용한다.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { createBrowserClient } from '@/lib/db/browser';
import { Button } from '@/components/ui/Button';
import { BookOpen, CheckCircle, AlertCircle } from 'lucide-react';

const inputClass =
  'w-full h-12 px-4 rounded-lg border border-[var(--color-border)] focus:border-sage-600 focus:outline-none text-base';

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

    async function init() {
      if (typeof window !== 'undefined' && window.location.hash.includes('access_token')) {
        const params = new URLSearchParams(window.location.hash.slice(1));
        const access_token = params.get('access_token');
        const refresh_token = params.get('refresh_token');
        if (access_token && refresh_token) {
          const { error } = await supabase.auth.setSession({ access_token, refresh_token });
          window.history.replaceState(null, '', window.location.pathname);
          if (!error) { done(); return; }
        }
      }
      const { data } = await supabase.auth.getSession();
      if (data.session) done();
    }

    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      if (session) done();
    });
    init();
    const timer = setTimeout(() => { if (!settled) setReady('no-session'); }, 6000);
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
            <span className="logo-mark"><BookOpen className="icon" /></span>
            <span className="logo-text">Lecturelink</span>
          </Link>
          <Link href="/login" className="header-link">로그인</Link>
        </div>
      </header>

      <main>
        <div style={{ maxWidth: 440, margin: '0 auto', padding: '48px 20px' }}>
          <section className="auth-card">
            <div className="card-head">
              <h2>비밀번호 재설정</h2>
              {ready === 'ok' && status !== 'done' && <p>새 비밀번호를 입력해 주세요.</p>}
            </div>

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
              <form onSubmit={handleSubmit}>
                <label className="block text-sm font-semibold text-sage-800 mb-2">새 비밀번호</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="8자 이상"
                  className={`${inputClass} mb-5`}
                />
                <label className="block text-sm font-semibold text-sage-800 mb-2">새 비밀번호 확인</label>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="비밀번호 다시 입력"
                  className={`${inputClass} mb-5`}
                />
                {errorMsg && (
                  <div className="text-sm text-[var(--color-warn)] bg-[var(--color-warn-bg)] rounded-lg p-3.5 mb-5">
                    {errorMsg}
                  </div>
                )}
                <Button type="submit" fullWidth size="lg" loading={status === 'saving'}>
                  {status === 'saving' ? '변경 중…' : '비밀번호 변경'}
                </Button>
              </form>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}
