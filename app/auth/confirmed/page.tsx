'use client';

import { CheckCircle2, Stethoscope } from 'lucide-react';

/** 이메일 인증 완료 안내. 확인 메일의 링크 → /auth/callback → 여기로 이동. */
export default function EmailConfirmedPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--color-bg)] px-6 py-16">
      <div className="w-full max-w-md text-center">
        <div className="inline-flex items-center gap-2.5 mb-8">
          <Stethoscope className="w-7 h-7 text-sage-700" strokeWidth={2.2} />
          <span className="text-2xl font-bold text-sage-700">렉처링크</span>
        </div>
        <div className="flex justify-center mb-5">
          <span className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-[var(--color-curated-bg)] text-sage-700">
            <CheckCircle2 className="w-9 h-9" strokeWidth={2} />
          </span>
        </div>
        <h1 className="text-2xl font-bold text-sage-800 mb-2">이메일 인증이 완료됐어요</h1>
        <p className="text-[15px] text-[var(--color-muted)] leading-relaxed mb-8">
          이제 렉처링크를 이용할 수 있어요.
        </p>
        <a
          href="/dashboard"
          className="inline-flex items-center justify-center h-12 px-8 rounded-[14px] bg-sage-700 text-white font-bold hover:bg-sage-800 transition-colors"
        >
          시작하기
        </a>
      </div>
    </div>
  );
}
