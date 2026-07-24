'use client';
import Link from 'next/link';
import { useEffect,useMemo,useState } from 'react';
import { ArrowLeft,ArrowRight,BarChart3,BookOpen,ClipboardCheck,Copy,FileCheck2,FileText,Plus,Sparkles,Users } from 'lucide-react';
import '@/components/faculty/formative-studio.css';

type Course={id:string;title:string;code:string;term:string|null;status:string;created_at:string};
type Artifact={id:string;type:string;title:string;status:string;source_name:string|null;summary?:string|null;created_at:string};
const TYPES={formative:{label:'형성평가',icon:ClipboardCheck},preview:{label:'예습자료',icon:BookOpen},material_review:{label:'자료 개선',icon:FileCheck2}} as const;
const LOCAL_PREVIEW_COURSES: Course[] = [
  { id: 'preview-cardiology', title: '순환기학', code: 'CARDIO', term: '2026년 2학기', status: 'active', created_at: '2026-07-20T00:00:00.000Z' },
  { id: 'preview-arrhythmia', title: '부정맥 약물', code: 'RHYTHM', term: '임상약리학', status: 'active', created_at: '2026-07-18T00:00:00.000Z' },
];

export function CourseList() {
  const localPreview = process.env.NEXT_PUBLIC_LOCAL_FACULTY_UI_PREVIEW === 'true';
  const [courses, setCourses] = useState<Course[]>(localPreview ? LOCAL_PREVIEW_COURSES : []);
  const [title, setTitle] = useState('');
  const [term, setTerm] = useState('');
  const [busy, setBusy] = useState(false);

  async function load() {
    if (localPreview) return;
    const response = await fetch('/api/professor/courses');
    const payload = await response.json();
    if (payload.ok) setCourses(payload.data);
  }

  useEffect(() => { void load(); }, []);

  async function create() {
    if (!title.trim()) return;
    if (localPreview) {
      setCourses(current => [
        {
          id: `preview-${Date.now()}`,
          title: title.trim(),
          code: 'PREVIEW',
          term: term.trim() || null,
          status: 'active',
          created_at: new Date().toISOString(),
        },
        ...current,
      ]);
      setTitle('');
      setTerm('');
      return;
    }
    setBusy(true);
    await fetch('/api/professor/courses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, term }),
    });
    setTitle('');
    setTerm('');
    await load();
    setBusy(false);
  }

  return (
    <div className="professor-dashboard course-library faculty-studio ll-upload-page">
      <Link href="/professor" className="back"><ArrowLeft size={16} />대시보드로</Link>
      <header className="course-library-head page-head">
        <div>
          <span className="eyebrow">교수 도구 · 내 강의실</span>
          <h1>한 번의 수업 준비를,<br /><span className="headline-accent">하나의 차시</span>에서 이어가세요</h1>
          <p className="lead">차시를 만들면 자료 개선부터 예습자료, 형성평가와 학생 이해도까지 한곳에 모아 수업 전후의 흐름을 관리할 수 있습니다.</p>
        </div>
      </header>

      <section className="course-workflow" aria-labelledby="course-workflow-title">
        <div className="course-workflow-copy">
          <span>차시 하나에서 이렇게 이어져요</span>
          <h2 id="course-workflow-title">수업 준비부터 학습 결과까지</h2>
          <p>각 도구에서 만든 결과가 선택한 차시에 자동으로 모입니다.</p>
        </div>
        <ol>
          <li><span><FileCheck2 size={17} /></span><div><b>자료 개선</b><small>강의자료의 가독성과 흐름 정리</small></div></li>
          <li><span><BookOpen size={17} /></span><div><b>예습자료</b><small>수업 전 필요한 기초지식 연결</small></div></li>
          <li><span><ClipboardCheck size={17} /></span><div><b>형성평가</b><small>수업 후 이해도 확인 문항 제작</small></div></li>
          <li><span><BarChart3 size={17} /></span><div><b>학습 결과</b><small>학생 응답과 취약 문항 확인</small></div></li>
        </ol>
      </section>

      <section className="course-library-list">
        <div className="professor-section-head">
          <div>
            <span>이어서 하기</span>
            <h2>내 차시 작업공간</h2>
          </div>
          <p>{courses.length > 0 ? `${courses.length}개의 차시에서 작업을 이어갈 수 있어요` : '아래에서 첫 차시를 만들어보세요'}</p>
        </div>
        <div className="course-card-grid">
          {courses.map((course, index) => (
            <Link className="course-card" href={`/professor/courses/${course.id}`} key={course.id}>
              <div className="course-card-top">
                <span className="course-card-icon"><BookOpen size={19} /></span>
                <small>{course.term || '학기 미지정'}</small>
                <b>{String(index + 1).padStart(2, '0')}</b>
              </div>
              <h3>{course.title}</h3>
              <p>자료 개선 · 예습자료 · 형성평가 · 학습 결과</p>
              <span className="course-card-link">이 차시에서 이어서 하기 <ArrowRight size={15} /></span>
            </Link>
          ))}
          {!courses.length && (
            <div className="professor-empty">아직 만든 차시가 없습니다. 아래에서 첫 차시를 만들면 네 가지 수업 준비 도구를 한곳에서 관리할 수 있습니다.</div>
          )}
        </div>
      </section>

      <section className="course-create-panel">
        <div className="course-create-copy">
          <span><Plus size={13} /> 새 차시</span>
          <h2>새로운 수업 작업공간 만들기</h2>
          <p>수업 주제와 학기를 입력하면 자료 제작 결과가 이 차시에 차곡차곡 저장됩니다.</p>
        </div>
        <div className="course-create">
          <label>
            <span>차시명</span>
            <input aria-label="차시명" placeholder="예: 부정맥 약물" value={title} onChange={event => setTitle(event.target.value)} />
          </label>
          <label>
            <span>학기</span>
            <input aria-label="학기" placeholder="예: 2026년 2학기" value={term} onChange={event => setTerm(event.target.value)} />
          </label>
          <button className="course-create-button" disabled={busy || !title.trim()} onClick={create}>
            <Plus size={16} /> {busy ? '만드는 중' : '차시 만들기'}
          </button>
        </div>
      </section>
    </div>
  );
}

