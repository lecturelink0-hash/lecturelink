import Link from 'next/link';
import { ArrowRight, ClipboardCheck, FileText, GraduationCap, Layers3, Plus } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

type ProfessorTool = {
  title: string;
  description: string;
  href?: '/professor/formative' | '/professor/materials' | '/professor/bridge' | '/professor/quality';
  icon: LucideIcon;
  status: string;
};

const TOOLS: readonly ProfessorTool[] = [
  {title:'형성평가 제작',description:'강의자료를 근거로 복습문항을 만들고 검수합니다.',href:'/professor/formative',icon:GraduationCap,status:'사용 가능'},
  {title:'강의자료 개선',description:'원문을 보존하면서 슬라이드의 가독성을 진단합니다.',href:'/professor/materials',icon:FileText,status:'사용 가능'},
  {title:'선수지식 브리지',description:'임상수업 전에 필요한 기초의학을 한 장으로 연결합니다.',href:'/professor/bridge',icon:Layers3,status:'사용 가능'},
  {title:'형성평가 품질 검사',description:'복수정답, 모호성, 정답 단서와 학습목표 정렬을 확인합니다.',href:'/professor/quality',icon:ClipboardCheck,status:'사용 가능'},
];
export function ProfessorDashboard(){return <div className="professor-dashboard">
  <header className="professor-welcome"><div><p>교수 작업실</p><h1>이번 수업의 이해도를<br/>먼저 설계해보세요.</h1></div><Link href="/professor/formative" className="professor-primary"><Plus size={17}/> 새 형성평가</Link></header>
  <section className="professor-next"><div className="professor-next-copy"><span>지금 시작하기</span><h2>강의자료에서 복습문항 만들기</h2><p>PPTX 또는 PDF를 올리고 범위와 학습목표를 지정하면, 출처가 표시된 형성평가 초안을 만듭니다.</p></div><ol><li><b>1</b><span>강의자료 선택</span></li><li><b>2</b><span>문항 의도 설정</span></li><li><b>3</b><span>교수 검수·승인</span></li></ol><Link href="/professor/formative">작업 시작 <ArrowRight size={17}/></Link></section>
  <section className="professor-tools"><div className="professor-section-head"><h2>교수 도구</h2><p>강의 준비부터 학생의 이해 확인까지 순차적으로 연결됩니다.</p></div><div className="professor-tool-list">{TOOLS.map(({title,description,icon:Icon,status,...tool},index)=>{const content=<><span className="professor-tool-order">{String(index+1).padStart(2,'0')}</span><Icon size={20}/><div><h3>{title}</h3><p>{description}</p></div><small>{status}</small>{tool.href&&<ArrowRight size={17}/>}</>;return tool.href?<Link href={tool.href} className="professor-tool" key={title}>{content}</Link>:<div className="professor-tool is-pending" key={title}>{content}</div>})}</div></section>
</div>}
