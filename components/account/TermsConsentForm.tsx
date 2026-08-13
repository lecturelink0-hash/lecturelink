'use client';

import { useState } from 'react';
import Link from 'next/link';
import { BookOpen, CheckCircle2 } from 'lucide-react';
import { TERMS_VERSION } from '@/lib/legal/config';

export function TermsConsentForm({ destination }: { destination: string }) {
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit() {
    if (!accepted || saving) return;
    setSaving(true);
    setError('');
    const response = await fetch('/api/me/legal-consents', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ documentType: 'terms', documentVersion: TERMS_VERSION }),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      setError(payload?.error?.message ?? '동의 내역을 저장하지 못했습니다.');
      setSaving(false);
      return;
    }
    window.location.replace(destination);
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-[var(--color-sage-50)] px-5 py-10">
      <section className="w-full max-w-lg rounded-3xl border border-[var(--color-border)] bg-white p-7 shadow-sm sm:p-9">
        <Link href="/" className="inline-flex items-center gap-2 text-lg font-bold text-sage-800"><BookOpen className="h-5 w-5" />LectureLink</Link>
        <div className="mt-7"><span className="ll-eyebrow">약관 확인</span><h1 className="mt-2 text-2xl font-bold text-sage-900">최신 이용약관에 동의해 주세요</h1><p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">서비스를 계속 이용하기 전에 현재 적용되는 약관을 확인합니다. 개인정보 처리 현황도 함께 확인할 수 있습니다.</p></div>
        <div className="mt-6 grid gap-2"><Link href="/terms" target="_blank" className="rounded-xl border border-[var(--color-border)] px-4 py-3 text-sm font-semibold text-sage-800 hover:bg-[var(--color-sage-50)]">이용약관 전문 보기</Link><Link href="/privacy" target="_blank" className="rounded-xl border border-[var(--color-border)] px-4 py-3 text-sm font-semibold text-sage-800 hover:bg-[var(--color-sage-50)]">개인정보처리방침 보기</Link></div>
        <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-xl bg-[var(--color-sage-50)] p-4 text-sm font-semibold leading-relaxed text-sage-900"><input type="checkbox" checked={accepted} onChange={(event) => setAccepted(event.target.checked)} className="mt-1 h-4 w-4 accent-sage-700" />버전 {TERMS_VERSION} 이용약관에 동의합니다. (필수)</label>
        {error && <p role="alert" className="mt-3 text-sm text-[var(--color-warn)]">{error}</p>}
        <button type="button" onClick={submit} disabled={!accepted || saving} className="mt-5 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-sage-700 font-bold text-white disabled:cursor-not-allowed disabled:opacity-50"><CheckCircle2 className="h-4 w-4" />{saving ? '저장 중...' : '동의하고 계속'}</button>
      </section>
    </main>
  );
}
