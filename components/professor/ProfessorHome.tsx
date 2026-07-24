import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  BookOpen,
  ClipboardCheck,
  FileText,
  GraduationCap,
  Layers3,
  Plus,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type Course = {
  id: string;
  title: string;
  term: string | null;
  created_at: string;
};

type Artifact = {
  id: string;
  course_id: string;
  type: string;
  title: string;
  status: string;
  created_at: string;
};

const TOOLS: Array<{
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
  label: string;
}> = [
  {
    label: 'ASSESSMENT',
    title: '형성평가 제작',
    description: '강의자료와 학습목표를 바탕으로 복습문항을 만듭니다.',
    href: '/professor/formative',
    icon: GraduationCap,
  },
  {
    label: 'MATERIAL',
    title: '자료 개선',
    description: '원문을 보존하며 슬라이드 밀도와 가독성을 정리합니다.',
    href: '/professor/materials',
    icon: FileText,
  },
  {
    label: 'PREVIEW',
    title: '예습자료 제작',
    description: '임상 수업에 필요한 기초의학을 한 장으로 연결합니다.',
    href: '/professor/bridge',
    icon: Layers3,
  },
  {
    label: 'QUALITY',
    title: '문항 검토',
    description: '모호한 표현과 정답 단서, 목표 정렬을 점검합니다.',
    href: '/professor/quality',
    icon: ClipboardCheck,
  },
];

const TYPE_LABEL: Record<string, string> = {
  formative: '형성평가',
  preview: '예습자료',
  material_review: '자료 개선',
};

const STATUS_LABEL: Record<string, string> = {
  draft: '초안',
  review: '검토 필요',
  approved: '승인 완료',
  published: '학생 배포',
};

export function ProfessorHome({
  displayName,
  courses,
  recentArtifacts,
}: {
  displayName: string;
  courses: Course[];
  recentArtifacts: Artifact[];
}) {
  const courseNames = new Map(courses.map((course) => [course.id, course.title]));
  const professorName = displayName.replace(/\s*교수(?:님)?$/, '').trim() || displayName;

  return (
    <div className="professor-home">
      <section className="professor-home-hero">
        <div>
          <span className="professor-badge">LECTURELINK FACULTY</span>
          <h1>
            안녕하세요, <em>{professorName}</em> 교수님.
            <br />
            오늘 수업 준비를 시작해볼까요?
          </h1>
          <p>강의자료에서 형성평가와 예습자료를 만들고, 차시별로 결과를 이어서 관리하세요.</p>
          <div className="professor-hero-actions">
            <Link href="/professor/formative" className="professor-primary">
              <Plus size={17} /> 새 형성평가 만들기
            </Link>
            <Link href="/professor/courses" className="professor-secondary">
              내 강의실 <ArrowRight size={16} />
            </Link>
          </div>
        </div>
        <div className="professor-home-art" aria-hidden="true">
          <span><BookOpen size={28} /></span>
          <i />
          <i />
          <i />
        </div>
      </section>

      <section className="professor-home-section" aria-labelledby="faculty-tools-title">
        <div className="professor-section-head">
          <div>
            <span>FACULTY TOOLS</span>
            <h2 id="faculty-tools-title">무엇을 준비하시나요?</h2>
          </div>
          <p>필요한 작업을 바로 시작할 수 있습니다.</p>
        </div>
        <div className="professor-tool-list">
          {TOOLS.map(({ title, description, href, icon: Icon, label }) => (
            <Link href={href} className="professor-tool" key={title}>
              <div className="professor-tool-icon"><Icon size={21} /></div>
              <small>{label}</small>
              <h3>{title}</h3>
              <p>{description}</p>
              <span>시작하기 <ArrowRight size={15} /></span>
            </Link>
          ))}
        </div>
      </section>

      {recentArtifacts.length > 0 && (
        <section className="professor-home-section" aria-labelledby="recent-work-title">
          <div className="professor-section-head">
            <div>
              <span>RECENT WORK</span>
              <h2 id="recent-work-title">최근 작업 이어서 하기</h2>
            </div>
          </div>
          <div className="professor-recent-list">
            {recentArtifacts.map((artifact) => (
              <Link
                href={artifact.type === 'formative' ? `/professor/artifacts/${artifact.id}` : `/professor/courses/${artifact.course_id}`}
                key={artifact.id}
              >
                <span className="professor-recent-icon">
                  {artifact.type === 'formative' ? <ClipboardCheck size={18} /> : <FileText size={18} />}
                </span>
                <span>
                  <small>{courseNames.get(artifact.course_id) ?? TYPE_LABEL[artifact.type] ?? '수업 자료'}</small>
                  <b>{artifact.title}</b>
                </span>
                <em>{STATUS_LABEL[artifact.status] ?? artifact.status}</em>
                <ArrowRight size={16} />
              </Link>
            ))}
          </div>
        </section>
      )}

      {courses.length > 0 && (
        <section className="professor-home-section" aria-labelledby="course-workspace-title">
          <div className="professor-section-head">
            <div>
              <span>COURSE WORKSPACE</span>
              <h2 id="course-workspace-title">최근 강의 작업공간</h2>
            </div>
            <Link href="/professor/courses" className="professor-text-link">전체 보기 <ArrowRight size={15} /></Link>
          </div>
          <div className="professor-course-grid">
            {courses.slice(0, 3).map((course) => (
              <Link href={`/professor/courses/${course.id}`} key={course.id}>
                <span><BookOpen size={18} /></span>
                <small>{course.term ?? '학기 미지정'}</small>
                <b>{course.title}</b>
                <em>작업공간 열기 <ArrowRight size={14} /></em>
              </Link>
            ))}
          </div>
        </section>
      )}

      {courses.length === 0 && (
        <section className="professor-home-start">
          <div>
            <span><BarChart3 size={20} /></span>
            <div>
              <b>차시별로 결과를 모아보세요</b>
              <p>첫 차시를 만들면 형성평가와 예습자료, 학생 이해도를 한곳에서 관리할 수 있습니다.</p>
            </div>
          </div>
          <Link href="/professor/courses">첫 차시 만들기 <ArrowRight size={15} /></Link>
        </section>
      )}
    </div>
  );
}
