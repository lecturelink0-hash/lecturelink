import type { Metadata } from 'next';
import { MessageCircle, Mail } from 'lucide-react';

export const metadata: Metadata = { title: '문의하기 — LectureLink' };

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
    <article className="legal-document legal-contact">
      <header className="legal-page-head">
        <h1>무엇이든 <span>문의해 주세요</span></h1>
        <p>
          궁금한 점이나 불편한 점이 있으면 편하게 알려주세요. 보통 영업일 기준 하루 안에 답변드립니다.
        </p>
      </header>

      {/* 카카오톡 문의 CTA */}
      <div className="legal-contact-actions">
        {kakao ? (
          <a
            href={kakao}
            target="_blank"
            rel="noreferrer"
            className="legal-primary-button"
          >
            <MessageCircle aria-hidden="true" />
            카카오톡으로 문의하기
          </a>
        ) : (
          <div className="legal-contact-pending" role="status">
            <div>
              <MessageCircle aria-hidden="true" />
              <strong>카카오톡 채널 준비 중</strong>
            </div>
            <p>
              카카오톡 문의 채널을 준비하고 있어요. 그동안은 아래 이메일로 문의해 주세요.
            </p>
          </div>
        )}

        {/* 이메일 대체 수단 */}
        <a
          href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('LectureLink 문의')}`}
          className="legal-secondary-button"
        >
          <Mail aria-hidden="true" />
          이메일로 문의하기
        </a>
      </div>

      <p className="legal-contact-help">
        오류 신고나 기능 제안도 같은 채널로 받고 있어요. 자주 묻는 질문은{' '}
        <a href="/faq">
          FAQ
        </a>
        에서 먼저 확인하실 수 있습니다.
      </p>
    </article>
  );
}
