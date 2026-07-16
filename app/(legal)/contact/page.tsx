import type { Metadata } from 'next';
import { MessageCircle, Mail } from 'lucide-react';

export const metadata: Metadata = { title: '문의하기 — 렉처링크' };

// 카카오톡 채널(플러스친구) 링크. 운영에서 채널을 만든 뒤 --env-file 에
// KAKAO_CHANNEL_URL 만 넣고 재시작하면 연결됨(재빌드 불필요, 런타임 env).
// (빌드타임 baked 되는 NEXT_PUBLIC 값도 폴백으로 허용.)
function channelUrl(): string {
  return (
    process.env.KAKAO_CHANNEL_URL ||
    process.env.NEXT_PUBLIC_KAKAO_CHANNEL_URL ||
    ''
  ).trim();
}

const SUPPORT_EMAIL = 'goodwood0202@gmail.com';

export default function ContactPage() {
  const kakao = channelUrl();

  return (
    <article className="text-sage-800">
      <h1 className="text-2xl font-bold mb-2">문의하기</h1>
      <p className="text-[15px] text-[var(--color-muted)] leading-relaxed mb-8">
        궁금한 점이나 불편한 점이 있으면 카카오톡으로 편하게 문의해 주세요. 보통 영업일 기준
        하루 안에 답변드립니다.
      </p>

      {/* 카카오톡 문의 CTA */}
      {kakao ? (
        <a
          href={kakao}
          target="_blank"
          rel="noreferrer"
          className="flex items-center justify-center gap-2.5 h-14 w-full rounded-[14px] bg-[#FEE500] text-[#191600] font-bold text-base hover:brightness-95 transition-[filter]"
        >
          <MessageCircle className="w-5 h-5" strokeWidth={2.2} />
          카카오톡으로 문의하기
        </a>
      ) : (
        <div className="rounded-[14px] border border-[var(--color-border)] bg-white p-5">
          <div className="flex items-center gap-2.5 mb-1.5">
            <MessageCircle className="w-5 h-5 text-[#3C1E1E]" strokeWidth={2.2} />
            <span className="font-bold text-sage-800">카카오톡 채널 준비 중</span>
          </div>
          <p className="text-sm text-[var(--color-muted)] leading-relaxed">
            카카오톡 문의 채널을 준비하고 있어요. 그동안은 아래 이메일로 문의해 주세요.
          </p>
        </div>
      )}

      {/* 이메일 대체 수단 */}
      <a
        href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('렉처링크 문의')}`}
        className="mt-3 flex items-center justify-center gap-2.5 h-12 w-full rounded-[14px] border border-[var(--color-border)] bg-white text-sage-800 font-semibold text-[15px] hover:border-sage-400 transition-colors"
      >
        <Mail className="w-4.5 h-4.5" strokeWidth={2} />
        이메일로 문의하기
      </a>

      <p className="mt-6 text-[13px] text-[var(--color-muted)] leading-relaxed">
        오류 신고나 기능 제안도 같은 채널로 받고 있어요. 자주 묻는 질문은{' '}
        <a href="/faq" className="text-sage-700 font-semibold hover:underline">
          FAQ
        </a>
        에서 먼저 확인하실 수 있습니다.
      </p>
    </article>
  );
}
