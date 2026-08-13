import Image from 'next/image';
import Link from 'next/link';
import { LegalBackButton } from './LegalBackButton';
import './legal.css';

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="legal-shell">
      <header className="legal-topbar">
        <div className="legal-topbar-inner">
          {/* 루트는 미인증 시 정적 랜딩(rewrite) — RSC 프리페치 대상이 아니므로 일반 앵커로 문서 내비게이션 */}
          <Link href="/" className="legal-brand" aria-label="LectureLink 홈">
            <Image src="/lecturelink-mark.png" alt="" width={40} height={40} priority />
            <b>LectureLink</b>
          </Link>
          <LegalBackButton />
        </div>
      </header>
      <main className="legal-content">{children}</main>
    </div>
  );
}
