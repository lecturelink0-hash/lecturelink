import Link from 'next/link';
import { ArrowRight, BarChart3, BookOpen, ClipboardCheck, FileText, GraduationCap, Layers3, Plus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Course = { id: string; title: string; term: string | null; created_at: string };
type Artifact = { id: string; course_id: string; type: string; title: string; status: string; created_at: string };

const TOOLS: Array<{ title: string; description: string; href: string; icon: LucideIcon }> = [
  { title: '강의자료 개선', description: '슬라이드에서 보완할 부분을 찾아 정리합니다.', href: '/professor/materials', icon: FileText },
  { title: '예습자료 만들기', description: '다음 수업에 필요한 기초 내용을 준비합니다.', href: '/professor/bridge', icon: Layers3 },
  { title: '형성평가 만들기', description: '강의자료를 바탕으로 복습 문제를 만듭니다.', href: '/professor/formative', icon: GraduationCap },
  { title: '문항 검토하기', description: '문제와 정답이 알맞은지 확인합니다.', href: '/professor/quality', icon: ClipboardCheck },
];

const TYPE_LABEL: Record<string, string> = { formative: '형성평가', preview: '예습자료', material_review: '강의자료 개선' };
const STATUS_LABEL: Record<string, string> = { draft: '작성 중', review: '검토 필요', approved: '승인 완료', published: '학생에게 배포됨' };

export function ProfessorHome({ displayName, courses, recentArtifacts }: { displayName: string; courses: Course[]; recentArtifacts: Artifact[] }) {
  const courseNames = new Map(courses.map((course) => [course.id, course.title]));
  const professorName = displayName.replace(/\s*교수(?:님)?$/, '').trim() || displayName;

  return (
    <div className="professor-home">
      <section className="professor-home-hero">
        <div>
          <span className="professor-badge">LECTURELINK FACULTY</span>
          <h1>안녕하세요, <em>{professorName}</em> 교수님.<br />무엇을 준비할까요?</h1>
          <p>수업 준비에 필요한 작업을 아래에서 바로 시작할 수 있습니다.</p>
          <div className="professor-hero-actions">
            <Link href="/professor/formative" className="professor-primary"><Plus size={22} /> 형성평가 만들기</Link>
            <Link href="/professor/courses" className="professor-secondary">통합 관리 보기 <ArrowRight size={20} /></Link>
          </div>
        </div>
        <div className="professor-home-art" aria-hidden="true"><span><BookOpen size={32} /></span><i /><i /><i /></div>
      </section>

      <section className="professor-home-section" aria-labelledby="faculty-tools-title">
        <div className="professor-section-head"><div><h2 id="faculty-tools-title">원하는 작업을 선택하세요</h2></div></div>
        <div className="professor-tool-list">
          {TOOLS.map(({ title, description, href, icon: Icon }) => (
            <Link href={href} className="professor-tool" key={title}>
              <div className="professor-tool-icon"><Icon size={26} /></div>
              <h3>{title}</h3><p>{description}</p><span>시작하기 <ArrowRight size={19} /></span>
            </Link>
          ))}
        </div>
      </section>

      {recentArtifacts.length > 0 && (
        <section className="professor-home-section" aria-labelledby="recent-work-title">
          <div className="professor-section-head"><div><h2 id="recent-work-title">최근 작업</h2></div></div>
          <div className="professor-recent-list">
            {recentArtifacts.map((artifact) => (
              <Link href={artifact.type === 'formative' ? `/professor/artifacts/${artifact.id}` : `/professor/courses/${artifact.course_id}`} key={artifact.id}>
                <span className="professor-recent-icon">{artifact.type === 'formative' ? <ClipboardCheck size={22} /> : <FileText size={22} />}</span>
                <span><small>{courseNames.get(artifact.course_id) ?? TYPE_LABEL[artifact.type] ?? '수업 자료'}</small><b>{artifact.title}</b></span>
                <em>{STATUS_LABEL[artifact.status] ?? artifact.status}</em><ArrowRight size={20} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {courses.length > 0 && (
        <section className="professor-home-section" aria-labelledby="course-workspace-title">
          <div className="professor-section-head">
            <div><h2 id="course-workspace-title">통합 관리</h2></div>
            <Link href="/professor/courses" className="professor-text-link">전체 보기 <ArrowRight size={19} /></Link>
          </div>
          <div className="professor-course-grid">
            {courses.slice(0, 3).map((course) => (
              <Link href={`/professor/courses/${course.id}`} key={course.id}>
                <span><BookOpen size={22} /></span><small>{course.term ?? '학기 미지정'}</small><b>{course.title}</b><em>강의실 열기 <ArrowRight size={18} /></em>
              </Link>
            ))}
          </div>
        </section>
      )}

      {courses.length === 0 && (
        <section className="professor-home-start">
          <div><span><BarChart3 size={24} /></span><div><b>먼저 강의실을 만들어 주세요.</b><p>강의실에서 수업 자료와 학생 학습 결과를 관리할 수 있습니다.</p></div></div>
          <Link href="/professor/courses">강의실 만들기 <ArrowRight size={19} /></Link>
        </section>
      )}
    </div>
  );
}
