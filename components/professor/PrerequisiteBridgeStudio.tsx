'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BookOpenCheck,
  Check,
  Clipboard,
  FileText,
  Loader2,
  Printer,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Segmented } from '@/components/ui/Segmented';
import { UploadDropZone } from '@/components/ui/UploadDropZone';
import { UploadNextSteps } from '@/components/ui/UploadNextSteps';
import '@/components/faculty/formative-studio.css';
import './prerequisite-bridge.css';

type BridgeResult = {
  artifactId: string;
  title: string;
  courseConnection: string;
  estimatedMinutes: number;
  prerequisiteConcepts: Array<{ name: string; whyNeeded: string; quickReview: string; sourcePages: number[] }>;
  coreFlow: string[];
  commonConfusions: Array<{ confusion: string; correction: string }>;
  readinessCheck: Array<{ question: string; answer: string }>;
};

const ACCEPT = '.pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation';
const LEARNERS = ['의예과 1학년', '의예과 2학년', '의학과 1학년', '의학과 2학년', '의학과 3학년', '의학과 4학년', '기타'] as const;
type LearnerLevel = typeof LEARNERS[number];

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
    ...(result.readinessCheck.length ? [
      '',
      '예습 확인 문항',
      ...result.readinessCheck.map((item, index) => `${index + 1}. ${item.question}\n정답: ${item.answer}`),
    ] : []),
  ].join('\n');
}

