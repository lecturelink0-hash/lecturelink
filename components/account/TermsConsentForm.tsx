'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AlertCircle, BookOpen, CheckCircle2, ExternalLink, FileText, ShieldCheck } from 'lucide-react';
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
    <div className="legal-consent-page">
      <header className="legal-consent-header">
        <div className="legal-consent-header-inner">
          <Link href="/" className="legal-consent-logo" aria-label="LectureLink 홈으로">
            <span><BookOpen aria-hidden="true" /></span>
            <b>LectureLink</b>
          </Link>
        </div>
      </header>

      <main className="legal-consent-main">
        <section className="legal-consent-card" aria-labelledby="legal-consent-title">
          <div className="legal-consent-copy">
            <h1 id="legal-consent-title">최신 이용약관에 동의해 주세요</h1>
            <p>서비스를 계속 이용하기 전에 현재 적용되는 이용약관을 확인해 주세요. 개인정보처리방침도 함께 확인할 수 있습니다.</p>
          </div>

          <nav className="legal-document-list" aria-label="약관 문서">
            <Link href="/terms" target="_blank" rel="noreferrer">
              <FileText aria-hidden="true" />
              <span><b>이용약관 전문</b><small>새 창에서 확인</small></span>
              <ExternalLink aria-hidden="true" />
            </Link>
            <Link href="/privacy" target="_blank" rel="noreferrer">
              <ShieldCheck aria-hidden="true" />
              <span><b>개인정보처리방침</b><small>새 창에서 확인</small></span>
              <ExternalLink aria-hidden="true" />
            </Link>
          </nav>

          <label className="legal-consent-check">
            <input
              type="checkbox"
              checked={accepted}
              disabled={saving}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span><b>이용약관 동의 (필수)</b><small>버전 {TERMS_VERSION} 이용약관에 동의합니다.</small></span>
          </label>

          {error && (
            <p role="alert" className="legal-consent-error">
              <AlertCircle aria-hidden="true" />
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={submit}
            disabled={!accepted || saving}
            aria-busy={saving}
            className="legal-consent-submit"
          >
            <CheckCircle2 aria-hidden="true" />
            {saving ? '동의 내역 저장 중...' : '동의하고 계속하기'}
          </button>
        </section>
      </main>
    </div>
  );
}
