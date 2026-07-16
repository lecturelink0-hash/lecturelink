'use client';

import { useState } from 'react';
import { Mail, Stethoscope } from 'lucide-react';
import { api, ApiError } from '@/lib/api/client';
import { Button } from '@/components/ui/Button';

export function CompleteEmailForm({ displayName }: { displayName: string | null }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'saving' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setErrorMsg('');
    setStatus('saving');
    try {
      await api.post('/api/me/email', { email: email.trim() });
      // 이메일 저장 완료 → 세션 갱신 위해 전체 이동
      window.location.href = '/dashboard';
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof ApiError ? err.message : '이메일 저장에 실패했습니다. 다시 시도해주세요.');
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] px-6 py-16">
      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2.5 mb-3">
            <Stethoscope className="w-7 h-7 text-sage-700" strokeWidth={2.2} />
            <h1 className="text-2xl font-bold text-sage-700">렉처링크</h1>
          </div>
          <h2 className="text-[1.35rem] font-bold text-sage-800 mt-6 tracking-[-0.02em]">
            이메일을 입력해주세요
          </h2>
          <p className="mt-2 text-[15px] text-[var(--color-muted)] leading-relaxed">
            {displayName ? `${displayName}님, ` : ''}학습 기록 저장과 알림을 위해 이메일이 필요해요.
          </p>
        </div>

        <form onSubmit={submit} className="ll-card p-6">
          <label className="block text-sm font-semibold text-sage-800 mb-2">이메일</label>
          <div className="relative">
            <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--color-muted)]" strokeWidth={2} />
            <input
              type="email"
              required
              autoFocus
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@school.ac.kr"
              className="w-full h-12 pl-10 pr-3 rounded-[12px] border border-[var(--color-border)] bg-white text-[15px] text-sage-800 placeholder:text-[var(--color-muted)] focus:outline-none focus:border-sage-400 transition-colors"
            />
          </div>

          {errorMsg && (
            <p className="mt-3 text-[13px] text-[var(--color-warn)]">{errorMsg}</p>
          )}

          <Button
            type="submit"
            variant="primary"
            size="lg"
            fullWidth
            loading={status === 'saving'}
            className="mt-5"
          >
            계속하기
          </Button>
          <p className="text-[12px] text-[var(--color-muted)] text-center mt-3 leading-relaxed">
            입력하신 이메일은 계정 식별과 학습 알림에만 사용됩니다.
          </p>
        </form>
      </div>
    </div>
  );
}
