'use client';

import { useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  FileText,
  Loader2,
  SearchCheck,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { UploadDropZone } from '@/components/ui/UploadDropZone';
import { UploadNextSteps } from '@/components/ui/UploadNextSteps';
import '@/components/faculty/formative-studio.css';
import './formative-quality.css';

type Review = {
  overallVerdict: '양호' | '수정 권장' | '검토 필요';
  summary: string;
  distribution: { recall: number; understanding: number; application: number };
  coverageNotes: string[];
  items: Array<{
    number: number;
    verdict: '통과' | '수정 권장' | '검토 필요';
    testedObjective: string;
    flags: Array<{ category: string; severity: '낮음' | '중간' | '높음'; message: string; suggestion: string }>;
  }>;
};

const QUESTION_ACCEPT = '.pdf,.docx,.txt,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const MATERIAL_ACCEPT = '.pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function FormativeQualityStudio() {
  const questionInputRef = useRef<HTMLInputElement>(null);
  const materialInputRef = useRef<HTMLInputElement>(null);
  const [questionFile, setQuestionFile] = useState<File | null>(null);
  const [materialFile, setMaterialFile] = useState<File | null>(null);
  const [questions, setQuestions] = useState('');
  const [focusRequest, setFocusRequest] = useState('');
  const [excludedCriteria, setExcludedCriteria] = useState('');
  const [additionalPrompt, setAdditionalPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [review, setReview] = useState<Review | null>(null);

  const hasQuestions = Boolean(questionFile || questions.trim().length >= 20);

  async function analyze() {
    if (!hasQuestions) return;
    setLoading(true);
    setError('');
    setReview(null);
    const form = new FormData();
    if (questionFile) form.append('questionFile', questionFile);
    if (materialFile) form.append('materialFile', materialFile);
    form.append('questions', questions);
    form.append('focusRequest', focusRequest);
    form.append('excludedCriteria', excludedCriteria);
    form.append('additionalPrompt', additionalPrompt);

    try {
      const response = await fetch('/api/professor/quality/analyze', { method: 'POST', body: form });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload?.error?.message ?? '문항 검토를 완료하지 못했습니다.');
      setReview(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '문항 검토를 완료하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  const issueCount = review?.items.reduce((sum, item) => sum + item.flags.length, 0) ?? 0;

  return (
    <div className="faculty-studio quality-studio ll-upload-page">
      <Link href="/professor" className="back"><ArrowLeft size={16} />대시보드로</Link>

      <header className="page-head">
        <div>
          <p className="eyebrow">교수 도구 · 문항 검토</p>
          <h1>학생에게 전달하기 전,<br /><span className="headline-accent">문항</span>을 한 번 더 살펴보세요</h1>
          <p className="lead">문항 자체의 위험 신호를 확인하고, 강의자료가 있으면 수업 범위와의 정렬까지 함께 살펴봅니다.</p>
        </div>
        <div className="guide">
          <button type="button" className="guide-trigger"><span className="guide-icon">?</span>사용 설명서</button>
          <div className="guide-panel">
            <h2>어떻게 사용하나요?</h2>
            <ol>
              <li><strong>문항 입력</strong>: 파일을 올리거나 문항을 직접 붙여넣습니다.</li>
              <li><strong>수업자료 추가</strong>: 선택적으로 자료를 올리면 범위와 목표 정렬까지 확인합니다.</li>
              <li><strong>교수 검토</strong>: AI의 근거와 수정 제안을 확인한 뒤 최종 판단합니다.</li>
            </ol>
          </div>
        </div>
      </header>

      <div className={hasQuestions ? 'studio-workbench quality-workbench' : 'studio-workbench quality-workbench is-upload-only'}>
        <main className="studio-main">
          <section className="studio-section card pad" aria-labelledby="question-input-title">
            <span className="studio-step-number" aria-hidden="true">1</span>
            <div className="card-head">
              <div><h2 id="question-input-title">검토할 문항</h2><p>문항 파일을 올리거나 아래에 직접 붙여넣어 주세요.</p></div>
              <div className="tag"><Badge variant="default">필수</Badge></div>
            </div>

            {!questionFile ? (
              <UploadDropZone inputRef={questionInputRef} accept={QUESTION_ACCEPT} onFile={(file) => { setQuestionFile(file); setReview(null); }} title="문항 파일을 끌어오거나 클릭해 업로드" hint="PDF, DOCX, TXT · 최대 25MB" />
            ) : (
              <div className="file-row">
                <span className="file-icon"><FileText size={20} /></span>
                <span className="file-main"><b className="file-name">{questionFile.name}</b><small className="file-meta">{(questionFile.size / 1024 / 1024).toFixed(1)} MB · 업로드 완료</small></span>
                <button type="button" aria-label="문항 파일 제거" onClick={() => { setQuestionFile(null); setReview(null); }}><X size={17} /></button>
              </div>
            )}

            <div className="quality-or"><span>또는</span></div>
            <label className="quality-paste">
              <span className="field-label">문항 직접 붙여넣기</span>
              <textarea value={questions} onChange={(event) => { setQuestions(event.target.value); setReview(null); }} placeholder={'1. 다음 중 옳은 것은?\n① ...\n② ...\n정답: ②'} />
            </label>
          </section>

          {hasQuestions && (
            <section className="studio-section card pad" aria-labelledby="material-context-title">
              <span className="studio-step-number" aria-hidden="true">2</span>
              <div className="card-head">
                <div><h2 id="material-context-title">수업자료</h2><p>업로드하면 수업 범위·목표 정렬과 근거 페이지까지 확인할 수 있어요.</p></div>
                <div className="tag tag-muted"><Badge variant="gray">선택·권장</Badge></div>
              </div>

              {!materialFile ? (
                <UploadDropZone inputRef={materialInputRef} accept={MATERIAL_ACCEPT} onFile={(file) => { setMaterialFile(file); setReview(null); }} title="수업자료를 끌어오거나 클릭해 업로드" hint="PPTX, PDF · 최대 25MB" />
              ) : (
                <div className="file-row">
                  <span className="file-icon"><FileText size={20} /></span>
                  <span className="file-main"><b className="file-name">{materialFile.name}</b><small className="file-meta">{(materialFile.size / 1024 / 1024).toFixed(1)} MB · 범위 분석에 사용</small></span>
                  <button type="button" aria-label="수업자료 제거" onClick={() => { setMaterialFile(null); setReview(null); }}><X size={17} /></button>
                </div>
              )}
            </section>
          )}

          {hasQuestions && (
            <section className="studio-section card pad" aria-labelledby="review-criteria-title">
              <span className="studio-step-number" aria-hidden="true">3</span>
              <div className="card-head"><div><h2 id="review-criteria-title">검토 기준</h2><p>문항 자체의 기준은 항상 확인하고, 수업자료가 있으면 범위 기준을 추가합니다.</p></div></div>
              <div className="quality-criteria">
                <div><span>AI가 항상 확인해요</span><p>{['복수정답', '모호성', '정답 단서', '선택지 구성', '인지 수준', '문항 중복'].map((item) => <b key={item}>{item}</b>)}</p></div>
                <div className={materialFile ? 'is-active' : ''}><span>수업자료가 있으면 추가해요</span><p>{['수업 범위', '학습목표 정렬', '내용 편중', '근거 페이지'].map((item) => <b key={item}>{item}</b>)}</p></div>
              </div>
              <div className="design-group full quality-optional">
                <div className="design-group-heading"><h3>추가 요청</h3><div className="tag tag-muted"><Badge variant="gray">선택</Badge></div></div>
                <div className="quality-request-grid">
                  <label className="field"><span className="field-label">특히 확인하고 싶은 내용</span><textarea value={focusRequest} onChange={(event) => setFocusRequest(event.target.value)} placeholder="예: 본과 2학년 수준에 적절한지 확인해주세요." /></label>
                  <label className="field"><span className="field-label">제외할 검토 기준</span><textarea value={excludedCriteria} onChange={(event) => setExcludedCriteria(event.target.value)} placeholder="예: 의학 용어 표현은 수정하지 말아주세요." /></label>
                  <label className="field"><span className="field-label">추가하고 싶은 프롬프트</span><textarea value={additionalPrompt} onChange={(event) => setAdditionalPrompt(event.target.value)} placeholder="추가 요청을 자유롭게 입력해주세요." /></label>
                </div>
              </div>
            </section>
          )}

          {error && <div className="studio-error" role="alert"><AlertTriangle size={17} />{error}</div>}

          {review && (
            <section className="quality-results card pad">
              <div className="quality-summary">
                <div><span className={`quality-verdict is-${review.overallVerdict.replace(' ', '-')}`}>{review.overallVerdict}</span><h2>문항 검토 결과</h2><p>{review.summary}</p></div>
                <dl><div><dt>문항</dt><dd>{review.items.length}</dd></div><div><dt>발견 항목</dt><dd>{issueCount}</dd></div></dl>
              </div>
              <div className="quality-distribution">
                <h3>인지 수준 분포</h3>
                <div><span>회상 <b>{review.distribution.recall}</b></span><span>이해 <b>{review.distribution.understanding}</b></span><span>적용 <b>{review.distribution.application}</b></span></div>
                {review.coverageNotes.map((note) => <p key={note}><SearchCheck size={15} />{note}</p>)}
              </div>
              <div className="quality-ledger">{review.items.map((item) => <article key={item.number}><div className="quality-item-no"><span>{item.number}</span><small>{item.verdict}</small></div><div><h3>{item.testedObjective}</h3>{item.flags.length === 0 ? <p className="quality-pass"><CheckCircle2 size={16} />뚜렷한 위험 신호를 찾지 못했습니다.</p> : item.flags.map((flag, index) => <div className="quality-flag" key={`${flag.category}-${index}`}><header><b>{flag.category}</b><span>{flag.severity}</span></header><p>{flag.message}</p><small><b>수정 제안</b>{flag.suggestion}</small></div>)}</div></article>)}</div>
            </section>
          )}
        </main>

        {!hasQuestions && <div className="studio-flow-arrow" aria-hidden="true"><span /><ArrowRight size={24} strokeWidth={2.4} /></div>}
        {!hasQuestions && <UploadNextSteps className="studio-next-flow" steps={[
          { number: 2, title: '수업자료 추가', description: '선택적으로 강의자료를 올리면 범위와 목표 정렬까지 확인합니다.' },
          { number: 3, title: 'AI 문항 검토', description: '문항 자체의 위험 신호와 자료 근거를 구분해 살펴봅니다.' },
          { number: 4, title: '수정 제안 확인', description: '판정 대신 근거와 실행 가능한 수정 제안을 제공합니다.' },
        ]} footer={<>먼저 왼쪽 <b className="text-sage-700">1. 검토할 문항</b>에서 파일을 올리거나 문항을 붙여넣어 주세요.</>} />}

        {hasQuestions && (
          <aside className="faculty-summary summary summary-hero card pad">
            <div className="card-head"><div><h2>문항 검토 요약</h2><p>분석 범위를 확인하고 검토를 시작하세요.</p></div></div>
            <dl className="summary-list">
              <div className="summary-item"><span>문항 입력</span><strong>{questionFile ? questionFile.name : '직접 붙여넣기'}</strong></div>
              <div className="summary-item"><span>수업자료</span><strong>{materialFile ? materialFile.name : '없음'}</strong></div>
              <div className="summary-item"><span>분석 범위</span><strong>{materialFile ? '문항 + 수업 정렬' : '문항 자체'}</strong></div>
              <div className="summary-item"><span>기본 기준</span><strong>6개 전체</strong></div>
            </dl>
            <button className="generate-button primary-btn" type="button" disabled={!hasQuestions || loading} onClick={analyze}>
              {loading ? <><Loader2 className="spin" size={17} />문항 검토 중</> : <>문항 검토 시작 <ArrowRight size={17} /></>}
            </button>
            <p className="summary-note note"><ShieldCheck size={14} />AI 결과는 교수 검토를 돕는 의견이며 자동 판정이나 학생 공개로 이어지지 않습니다.</p>
          </aside>
        )}
      </div>
    </div>
  );
}
