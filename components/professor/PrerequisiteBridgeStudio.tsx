'use client';

import { useRef, useState } from 'react';
import { AlertTriangle, BookOpenCheck, Check, Clipboard, FileText, Loader2, Printer, Upload, X } from 'lucide-react';
import './prerequisite-bridge.css';

type BridgeResult = {
  title: string;
  courseConnection: string;
  estimatedMinutes: number;
  prerequisiteConcepts: Array<{ name: string; whyNeeded: string; quickReview: string; sourcePages: number[] }>;
  coreFlow: string[];
  commonConfusions: Array<{ confusion: string; correction: string }>;
  readinessCheck: Array<{ question: string; answer: string }>;
};

function toPlainText(result: BridgeResult) {
  return [
    result.title,
    result.courseConnection,
    '',
    '먼저 떠올릴 개념',
    ...result.prerequisiteConcepts.map((item, index) => `${index + 1}. ${item.name}\n${item.quickReview}\n왜 필요한가: ${item.whyNeeded}`),
    '',
    '이번 수업으로 이어지는 흐름',
    ...result.coreFlow.map((item, index) => `${index + 1}. ${item}`),
    '',
    '수업 전 확인',
    ...result.readinessCheck.map((item, index) => `${index + 1}. ${item.question}\n정답: ${item.answer}`),
  ].join('\n');
}

