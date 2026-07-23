import Link from 'next/link';
import { ArrowRight } from 'lucide-react';
import { ProfessorDashboard } from '@/components/professor/ProfessorDashboard';
import '@/components/professor/professor.css';

export default function FacultyLandingPage() {
  return (
    <div className="professor-app faculty-landing-shell">
      <header className="professor-topbar">
        <div className="professor-topbar-inner">
          <Link href="/" className="professor-top-logo" aria-label="LectureLink 홈">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/lecturelink-mark.png" alt="" />
            <b>Lecturelink</b>
            <small>FACULTY</small>
          </Link>
          <nav className="faculty-landing-nav" aria-label="교수 서비스 소개">
            <a href="#faculty-tools">교수 기능</a>
            <Link href="/login?next=/professor">로그인</Link>
            <Link href="/login?next=/professor" className="faculty-landing-cta">
              교수로 시작하기 <ArrowRight size={15} />
            </Link>
          </nav>
        </div>
      </header>
      <main className="professor-content">
        <ProfessorDashboard />
      </main>
    </div>
  );
}
