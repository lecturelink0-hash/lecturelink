import type { Metadata } from 'next';
import { MessageCircle } from 'lucide-react';
import { legalOperator } from '@/lib/legal/config';
import { EmailCopyAction } from './EmailCopyAction';

export const metadata: Metadata = { title: '문의하기 — LectureLink' };

const LECTURELINK_KAKAO_CHANNEL_URL = 'https://pf.kakao.com/_DQwiX/chat';

// 운영 환경에서 링크를 교체할 수 있고, 별도 설정이 없으면 현재 LectureLink 채널로 연결합니다.
function channelUrl(): string {
  return (
    process.env.KAKAO_CHANNEL_URL ||
    process.env.NEXT_PUBLIC_KAKAO_CHANNEL_URL ||
    LECTURELINK_KAKAO_CHANNEL_URL
  ).trim();
}

export default function ContactPage() {
  const kakao = channelUrl();
  const { representative, phone, supportEmail } = legalOperator();
  const phoneHref = `tel:${phone.replace(/[^+\d]/g, '')}`;
  const emailHref = `mailto:${supportEmail}?subject=${encodeURIComponent('LectureLink 문의')}`;

  return (
    <article className="legal-document legal-contact">
      <header className="legal-page-head">
        <h1>무엇이든 <span>문의해 주세요</span></h1>
        <p>
          문의는 언제든 남겨 주세요. 카카오톡·전화·이메일로 접수하며, 확인 후 1일 이내 답변드립니다.
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
        <EmailCopyAction email={supportEmail} />
      </div>

      <p className="legal-contact-help">
        대표자 {representative} · 전화 <a href={phoneHref}>{phone}</a> · 이메일{' '}
        <a href={emailHref}>{supportEmail}</a>
        <br />
        오류 신고나 기능 제안도 같은 채널로 받고 있어요. 자주 묻는 질문은{' '}
        <a href="/faq">
          FAQ
        </a>
        에서 먼저 확인하실 수 있습니다.
      </p>
    </article>
  );
}