export function PrerequisiteBridgeStudio() {
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [learnerLevel, setLearnerLevel] = useState<LearnerLevel>('의학과 2학년');
  const [customLearner, setCustomLearner] = useState('');
  const [reviewLength, setReviewLength] = useState('10분');
  const [emphasis, setEmphasis] = useState('');
  const [includeReadiness, setIncludeReadiness] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BridgeResult | null>(null);
  const [copied, setCopied] = useState(false);
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);
  const [courseId, setCourseId] = useState(searchParams.get('course') ?? '');

  useEffect(() => {
    fetch('/api/professor/courses').then((response) => response.json()).then((payload) => {
      if (payload.ok) setCourses(payload.data);
    });
  }, []);

  function chooseFile(next: File | undefined) {
    if (!next) return;
    setError('');
    setResult(null);
    setFile(next);
  }

  async function generate() {
    if (!file || !courseId || (learnerLevel === '기타' && !customLearner.trim())) return;
    setLoading(true);
    setError('');
    setResult(null);
    const form = new FormData();
    form.append('file', file);
    form.append('courseId', courseId);
    form.append('learnerLevel', learnerLevel === '기타' ? customLearner.trim() : learnerLevel);
    form.append('reviewLength', reviewLength);
    form.append('emphasis', emphasis);
    form.append('includeReadiness', String(includeReadiness));

    try {
      const response = await fetch('/api/professor/bridge/generate', { method: 'POST', body: form });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message ?? '예습자료를 만들지 못했습니다.');
      setResult(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '예습자료를 만들지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  async function copyResult() {
    if (!result) return;
    await navigator.clipboard.writeText(toPlainText(result));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="faculty-studio bridge-studio ll-upload-page">
      <Link href="/professor" className="back"><ArrowLeft size={16} />대시보드로</Link>

      <header className="page-head">
        <div>
          <p className="eyebrow">교수 도구 · 예습자료</p>
          <h1><span className="headline-accent">예습자료</span>로 기초와 임상을 잇고,<br />수업을 시작하세요</h1>
          <p className="lead">업로드한 강의에서 주제를 파악하고, 수업을 이해하는 데 필요한 이전 단계의 지식만 짧게 되짚어줍니다.</p>
        </div>
        <div className="guide">
          <button type="button" className="guide-trigger"><span className="guide-icon">?</span>사용 설명서</button>
          <div className="guide-panel">
            <h2>어떻게 사용하나요?</h2>
            <ol>
              <li><strong>강의자료 업로드</strong>: PPTX 또는 PDF를 올리면 수업 주제를 자동으로 파악합니다.</li>
              <li><strong>예습 범위 설정</strong>: 학습자와 목표 복습시간을 선택합니다.</li>
              <li><strong>교수 검토</strong>: 생성된 한 페이지 예습자료를 확인한 뒤 학생에게 배포합니다.</li>
            </ol>
          </div>
        </div>
      </header>

      <div className={file ? 'studio-workbench bridge-workbench' : 'studio-workbench bridge-workbench is-upload-only'}>
        <main className="studio-main">
          <section className="studio-section material-section card pad" aria-labelledby="bridge-upload-title">
            <span className="studio-step-number" aria-hidden="true">1</span>
            <div className="card-head">
              <div>
                <h2 id="bridge-upload-title">강의자료 업로드</h2>
                <p>AI가 자료에서 수업 주제와 필요한 선수지식의 범위를 찾습니다.</p>
              </div>
              <div className="tag"><Badge variant="default">필수</Badge></div>
            </div>
            {file && <span className="status-copy"><ShieldCheck size={15} /> 교수 검토 전 비공개</span>}

            {!file ? (
              <UploadDropZone
                inputRef={inputRef}
                accept={ACCEPT}
                onFile={chooseFile}
                title="파일을 끌어오거나 클릭해 업로드"
                hint="PPTX, PDF · 최대 25MB"
              />
            ) : (
              <div className="file-row">
                <span className="file-icon"><FileText size={20} /></span>
                <span className="file-main">
                  <b className="file-name">{file.name}</b>
                  <small className="file-meta">{(file.size / 1024 / 1024).toFixed(1)} MB · 업로드 완료</small>
                </span>
                <button type="button" aria-label="파일 제거" onClick={() => { setFile(null); setResult(null); }}><X size={17} /></button>
              </div>
            )}
          </section>

          {file && (
            <section className="studio-section bridge-settings card pad" aria-labelledby="bridge-settings-title">
              <span className="studio-step-number" aria-hidden="true">2</span>
              <div className="card-head">
                <div>
                  <h2 id="bridge-settings-title">예습자료 설정</h2>
                  <p>학생 수준과 수업 전 복습 분량을 정해주세요.</p>
                </div>
              </div>

              <div className="bridge-controls">
                <div className="design-group full">
                  <div className="design-group-heading"><h3>학습자</h3><div className="tag"><Badge variant="default">필수</Badge></div></div>
                  <Segmented options={LEARNERS} value={learnerLevel} onChange={setLearnerLevel} ariaLabel="학습자" />
                  {learnerLevel === '기타' && (
                    <input className="bridge-text-input" value={customLearner} onChange={(event) => setCustomLearner(event.target.value)} placeholder="학습자 수준을 입력해주세요." />
                  )}
                </div>

                <div className="design-group full">
                  <div className="design-group-heading"><h3>목표 복습시간</h3><div className="tag"><Badge variant="default">필수</Badge></div></div>
                  <Segmented options={['5분', '10분', '15분'] as const} value={reviewLength} onChange={setReviewLength} ariaLabel="목표 복습시간" />
                </div>

                <div className="design-group full bridge-optional">
                  <div className="design-group-heading"><h3>추가 설정</h3><div className="tag tag-muted"><Badge variant="gray">선택</Badge></div></div>
                  <label className="field">
                    <span className="field-label">꼭 연결하고 싶은 개념</span>
                    <textarea value={emphasis} onChange={(event) => setEmphasis(event.target.value)} placeholder="예: SA node 활동전위와 이온채널" maxLength={300} />
                  </label>
                  <label className="bridge-check-option">
                    <input type="checkbox" checked={includeReadiness} onChange={(event) => setIncludeReadiness(event.target.checked)} />
                    <span><b>예습 확인 문항 2개 포함</b><small>자료를 읽은 뒤 핵심 개념을 떠올릴 수 있는 짧은 확인 문항을 추가합니다.</small></span>
                  </label>
                </div>
              </div>
            </section>
          )}

          {error && <div className="studio-error" role="alert"><AlertTriangle size={17} />{error}</div>}

          {result && (
            <article className="bridge-result card pad">
              <div className="bridge-result-bar">
                <div><span>AI 초안 · 교수 검토 필요</span><b>{result.estimatedMinutes}분 복습</b></div>
                <div>
                  <button type="button" onClick={copyResult}>{copied ? <Check size={16} /> : <Clipboard size={16} />}{copied ? '복사됨' : '텍스트 복사'}</button>
                  <button type="button" onClick={() => window.print()}><Printer size={16} />PDF 저장·인쇄</button>
                </div>
              </div>
              <header><h2>{result.title}</h2><p>{result.courseConnection}</p></header>
              <section><h3>먼저 떠올릴 개념</h3>{result.prerequisiteConcepts.map((item, index) => <div className="bridge-concept" key={item.name}><span>{String(index + 1).padStart(2, '0')}</span><div><h4>{item.name}</h4><p>{item.quickReview}</p><small><b>이번 수업에 필요한 이유</b>{item.whyNeeded}</small><em>근거 {item.sourcePages.map((page) => `${page}쪽`).join(' · ')}</em></div></div>)}</section>
              <section><h3>이번 수업으로 이어지는 흐름</h3><ol className="bridge-flow">{result.coreFlow.map((item) => <li key={item}>{item}</li>)}</ol></section>
              {result.commonConfusions.length > 0 && <section><h3>헷갈리기 쉬운 지점</h3><div className="bridge-confusions">{result.commonConfusions.map((item) => <div key={item.confusion}><b>{item.confusion}</b><p>{item.correction}</p></div>)}</div></section>}
              {result.readinessCheck.length > 0 && <section><h3>예습 확인 문항</h3><div className="bridge-checks">{result.readinessCheck.map((item, index) => <details key={item.question}><summary>{index + 1}. {item.question}</summary><p>{item.answer}</p></details>)}</div></section>}
            </article>
          )}
        </main>

        {!file && <div className="studio-flow-arrow" aria-hidden="true"><span /><ArrowRight size={24} strokeWidth={2.4} /></div>}

        {!file && (
          <UploadNextSteps
            className="studio-next-flow"
            steps={[
              { number: 2, title: '수업 주제 자동 파악', description: '강의자료에서 이번 수업의 핵심 주제와 임상 맥락을 찾습니다.' },
              { number: 3, title: '선수지식 선별', description: '학생이 이미 배웠지만 다시 떠올려야 할 기초 개념만 고릅니다.' },
              { number: 4, title: '예습자료 생성·검토', description: '한 페이지 분량의 초안을 만들고 선택 시 확인 문항 2개를 추가합니다.' },
            ]}
            footer={<>먼저 왼쪽 <b className="text-sage-700">1. 강의자료 업로드</b>에서 파일을 선택해주세요.</>}
          />
        )}

        {file && (
          <aside className="faculty-summary summary summary-hero card pad">
            <div className="card-head"><div><h2>예습자료 초안</h2><p>설정을 확인하고 생성을 시작하세요.</p></div></div>
            <dl className="summary-list">
              <div className="summary-item"><span>저장할 차시</span><strong><select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">차시 선택</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></strong></div>
              <div className="summary-item"><span>자료</span><strong>{file.name}</strong></div>
              <div className="summary-item"><span>학습자</span><strong>{learnerLevel === '기타' ? customLearner || '직접 입력' : learnerLevel}</strong></div>
              <div className="summary-item"><span>분량</span><strong>{reviewLength}</strong></div>
              <div className="summary-item"><span>확인 문항</span><strong>{includeReadiness ? '2문항 포함' : '포함 안 함'}</strong></div>
            </dl>
            <button className="generate-button primary-btn" type="button" disabled={!file || !courseId || loading || (learnerLevel === '기타' && !customLearner.trim())} onClick={generate}>
              {loading ? <><Loader2 className="spin" size={17} />초안 생성 중</> : <>예습자료 만들기 <ArrowRight size={17} /></>}
            </button>
            {result?.artifactId && <Link className="workspace-return" href={`/professor/courses/${courseId}`}>저장됨 · 차시로 돌아가기</Link>}
            <p className="summary-note note"><BookOpenCheck size={14} />결과는 차시에 저장되며 학생 공개 전 교수 검토가 필요합니다.</p>
          </aside>
        )}
      </div>
    </div>
  );
}
