'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  Check,
  ChevronRight,
  FileText,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
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
};

type GenerateResponse = {
  title: string;
  materialSummary: string;
  objectives: string[];
  questions: Question[];
};

const ACCEPT = '.pdf,.pptx,application/pdf,application/vnd.openxmlformats-officedocument.presentationml.presentation';

export function FormativeAssessmentStudio() {
  const searchParams = useSearchParams();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [range, setRange] = useState('전체 자료');
  const [objective, setObjective] = useState('');
  const [count, setCount] = useState(5);
  const [difficulty, setDifficulty] = useState('중');
  const [mix, setMix] = useState('기전 이해 중심');
  const [excluded, setExcluded] = useState('');
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

  const progress = useMemo(() => {
    if (result) return 3;
    if (file) return 2;
    return 1;
  }, [file, result]);

  function chooseFile(next: File | undefined) {
    if (!next) return;
    setError('');
    setResult(null);
    setApproved(new Set());
    setFile(next);
  }

  async function generate() {
    if (!file) return;
    setLoading(true);
    setError('');
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('range', range);
      form.append('objective', objective);
      form.append('count', String(count));
      form.append('difficulty', difficulty);
      form.append('mix', mix);
      form.append('excluded', excluded);

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
    <div className="faculty-studio">
      <header className="studio-heading">
        <div>
          <p className="studio-context">교수 도구 · 형성평가</p>
          <h1>강의가 끝나기 전에<br />이해도를 확인하세요.</h1>
          <p className="studio-lead">
            강의자료의 근거를 벗어나지 않는 복습문항을 만들고, 교수 검수 후 학생에게 전달합니다.
          </p>
        </div>
        <div className="studio-steps" aria-label="진행 단계">
          {['자료', '설계', '검수'].map((label, index) => (
            <div key={label} className={progress >= index + 1 ? 'is-current' : ''}>
              <span>{progress > index + 1 ? <Check size={14} /> : index + 1}</span>
              <b>{label}</b>
            </div>
          ))}
        </div>
      </header>

      <div className="studio-workbench">
        <main className="studio-main">
          <section className="studio-section" aria-labelledby="material-title">
            <div className="section-heading">
              <div>
                <h2 id="material-title">강의자료</h2>
                <p>PPTX 또는 PDF 한 개를 올려주세요. 원본은 변경하지 않습니다.</p>
              </div>
              {file && <span className="status-copy"><ShieldCheck size={15} /> 교수 검수 전 비공개</span>}
            </div>

            {!file ? (
              <button className="material-drop" type="button" onClick={() => inputRef.current?.click()}>
                <Upload size={22} />
                <span><b>강의자료 선택</b><small>PPTX, PDF · 최대 25MB</small></span>
                <ChevronRight size={18} />
              </button>
            ) : (
              <div className="material-file">
                <FileText size={22} />
                <span><b>{file.name}</b><small>{(file.size / 1024 / 1024).toFixed(1)} MB</small></span>
                <button type="button" aria-label="파일 제거" onClick={() => setFile(null)}><X size={17} /></button>
              </div>
            )}
            <input ref={inputRef} hidden type="file" accept={ACCEPT} onChange={(event) => chooseFile(event.target.files?.[0])} />
          </section>

          <section className="studio-section" aria-labelledby="design-title">
            <div className="section-heading">
              <div>
                <h2 id="design-title">문항 설계</h2>
                <p>프롬프트 대신 수업 의도만 선택하면 됩니다.</p>
              </div>
            </div>

            <div className="form-grid">
              <label><span>출제 범위</span><input value={range} onChange={(e) => setRange(e.target.value)} placeholder="예: 12–28쪽, 부정맥 약물" /></label>
              <label><span>학습목표</span><input value={objective} onChange={(e) => setObjective(e.target.value)} placeholder="비워두면 자료에서 추출" /></label>
              <label><span>문항 수</span><select value={count} onChange={(e) => setCount(Number(e.target.value))}>{[3, 5, 8, 10].map((n) => <option key={n} value={n}>{n}문항</option>)}</select></label>
              <label><span>난이도</span><select value={difficulty} onChange={(e) => setDifficulty(e.target.value)}><option>하</option><option>중</option><option>상</option></select></label>
              <label><span>인지 수준</span><select value={mix} onChange={(e) => setMix(e.target.value)}><option>핵심 회상 중심</option><option>기전 이해 중심</option><option>임상 적용 중심</option><option>균형 있게</option></select></label>
              <label><span>제외할 내용</span><input value={excluded} onChange={(e) => setExcluded(e.target.value)} placeholder="예: 용량 암기, 희귀 부작용" /></label>
            </div>
          </section>

          {error && <div className="studio-error" role="alert"><AlertTriangle size={17} />{error}</div>}

          {result && (
            <section className="studio-section review-section" aria-labelledby="review-title">
              <div className="section-heading">
                <div>
                  <h2 id="review-title">검수할 문항</h2>
                  <p>{result.materialSummary}</p>
                </div>
                <span className="approval-count">{approved.size}/{result.questions.length} 승인</span>
              </div>
              <div className="objective-strip">
                {result.objectives.map((item) => <span key={item}>{item}</span>)}
              </div>
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

        <aside className="studio-summary">
          <div className="summary-title"><Sparkles size={18} /><h2>형성평가 초안</h2></div>
          <dl>
            <div><dt>저장할 강의</dt><dd><select value={courseId} onChange={(event) => setCourseId(event.target.value)}><option value="">강의 선택</option>{courses.map((course) => <option key={course.id} value={course.id}>{course.title}</option>)}</select></dd></div>
            <div><dt>자료</dt><dd>{file?.name ?? '선택 전'}</dd></div>
            <div><dt>범위</dt><dd>{range}</dd></div>
            <div><dt>구성</dt><dd>{count}문항 · {difficulty}</dd></div>
            <div><dt>초점</dt><dd>{mix}</dd></div>
          </dl>
          {!result ? (
            <button className="generate-button" type="button" disabled={!file || loading} onClick={generate}>
              {loading ? <><Loader2 className="spin" size={17} /> 자료 분석 중</> : <><Sparkles size={17} /> 초안 생성</>}
            </button>
          ) : (
            savedId ? <a className="generate-button" href={`/professor/artifacts/${savedId}`}>저장됨 · 문항 검토하기</a> : <button className="generate-button" type="button" disabled={!courseId || loading} onClick={saveToCourse}>강의에 저장하고 검토하기</button>
          )}
          <p className="summary-note">AI가 만든 초안입니다. 학생 공개 전 교수의 내용 검수가 필요합니다.</p>
        </aside>
      </div>
    </div>
  );
}