export function CourseDetail({courseId}:{courseId:string}){
 const[data,setData]=useState<{course:Course;artifacts:Artifact[];studentCount:number}|null>(null);
 useEffect(()=>{fetch(`/api/professor/courses/${courseId}`).then(r=>r.json()).then(p=>p.ok&&setData(p.data))},[courseId]);
 const groups=useMemo(()=>({formative:data?.artifacts.filter(a=>a.type==='formative')??[],preview:data?.artifacts.filter(a=>a.type==='preview')??[],material_review:data?.artifacts.filter(a=>a.type==='material_review')??[]}),[data]);
 if(!data)return <div className="professor-empty">차시를 불러오는 중입니다.</div>;
 return <div className="professor-dashboard session-detail"><header className="professor-welcome"><div><p>{data.course.term||'수업 차시'}</p><h1>{data.course.title}</h1><span>이 차시에서 만든 수업자료와 평가를 관리합니다.</span><div className="course-code">학생 참여 코드 <b>{data.course.code}</b><button onClick={()=>navigator.clipboard.writeText(data.course.code)}><Copy size={14}/>복사</button></div></div></header><section className="course-overview"><div><Users size={18}/><span><small>참여 학생</small><b>{data.studentCount}명</b></span></div><div><FileText size={18}/><span><small>만든 결과물</small><b>{data.artifacts.length}개</b></span></div><Link href={`/professor/courses/${courseId}/analytics`}><BarChart3 size={18}/><span><small>학습 결과</small><b>분석 리포트</b></span></Link></section><section className="session-actions"><Link href={`/professor/formative?course=${courseId}`}><ClipboardCheck size={18}/><span><b>형성평가 만들기</b><small>수업 후 이해도 확인</small></span></Link><Link href={`/professor/bridge?course=${courseId}`}><BookOpen size={18}/><span><b>예습자료 만들기</b><small>수업 전 선수지식 복습</small></span></Link><Link href={`/professor/materials?course=${courseId}`}><FileCheck2 size={18}/><span><b>자료 개선</b><small>PPT 가독성 검수</small></span></Link><Link href={`/professor/courses/${courseId}/analytics`}><BarChart3 size={18}/><span><b>분석 리포트</b><small>학생 응답과 취약 문항</small></span></Link></section><div className="session-artifact-groups">{(Object.entries(groups) as Array<[keyof typeof TYPES,Artifact[]]>).map(([type,items])=>{const meta=TYPES[type];const Icon=meta.icon;return <section className="artifact-group" key={type}><header><span><Icon size={18}/></span><div><h2>{meta.label}</h2><p>{items.length}개의 결과물</p></div></header><div>{items.map(item=><Link href={type==='formative'?`/professor/artifacts/${item.id}`:'#'} className="artifact-row" key={item.id}><div><b>{item.title}</b><small>{item.source_name||'직접 생성'} · {new Date(item.created_at).toLocaleDateString('ko-KR')}</small></div><span>{statusLabel(item.status)}</span><ArrowRight size={15}/></Link>)}{!items.length&&<p className="artifact-empty"><Sparkles size={16}/>아직 만든 {meta.label}가 없습니다.</p>}</div></section>})}</div></div>
}
function statusLabel(s:string){return({draft:'초안',review:'검토 필요',approved:'승인 완료',published:'학생 배포'} as Record<string,string>)[s]??s}
export function CourseAnalytics({courseId}:{courseId:string}){const[data,setData]=useState<any>(null);useEffect(()=>{fetch(`/api/professor/courses/${courseId}/analytics`).then(r=>r.json()).then(p=>p.ok&&setData(p.data))},[courseId]);if(!data)return <div className="professor-empty">분석을 불러오는 중입니다.</div>;return <div className="professor-dashboard"><header className="professor-welcome"><div><p>차시 분석 리포트</p><h1>{data.course.title}<br/>학생 이해도</h1></div></header><section className="analytics-grid"><div><small>배포한 평가</small><b>{data.publicationCount}</b></div><div><small>제출 학생</small><b>{data.submittedCount}</b></div><div><small>평균 정답률</small><b>{data.averagePercent===null?'—':`${data.averagePercent}%`}</b></div></section><section className="professor-tools"><div className="professor-section-head"><h2>취약 문항</h2><p>정답률이 낮은 순서입니다.</p></div><div className="professor-tool-list">{data.items.map((x:any,i:number)=><div className="professor-tool" key={x.itemId}><span className="professor-tool-order">{i+1}</span><div><h3>문항 응답 {x.answers}건</h3><p>정답 {x.correct}건 · 오답 {x.answers-x.correct}건</p></div><small>{x.correctPercent}%</small></div>)}{!data.items.length&&<div className="professor-empty">학생 제출이 쌓이면 문항별 이해도가 표시됩니다.</div>}</div></section></div>}
