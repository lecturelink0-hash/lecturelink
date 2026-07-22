import Link from 'next/link';
import { ArrowRight, BarChart3, BookOpen, Check, ClipboardCheck, FileText, GraduationCap, Layers3, Plus, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type ProfessorTool = { title:string; description:string; href:'/professor/formative'|'/professor/materials'|'/professor/bridge'|'/professor/quality'; icon:LucideIcon; eyebrow:string };
const TOOLS:ProfessorTool[]=[
  {eyebrow:'ASSESSMENT',title:'형성평가 제작',description:'강의자료와 학습목표를 바탕으로 수업 직후 확인할 복습문항을 만듭니다.',href:'/professor/formative',icon:GraduationCap},
  {eyebrow:'QUALITY',title:'문항 품질 검사',description:'모호한 표현, 정답 단서, 복수정답 가능성과 목표 정렬을 확인합니다.',href:'/professor/quality',icon:ClipboardCheck},
  {eyebrow:'MATERIAL',title:'강의자료 개선',description:'원문 내용은 보존하고 슬라이드의 밀도와 가독성을 진단합니다.',href:'/professor/materials',icon:FileText},
  {eyebrow:'PREVIEW',title:'선수지식 브리지',description:'임상 수업에 필요한 기초의학을 수업 전 한 장으로 연결합니다.',href:'/professor/bridge',icon:Layers3},
];

export function ProfessorDashboard(){return <div className="professor-dashboard">
  <section className="professor-hero">
    <div className="professor-hero-copy">
      <span className="professor-badge"><Sparkles size={13}/> 의학 교육 및 평가 지원</span>
      <h1>수업의 완성은,<br/><em>학생의 이해 확인</em>에서 시작됩니다.</h1>
      <p>강의자료를 올리면 형성평가와 예습자료를 만들고, 교수 검수부터 학생 배포·이해도 분석까지 한 흐름으로 연결합니다.</p>
      <div className="professor-hero-actions"><Link href="/professor/formative" className="professor-primary"><Plus size={17}/> 새 형성평가 만들기</Link><Link href="/professor/courses" className="professor-secondary">내 강의실 <ArrowRight size={16}/></Link></div>
      <div className="professor-proof"><span><Check size={14}/> 강의자료 근거 표시</span><span><Check size={14}/> 교수 승인 후 배포</span><span><Check size={14}/> 학생 이해도 분석</span></div>
    </div>
    <div className="professor-hero-visual" aria-label="교수 워크플로 미리보기">
      <div className="professor-preview-card">
        <header><span><BookOpen size={14}/> 순환기학</span><small>2026년 2학기</small></header>
        <div className="professor-preview-body"><div className="professor-preview-title"><span>형성평가</span><b>부정맥 약물의 작용기전</b></div><div className="professor-preview-row"><i>01</i><p>Class Ic 항부정맥제가 활동전위에 미치는 영향은?</p><strong>검토 완료</strong></div><div className="professor-preview-row"><i>02</i><p>SA node의 4기 탈분극에 관여하는 전류는?</p><strong>검토 중</strong></div></div>
        <footer><span>승인 문항 <b>4/5</b></span><span className="professor-progress"><i/></span><button>배포 준비</button></footer>
      </div>
      <div className="professor-insight-card"><BarChart3 size={17}/><span><b>82%</b><small>평균 이해도</small></span><em>+7.4%</em></div>
    </div>
  </section>

  <section className="professor-quick"><div><span>가장 빠른 시작</span><h2>강의자료에서 복습문항 만들기</h2><p>PPTX 또는 PDF를 올리고 범위와 목표만 지정하세요.</p></div><ol><li><b>1</b>자료 선택</li><li><b>2</b>의도 설정</li><li><b>3</b>검수·승인</li></ol><Link href="/professor/formative">시작하기 <ArrowRight size={16}/></Link></section>

  <section className="professor-tools"><div className="professor-section-head"><div><span>FACULTY TOOLS</span><h2>교수자를 위한 네 가지 도구</h2></div><p>수업 준비부터 이해 확인까지 필요한 순서대로 사용할 수 있습니다.</p></div><div className="professor-tool-list">{TOOLS.map(({title,description,href,icon:Icon,eyebrow},index)=><Link href={href} className="professor-tool" key={title}><div className="professor-tool-icon"><Icon size={21}/></div><small>{eyebrow} · {String(index+1).padStart(2,'0')}</small><h3>{title}</h3><p>{description}</p><span>열기 <ArrowRight size={15}/></span></Link>)}</div></section>
</div>}