export function PrerequisiteBridgeStudio() {
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [courseTopic, setCourseTopic] = useState('');
  const [learnerLevel, setLearnerLevel] = useState('의학과 2학년');
  const [reviewLength, setReviewLength] = useState('10분');
  const [emphasis, setEmphasis] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BridgeResult | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    if (!file || !courseTopic.trim()) return;
    setLoading(true); setError(''); setResult(null);
    const form = new FormData();
    form.append('file', file); form.append('courseTopic', courseTopic); form.append('learnerLevel', learnerLevel); form.append('reviewLength', reviewLength); form.append('emphasis', emphasis);
    try {
      const response = await fetch('/api/professor/bridge/generate', { method: 'POST', body: form });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message ?? '복습자료를 만들지 못했습니다.');
      setResult(payload.data);
    } catch (cause) { setError(cause instanceof Error ? cause.message : '복습자료를 만들지 못했습니다.'); }
    finally { setLoading(false); }
  }

  async function copyResult() {
    if (!result) return;
    await navigator.clipboard.writeText(toPlainText(result));
    setCopied(true); window.setTimeout(() => setCopied(false), 1600);
  }

  return <div className="bridge-studio">
    <header className="bridge-heading"><div><p>선수지식 브리지</p><h1>기억을 먼저 잇고,<br/>수업을 시작하세요.</h1><span>이번 임상 수업에 꼭 필요한 기초의학만 골라 1페이지 복습자료 초안을 만듭니다.</span></div><div className="bridge-principle"><BookOpenCheck size={19}/><div><b>이미 배운 내용만</b><small>새 진도가 아닌 기억 회복 자료</small></div></div></header>
    <div className="bridge-layout"><main>
      <section className="bridge-section"><div className="bridge-section-head"><h2>1. 이번 수업</h2><span>학생이 곧 배울 내용</span></div><label className="bridge-topic"><span>수업 주제</span><input value={courseTopic} onChange={event=>setCourseTopic(event.target.value)} placeholder="예: 부정맥 약물의 작용기전" maxLength={160}/></label></section>
      <section className="bridge-section"><div className="bridge-section-head"><h2>2. 강의자료</h2><span>PPTX 또는 PDF · 최대 25MB</span></div>{file?<div className="bridge-file"><FileText size={21}/><span><b>{file.name}</b><small>{(file.size/1024/1024).toFixed(1)} MB</small></span><button type="button" aria-label="파일 제거" onClick={()=>{setFile(null);setResult(null)}}><X size={17}/></button></div>:<button type="button" className="bridge-upload" onClick={()=>inputRef.current?.click()}><Upload size={21}/><span><b>강의자료 선택</b><small>AI가 필요한 선수지식의 범위를 자료에서 찾습니다</small></span></button>}<input hidden ref={inputRef} type="file" accept=".pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation" onChange={event=>{setFile(event.target.files?.[0]??null);setResult(null)}}/></section>
      <section className="bridge-section"><div className="bridge-section-head"><h2>3. 복습 범위</h2><span>프롬프트 없이 선택</span></div><div className="bridge-controls"><label><span>학습자</span><select value={learnerLevel} onChange={event=>setLearnerLevel(event.target.value)}>{['의예과 2학년','의학과 1학년','의학과 2학년','의학과 3학년','의학과 4학년'].map(item=><option key={item}>{item}</option>)}</select></label><label><span>목표 복습시간</span><select value={reviewLength} onChange={event=>setReviewLength(event.target.value)}>{['5분','10분','15분'].map(item=><option key={item}>{item}</option>)}</select></label><label className="bridge-emphasis"><span>꼭 연결하고 싶은 개념 <small>선택</small></span><textarea value={emphasis} onChange={event=>setEmphasis(event.target.value)} placeholder="예: SA node 활동전위와 이온채널" maxLength={300}/></label></div></section>
      {error&&<div className="bridge-error" role="alert"><AlertTriangle size={17}/>{error}</div>}
      {result&&<article className="bridge-result"><div className="bridge-result-bar"><div><span>AI 초안 · 교수 검토 필요</span><b>{result.estimatedMinutes}분 복습</b></div><div><button type="button" onClick={copyResult}>{copied?<Check size={16}/>:<Clipboard size={16}/>} {copied?'복사됨':'텍스트 복사'}</button><button type="button" onClick={()=>window.print()}><Printer size={16}/> 인쇄</button></div></div><header><h2>{result.title}</h2><p>{result.courseConnection}</p></header><section><h3>먼저 떠올릴 개념</h3>{result.prerequisiteConcepts.map((item,index)=><div className="bridge-concept" key={item.name}><span>{String(index+1).padStart(2,'0')}</span><div><h4>{item.name}</h4><p>{item.quickReview}</p><small><b>이번 수업에 필요한 이유</b>{item.whyNeeded}</small><em>근거 {item.sourcePages.map(page=>`${page}쪽`).join(' · ')}</em></div></div>)}</section><section><h3>이번 수업으로 이어지는 흐름</h3><ol className="bridge-flow">{result.coreFlow.map(item=><li key={item}>{item}</li>)}</ol></section>{result.commonConfusions.length>0&&<section><h3>헷갈리기 쉬운 지점</h3><div className="bridge-confusions">{result.commonConfusions.map(item=><div key={item.confusion}><b>{item.confusion}</b><p>{item.correction}</p></div>)}</div></section>}<section><h3>수업 전 확인</h3><div className="bridge-checks">{result.readinessCheck.map((item,index)=><details key={item.question}><summary>{index+1}. {item.question}</summary><p>{item.answer}</p></details>)}</div></section></article>}
    </main><aside className="bridge-run"><BookOpenCheck size={20}/><h2>복습자료 초안</h2><dl><div><dt>주제</dt><dd>{courseTopic||'입력 전'}</dd></div><div><dt>학습자</dt><dd>{learnerLevel}</dd></div><div><dt>분량</dt><dd>{reviewLength}</dd></div><div><dt>자료</dt><dd>{file?.name??'선택 전'}</dd></div></dl><button type="button" disabled={!file||!courseTopic.trim()||loading} onClick={generate}>{loading?<><Loader2 className="bridge-spin" size={17}/> 초안 생성 중</>:<>1페이지 복습자료 만들기</>}</button><p>학생에게 공개되기 전 반드시 교수 검토가 필요합니다.</p></aside></div>
  </div>;
}
