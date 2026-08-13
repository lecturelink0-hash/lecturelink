'use client';

import { ArrowLeft } from 'lucide-react';

export function LegalBackButton() {
  function goBack() {
    const referrer = document.referrer;

    if (referrer) {
      const previousUrl = new URL(referrer);
      if (previousUrl.origin === window.location.origin) {
        window.history.back();
        return;
      }
    }

    window.location.assign('/');
  }

  return (
    <button type="button" className="legal-back-link" onClick={goBack}>
      <ArrowLeft aria-hidden="true" />
      뒤로가기
    </button>
  );
}
