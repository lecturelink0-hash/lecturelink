'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  FileText,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/Badge';
import { UploadDropZone } from '@/components/ui/UploadDropZone';
import { UploadNextSteps } from '@/components/ui/UploadNextSteps';
import { Segmented } from '@/components/ui/Segmented';
import './formative-studio.css';

type Question = {
  id: string;
  stem: string;
  choices: string[];
  answerIndex: number;
  explanation: string;
  objective: string;
  sourcePages: number[];
  cognitiveLevel: '회상' | '이해' | '적용';
  qualityFlags: string[];
  imageDataUrl: string | null;
};

type GenerateResponse = {
  title: string;
  materialSummary: string;
  objectives: string[];
  questions: Question[];
  reviewSummary: string;
  imageAnalysis: {
    requested: boolean;
    candidateCount: number;
    warnings: string[];
  };
};

const ACCEPT = '.pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function FormativeAssessmentStudio() {
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [rangeMode, setRangeMode] = useState<'전체 자료' | '페이지 선택'>('전체 자료');
  const [pageRange, setPageRange] = useState('');
  const [include, setInclude] = useState('');
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState('중');
  const [excluded, setExcluded] = useState('');
  const [additionalPrompt, setAdditionalPrompt] = useState('');
  const [useImages, setUseImages] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<GenerateResponse | null>(null);
  const [approved, setApproved] = useState<Set<string>>(new Set());
  const [courses, setCourses] = useState<Array<{ id: string; title: string }>>([]);
  const [courseId, setCourseId] = useState(searchParams.get('course') ?? '');
  const [savedId, setSavedId] = useState('');

  useEffect(() => {
    fetch('/api/professor/courses').then((response) => response.json()).then((payload) => {
      if (payload.ok) setCourses(payload.data);
    });
  }, []);

  function chooseFile(next: File | undefined) {
    if (!next) return;
    setError('');
    setResult(null);
    setApproved(new Set());
    setFile(next);
  }

  async function generate() {
    if (!file || (rangeMode === '페이지 선택' && !pageRange.trim())) return;
    setLoading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('range', rangeMode === '전체 자료' ? '전체 자료' : pageRange.trim());
      form.append('objective', include);
      form.append('count', String(count));
      form.append('difficulty', difficulty);
      form.append('excluded', excluded);
      form.append('additionalPrompt', additionalPrompt);
      form.append('useImages', String(useImages));

      const response = await fetch('/api/faculty/formative/generate', {
        method: 'POST',
        body: form,
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) {
        throw new Error(payload?.error?.message ?? '형성평가를 생성하지 못했습니다.');
      }
      setResult(payload.data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '형성평가를 생성하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  function toggleApproved(id: string) {
    setApproved((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function saveToCourse() {
    if (!result || !courseId) return;
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/professor/courses/${courseId}/formative`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title: result.title, sourceName: file?.name, summary: result.materialSummary, objectives: result.objectives, questions: result.questions }),
      });
      const payload = await response.json();
      if (!payload.ok) throw new Error(payload.error?.message ?? '저장하지 못했습니다.');
      setSavedId(payload.data.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '저장하지 못했습니다.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="faculty-studio ll-upload-page">
      <Link href="/professor" className="back"><ArrowLeft size={16} />대시보드로</Link>
      <header className="page-head">
        <div>
          <p className="eyebrow">교수 도구 · 형성평가</p>
          <h1>강의의 끝에서,<br /><span className="headline-accent">형성평가</span>로 <span className="headline-accent">이해도</span>를 확인하세요</h1>
          <p className="lead">
            강의자료의 근거를 벗어나지 않는 복습문항을 만들고, 교수 검수 후 학생에게 전달합니다.
          </p>
        </div>
        <div className="guide">
          <button type="button" className="guide-trigger"><span className="guide-icon">?</span>사용 설명서</button>
          <div className="guide-panel">
            <h2>어떻게 사용하나요?</h2>
            <ol>
              <li><strong>강의자료 업로드</strong>: 형성평가의 근거가 될 PPTX 또는 PDF를 올립니다.</li>
              <li><strong>문항 설계</strong>: 출제 범위와 학습목표, 난이도를 선택합니다.</li>
              <li><strong>교수 검수</strong>: 생성된 문항을 확인하고 승인한 뒤 차시에 저장합니다.</li>
            </ol>
          </div>
        </div>
      </header>

      <div className={file ? 'studio-workbench' : 'studio-workbench is-upload-only'}>
        <main className="studio-main">
          <section className="studio-section material-section card pad" aria-labelledby="material-title">
            <span className="studio-step-number" aria-hidden="true">1</span>
            <div className="card-head">
              <div>
                <h2 id="material-title">강의자료 업로드</h2>
                <p>형성평가의 근거로 사용할 PPTX 또는 PDF 한 개를 올려주세요.</p>
              </div>
              <div className="tag"><Badge variant="default">필수</Badge></div>
            </div>
            {file && <span className="status-copy"><ShieldCheck size={15} /> 교수 검수 전 비공개</span>}

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
                <button type="button" aria-label="파일 제거" onClick={() => setFile(null)}><X size={17} /></button>
              </div>
            )}
          </section>

          {file && <section className="studio-section design-section card pad" aria-labelledby="design-title">
            <span className="studio-step-number" aria-hidden="true">2</span>
            <div className="card-head">
              <div>
                <h2 id="design-title">문항 설계</h2>
                <p>프롬프트 대신 수업 의도만 선택하면 됩니다.</p>
              </div>
            </div>

            <div className="form-grid studio-design-grid">
              <div className="design-group full">
                <div className="design-group-heading">
                  <h3>필수 설정</h3>
                  <div className="tag"><Badge variant="default">필수</Badge></div>
                </div>
                <div className="required-settings-grid">
                  <div className="field full">
                    <span className="field-label">출제 범위</span>
                    <Segmented options={['전체 자료', '페이지 선택'] as const} value={rangeMode} onChange={setRangeMode} ariaLabel="출제 범위" />
                    {rangeMode === '페이지 선택' && (
                      <input className="page-range-input" value={pageRange} maxLength={120} onChange={(event) => setPageRange(event.target.value)} placeholder="예: 1~3, 5, 8~10" aria-label="출제할 페이지" />
                    )}
                  </div>
                  <div className="field">
                    <div className="range-head">
                      <span className="field-label">문항 수</span>
                      <strong className="range-value">{count}<span>문항</span></strong>
                    </div>
                    <input type="range" min="1" max="10" step="1" value={count} onChange={(event) => setCount(Number(event.target.value))} aria-label="문항 수" />
                    <div className="range-scale"><span>1</span><span>5</span><span>10</span></div>
                  </div>
                  <div className="field">
                    <span className="field-label">난이도</span>
                    <Segmented options={['하', '중', '상'] as const} value={difficulty} onChange={setDifficulty} ariaLabel="난이도" />
                  </div>
                  <label className="field full image-option">
                    <span className="image-option-control">
                      <input
                        type="checkbox"
                        checked={useImages}
                        onChange={(event) => setUseImages(event.target.checked)}
                      />
                      <span>
                        <b>강의자료 이미지 사용</b>
                        <small>자료 속 X-ray, CT, ECG, 병리 이미지 등을 분석해 이미지 문항에 활용합니다.</small>
                      </span>
                    </span>
                    <span className="image-option-note">
                      이미지를 사용하면 생성 시간이 조금 더 오래 걸릴 수 있지만, 시각 자료의 임상 맥락을 반영해 문항의 퀄리티를 높일 수 있습니다.
                    </span>
                  </label>
                </div>
              </div>

              <div className="design-group full optional-settings">
                <div className="design-group-heading">
                  <h3>추가 요청</h3>
                  <div className="tag tag-muted"><Badge variant="gray">선택</Badge></div>
                </div>
                <div className="optional-settings-grid">
                  <label className="field">
                    <span className="field-label">꼭 포함할 내용</span>
                    <textarea maxLength={300} value={include} onChange={(event) => setInclude(event.target.value)} placeholder="예: 항부정맥 약물의 작용 기전을 꼭 포함해 주세요." />
                    <small className="field-counter">{include.length}/300</small>
                  </label>
                  <label className="field">
                    <span className="field-label">제외할 내용</span>
                    <textarea maxLength={300} value={excluded} onChange={(event) => setExcluded(event.target.value)} placeholder="예: 세부 용량이나 부작용 암기 문항은 제외해 주세요." />
                    <small className="field-counter">{excluded.length}/300</small>
                  </label>
                  <label className="field">
                    <span className="field-label">추가하고 싶은 프롬프트</span>
                    <textarea maxLength={500} value={additionalPrompt} onChange={(event) => setAdditionalPrompt(event.target.value)} placeholder="문항을 만들 때 추가로 반영할 요청을 자유롭게 입력해 주세요." />
                    <small className="field-counter">{additionalPrompt.length}/500</small>
                  </label>
                </div>
              </div>
            </div>
          </section>}

          {error && <div className="studio-error" role="alert"><AlertTriangle size={17} />{error}</div>}

          {result && (
            <section className="studio-section review-section card pad" aria-labelledby="review-title">
              <div className="card-head">
                <div>
                  <h2 id="review-title">검수할 문항</h2>
                  <p>{result.materialSummary}</p>
                </div>
                <span className="approval-count">{approved.size}/{result.questions.length} 승인</span>
              </div>
              <div className="objective-strip">
                {result.objectives.map((item) => <span key={item}>{item}</span>)}
              </div>
              <div className="verification-summary">
                <ShieldCheck size={16} />
                <span><b>자동 검증 완료</b>{result.reviewSummary}</span>
              </div>
              {result.imageAnalysis.requested && (
                <div className={result.imageAnalysis.candidateCount > 0 ? 'image-analysis-status' : 'image-analysis-status is-warning'}>
                  {result.imageAnalysis.candidateCount > 0
                    ? `크롭된 이미지 후보 ${result.imageAnalysis.candidateCount}개를 분석했습니다.`
                    : result.imageAnalysis.warnings.join(' ') || '사용 가능한 이미지 후보를 찾지 못했습니다.'}
                </div>
              )}
              <div className="question-list">
                {result.questions.map((question, index) => (
                  <article className={approved.has(question.id) ? 'question is-approved' : 'question'} key={question.id}>
                    <div className="question-topline">
                      <span className="question-number">{String(index + 1).padStart(2, '0')}</span>
                      <div className="question-meta">
                        <span>{question.cognitiveLevel}</span>
                        <span>근거 {question.sourcePages.length ? `${question.sourcePages.join(', ')}쪽` : '자료 전체'}</span>
                      </div>
                      <button type="button" className="edit-button" disabled title="MVP 다음 단계에서 문항 직접 편집을 지원합니다"><Pencil size={15} /> 편집</button>
                    </div>
                    <h3>{question.stem}</h3>
                    {question.imageDataUrl && (
                      <div className="formative-question-image">
                        <img src={question.imageDataUrl} alt={`문항 ${index + 1} 참고 이미지`} />
                      </div>
                    )}
                    <ol>
                      {question.choices.map((choice, choiceIndex) => (
                        <li className={choiceIndex === question.answerIndex ? 'is-answer' : ''} key={choice}>
                          <span>{choiceIndex + 1}</span>{choice}
                          {choiceIndex === question.answerIndex && <Check size={15} />}
                        </li>
                      ))}
                    </ol>
                    <div className="question-rationale">
                      <b>해설</b><p>{question.explanation}</p>
                      <small>학습목표 · {question.objective}</small>
                    </div>
                    {question.qualityFlags.length > 0 && (
                      <div className="quality-flags"><AlertTriangle size={15} /><span>{question.qualityFlags.join(' · ')}</span></div>
                    )}
                    <button type="button" className="approve-button" onClick={() => toggleApproved(question.id)}>
                      {approved.has(question.id) ? <><Check size={16} /> 승인됨</> : <><Plus size={16} /> 문항 승인</>}
                    </button>
                  </article>
                ))}
              </div>
            </section>
          )}
        </main>

        {!file && (
          <div className="studio-flow-arrow" aria-hidden="true">
            <span />
            <ArrowRight size={24} strokeWidth={2.4} />
          </div>
        )}

        {!file && (
          <UploadNextSteps
            className="studio-next-flow"
            steps={[
              { number: 2, title: '문항 설계', description: '출제 범위·문항 수·난이도를 선택합니다.' },
              { number: 3, title: '형성평가 생성', description: '강의자료의 근거 안에서 복습문항 초안을 만듭니다.' },
              { number: 4, title: '검수 후 저장', description: '교수가 승인한 문항만 차시에 저장하고 배포합니다.' },
            ]}
            footer={<>먼저 왼쪽 <b className="text-sage-700">1. 강의자료 업로드</b>에서 파일을 선택해주세요.</>}
          />
        )}

        {file && <aside className="faculty-summary summary summary-hero card pad">
          <div className="card-head">
            <div>
              <h2>형성평가 초안</h2>
              <p>설정을 확인하고 초안 생성을 시작하세요.</p>
            </div>
          </div>
          <dl className="summary-list">
            <div className="summary-item"><span>저장할 차시</span><strong><select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">차시 선택</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></strong></div>
            <div className="summary-item"><span>자료</span><strong>{file?.name ?? '선택 전'}</strong></div>
            <div className="summary-item"><span>범위</span><strong>{rangeMode === '전체 자료' ? '전체 자료' : pageRange || '페이지 미입력'}</strong></div>
            <div className="summary-item"><span>구성</span><strong>{count}문항 · {difficulty}</strong></div>
            <div className="summary-item"><span>이미지</span><strong>{useImages ? '사용' : '사용 안 함'}</strong></div>
          </dl>
          {!result ? (
            <button className="generate-button primary-btn" type="button" disabled={!file || loading || (rangeMode === '페이지 선택' && !pageRange.trim())} onClick={generate}>
              {loading ? <><Loader2 className="spin" size={17} /> {useImages ? '텍스트와 이미지 분석 중' : '자료 분석 중'}</> : <>초안 생성 <ArrowRight size={17} /></>}
            </button>
          ) : (
            savedId ? <a className="generate-button primary-btn" href={`/professor/artifacts/${savedId}`}>차시에 저장됨 · 문항 검토하기</a> : <button className="generate-button primary-btn" type="button" disabled={!courseId || loading} onClick={saveToCourse}>차시에 저장하고 검토하기</button>
          )}
          <p className="summary-note note">AI가 만든 초안입니다. 학생 공개 전 교수의 내용 검수가 필요합니다.</p>
        </aside>}
      </div>
    </div>
  );
}
