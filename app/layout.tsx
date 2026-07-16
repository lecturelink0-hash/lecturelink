import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '렉처링크 — 의료 교육 특화 AI 학습',
  description: '우리 학교 시험 범위에 맞춘 AI 의학 문제 무한 생성. KMLE 기반 풀 + 학교별 필터 + 강의자료 업로드.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
