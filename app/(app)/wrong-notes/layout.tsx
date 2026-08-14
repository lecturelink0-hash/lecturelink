import type { Metadata } from 'next';

// page.tsx 가 'use client' 라 metadata 를 이 레이아웃에서 정의한다.
export const metadata: Metadata = { title: '오답노트' };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
