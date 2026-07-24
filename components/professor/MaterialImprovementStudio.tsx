'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileText,
  Loader2,
  Presentation,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { Segmented } from '@/components/ui/Segmented';
import { UploadDropZone } from '@/components/ui/UploadDropZone';
import { UploadNextSteps } from '@/components/ui/UploadNextSteps';
import '@/components/faculty/formative-studio.css';
import './material-improvement.css';

type SlideReview = {
  slide: number;
  title: string;
  density: '낮음' | '적정' | '높음';
  issues: string[];
  recommendation: string;
  safeActions: string[];
};

type Review = {
  deckTitle: string;
  summary: string;
  overallScore: number;
  strengths: string[];
  priorityActions: string[];
  slides: SlideReview[];
  artifactId: string;
};

const ACCEPT = '.pptx,.pdf,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PURPOSES = ['의과대학 정규 강의', '전공의·의료인 교육', '학회·연수 발표', '기타'] as const;
type MaterialPurpose = typeof PURPOSES[number];

export function MaterialImprovementStudio() {
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [purpose, setPurpose] = useState<MaterialPurpose>('의과대학 정규 강의');
  const [customPurpose, setCustomPurpose] = useState('');
  const [mustKeep, setMustKeep] = useState('');
  const [lockedPages, setLockedPages] = useState('');
  const [additionalPrompt, setAdditionalPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);
  const [courseId, setCourseId] = useState(searchParams.get('course') ?? '');

  useEffect(() => {
    fetch('/api/professor/courses')
      .then((response) => response.json())
      .then((payload) => {
        if (payload.ok) setCourses(payload.data);
      });
  }, []);

  function chooseFile(next: File | undefined) {
    if (!next) return;
    setError('');
    setReview(null);
    setFile(next);
  }

  async function analyze() {
    if (!file || !courseId) return;
    setLoading(true);
    setError('');
    const form = new FormData();
    form.append('file', file);
    form.append('courseId', courseId);
    form.append('purpose', purpose === '기타' ? customPurpose.trim() : purpose);
    form.append('mustKeep', mustKeep);
    form.append('lockedPages', lockedPages);
    form.append('additionalPrompt', additionalPrompt);

    try {
      const response = await fetch('/api/professor/materials/analyze', { method: 'POST', body: form });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message ?? '자료를 분석하지 못했습니다.');
      }
      setReview(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '자료를 분석하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="faculty-studio material-studio ll-upload-page">
      <Link href="/professor" className="back"><ArrowLeft size={16} />대시보드로</Link>

      <header className="page-head">
        <div>
          <p className="eyebrow">교수 도구 · 자료 개선</p>
          <h1>내용은 그대로,<br /><span className="headline-accent">강의자료</span>를 더 <span className="headline-accent">읽기 쉽게</span></h1>
          <p className="lead">PPTX 또는 PDF의 내용은 보존하면서 페이지별 밀도와 정보 흐름을 분석해 개선안을 만듭니다.</p>
        </div>
        <div className="guide">
          <button type="button" className="guide-trigger"><span className="guide-icon">?</span>사용 설명서</button>
          <div className="guide-panel">
            <h2>어떻게 사용하나요?</h2>
            <ol>
              <li><strong>자료 업로드</strong>: 개선할 PPTX 또는 PDF 파일을 올립니다.</li>
              <li><strong>사용 목적 선택</strong>: 정규 강의, 의료인 교육, 발표 중 자료의 용도를 선택합니다.</li>
              <li><strong>교수 검토</strong>: 슬라이드별 진단과 안전한 수정 제안을 확인합니다.</li>
            </ol>
          </div>
        </div>
      </header>

      <div className={file ? 'studio-workbench material-workbench' : 'studio-workbench material-workbench is-upload-only'}>
        <main className="studio-main">
          <section className="studio-section material-section card pad" aria-labelledby="material-upload-title">
            <span className="studio-step-number" aria-hidden="true">1</span>
            <div className="card-head">
              <div>
                <h2 id="material-upload-title">자료 업로드</h2>
                <p>가독성과 교육 흐름을 개선할 PPTX 또는 PDF 파일을 올려주세요.</p>
              </div>
              <div className="tag"><Badge variant="default">필수</Badge></div>
            </div>
            {file && <span className="status-copy"><ShieldCheck size={15} /> 원본 파일 보존 · 교수 검토 전 비공개</span>}

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
                <span className="file-icon"><Presentation size={20} /></span>
                <span className="file-main">
                  <b className="file-name">{file.name}</b>
                  <small className="file-meta">{(file.size / 1024 / 1024).toFixed(1)} MB · 업로드 완료</small>
                </span>
                <button type="button" aria-label="파일 제거" onClick={() => { setFile(null); setReview(null); }}><X size={17} /></button>
              </div>
            )}
          </section>

          {file && (
            <section className="studio-section material-settings card pad" aria-labelledby="material-settings-title">
              <span className="studio-step-number" aria-hidden="true">2</span>
              <div className="card-head">
                <div>
                  <h2 id="material-settings-title">개선 기준</h2>
                  <p>기본 품질은 모두 점검하고, 자료의 사용 목적과 예외 사항만 반영합니다.</p>
                </div>
              </div>

              <div className="material-controls">
                <div className="material-auto-criteria">
                  <span>AI가 항상 함께 점검해요</span>
                  <div>{['가독성', '핵심 강조', '적절한 분량', '수업 흐름', '내용 중복', '제목 위계'].map((item) => <b key={item}>{item}</b>)}</div>
                </div>

                <div className="design-group full">
                  <div className="design-group-heading">
                    <h3>자료 사용 목적</h3>
                    <div className="tag"><Badge variant="default">필수</Badge></div>
                  </div>
                  <Segmented options={PURPOSES} value={purpose} onChange={setPurpose} ariaLabel="자료 사용 목적" />
                  {purpose === '기타' && (
                    <input
                      className="material-text-input"
                      value={customPurpose}
                      onChange={(event) => setCustomPurpose(event.target.value)}
                      placeholder="자료를 사용할 목적을 입력해주세요."
                      aria-label="기타 자료 사용 목적"
                    />
                  )}
                </div>

                <div className="design-group full material-optional-settings">
                  <div className="design-group-heading">
                    <h3>추가 요청</h3>
                    <div className="tag tag-muted"><Badge variant="gray">선택</Badge></div>
                  </div>
                  <div className="material-request-grid">
                    <label className="field">
                      <span className="field-label">반드시 유지할 내용</span>
                      <textarea value={mustKeep} onChange={(event) => setMustKeep(event.target.value)} placeholder="예: 표 안의 수치와 가이드라인 권고 문구는 그대로 유지해주세요." />
                    </label>
                    <label className="field">
                      <span className="field-label">수정하지 않을 페이지</span>
                      <input className="material-text-input" value={lockedPages} onChange={(event) => setLockedPages(event.target.value)} placeholder="예: 1-3, 5, 10-12" />
                    </label>
                    <label className="field">
                      <span className="field-label">추가하고 싶은 프롬프트</span>
                      <textarea value={additionalPrompt} onChange={(event) => setAdditionalPrompt(event.target.value)} placeholder="추가로 반영할 요청을 자유롭게 입력해주세요." />
                    </label>
                  </div>
                </div>
              </div>
            </section>
          )}

          {error && <div className="studio-error" role="alert"><AlertTriangle size={17} />{error}</div>}

          {review && (
            <section className="studio-section material-results card pad" aria-labelledby="material-result-title">
              <div className="card-head">
                <div>
                  <h2 id="material-result-title">자료 개선 진단</h2>
                  <p>{review.summary}</p>
                </div>
                <span className="material-score-badge">{review.overallScore}점</span>
              </div>

              <div className="material-priorities">
                <div><h3>잘 된 부분</h3>{review.strengths.map((item) => <p key={item}><CheckCircle2 size={15} />{item}</p>)}</div>
                <div><h3>먼저 고칠 부분</h3>{review.priorityActions.map((item) => <p key={item}><AlertTriangle size={15} />{item}</p>)}</div>
              </div>

              <div className="slide-review-list">
                {review.slides.map((slide) => (
                  <article key={slide.slide}>
                    <div className="slide-review-no"><span>{slide.slide}</span><small>{slide.density} 밀도</small></div>
                    <div>
                      <h3>{slide.title}</h3>
                      {slide.issues.length > 0 && <ul>{slide.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
                      <p className="slide-recommendation"><b>개선안</b>{slide.recommendation}</p>
                      <div className="safe-actions">{slide.safeActions.map((action) => <span key={action}>{action}</span>)}</div>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          )}
        </main>

        {!file && <div className="studio-flow-arrow" aria-hidden="true"><span /><ArrowRight size={24} strokeWidth={2.4} /></div>}

        {!file && (
          <UploadNextSteps
            className="studio-next-flow"
            steps={[
              { number: 2, title: '사용 목적과 요청 확인', description: '자료의 사용 목적과 반드시 유지할 내용을 선택적으로 입력합니다.' },
              { number: 3, title: '페이지 구조 분석', description: '텍스트 밀도와 제목 위계, 정보 흐름을 진단합니다.' },
              { number: 4, title: '개선안 검토·저장', description: '슬라이드별 제안을 확인하고 선택한 차시에 저장합니다.' },
            ]}
            footer={<>먼저 왼쪽 <b className="text-sage-700">1. 자료 업로드</b>에서 PPTX 또는 PDF 파일을 선택해주세요.</>}
          />
        )}

        {file && (
          <aside className="faculty-summary summary summary-hero card pad">
            <div className="card-head">
              <div><h2>자료 개선 요약</h2><p>설정을 확인하고 분석을 시작하세요.</p></div>
            </div>
            <dl className="summary-list">
              <div className="summary-item"><span>저장할 차시</span><strong><select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">차시 선택</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></strong></div>
              <div className="summary-item"><span>자료</span><strong>{file.name}</strong></div>
              <div className="summary-item"><span>사용 목적</span><strong>{purpose === '기타' ? customPurpose || '직접 입력' : purpose}</strong></div>
              <div className="summary-item"><span>기본 점검</span><strong>6개 기준 전체</strong></div>
              <div className="summary-item"><span>추가 요청</span><strong>{mustKeep || lockedPages || additionalPrompt ? '입력됨' : '없음'}</strong></div>
            </dl>
            <button className="generate-button primary-btn" type="button" disabled={!file || !courseId || loading || (purpose === '기타' && !customPurpose.trim())} onClick={analyze}>
              {loading ? <><Loader2 className="spin" size={17} /> 자료 분석 중</> : <>개선안 만들기 <ArrowRight size={17} /></>}
            </button>
            {review?.artifactId && <Link className="workspace-return" href={`/professor/courses/${courseId}`}>저장됨 · 차시로 돌아가기</Link>}
            <p className="summary-note note"><FileText size={14} /> 결과는 선택한 차시에 저장되며 원본 파일을 직접 변경하지 않습니다.</p>
          </aside>
        )}
      </div>
    </div>
  );
}
