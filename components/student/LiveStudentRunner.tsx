'use client';

import Link from 'next/link';
import { ArrowRight, BookOpen, BookOpenCheck, ClipboardCheck } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { createBrowserClient } from '@/lib/db/browser';
import { readApiResponse } from '@/lib/utils/read-api-response';
import './live-student.css';
import './live-student-save.css';
import '../formative/formative-flow.css';
import { PRIVACY_VERSION } from '@/lib/legal/config';

const storageKey = (code: string) => `lecturelink-live:${code}`;
const previewQuestions = [
  { id: 'preview-q1', stem: '다음 중 강의에서 설명한 핵심 개념으로 가장 적절한 것은?', choices: ['핵심 개념을 정확히 설명한 선택지', '일부 조건만 포함한 선택지', '강의 범위를 벗어난 선택지', '반대 의미의 선택지', '근거가 부족한 선택지'], answerIndex: 0, explanation: '첫 번째 선택지는 강의자료의 핵심 내용을 정확하게 요약합니다.' },
  { id: 'preview-q2', stem: '학습한 원리를 실제 상황에 적용한 예로 가장 적절한 것은?', choices: ['조건을 일부만 반영한 사례', '핵심 조건을 모두 반영한 사례', '원인과 결과를 반대로 연결한 사례', '자료에서 다루지 않은 사례', '판단 정보가 부족한 사례'], answerIndex: 1, explanation: '두 번째 사례는 강의에서 제시한 조건과 판단 순서를 모두 반영합니다.' },
  { id: 'preview-q3', stem: '다음 설명 중 강의자료의 내용과 일치하지 않는 것은?', choices: ['주요 정의에 관한 설명', '기본 원리에 관한 설명', '판단 순서에 관한 설명', '강의 내용과 반대되는 설명', '주의사항에 관한 설명'], answerIndex: 3, explanation: '네 번째 선택지는 강의에서 설명한 방향과 반대입니다.' },
];

function previewPayload(mode: string | null) {
  const lobby = mode === 'lobby';
  const ended = mode === 'result';
  const submitted = mode === 'submitted' || ended;
  return {
    session: { id: 'preview', title: '순환기학 형성평가', status: lobby ? 'lobby' : ended ? 'ended' : 'live' },
    participant: { id: 'preview-student', name: '김민준', status: submitted ? 'submitted' : 'joined', score: ended ? 2 : null, total: 3 },
    questions: previewQuestions,
    answers: ended ? [{ item_id: 'preview-q1', selected_index: 0 }, { item_id: 'preview-q2', selected_index: 2 }, { item_id: 'preview-q3', selected_index: 3 }] : [],
  };
}

export function LiveStudentRunner() {
  const search = useSearchParams();
  const previewMode = process.env.NODE_ENV === 'development' ? search.get('preview') : null;
  const isPreview = Boolean(previewMode);
  const initialCode = search.get('code')?.toUpperCase() ?? '';
  const [code, setCode] = useState(initialCode);
  const [name, setName] = useState('');
  const [sessionId, setSessionId] = useState(isPreview ? 'preview' : '');
  const [token, setToken] = useState(isPreview ? 'preview' : '');
  const [data, setData] = useState<any>(isPreview ? previewPayload(previewMode) : undefined);
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<Record<string, number>>(isPreview && previewMode === 'result' ? { 'preview-q1': 0, 'preview-q2': 2, 'preview-q3': 3 } : {});
  const [error, setError] = useState('');
  const [loggedIn, setLoggedIn] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [savedUploadId, setSavedUploadId] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [privacyAccepted, setPrivacyAccepted] = useState(false);
  const [assessmentNotice, setAssessmentNotice] = useState<{ title: string; professorName: string; institutionName: string | null } | null>(null);

  useEffect(() => { if (!isPreview) createBrowserClient().auth.getUser().then(({ data: auth }) => setLoggedIn(Boolean(auth.user))); }, [isPreview]);
  useEffect(() => {
    if (isPreview || code.length !== 6 || sessionId) { setAssessmentNotice(null); setPrivacyAccepted(false); return; }
    const timer = window.setTimeout(async () => {
      const response = await fetch('/api/public/live-assessments/notice', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
      const payload = await response.json().catch(() => null);
      if (response.ok && payload?.ok) { setAssessmentNotice(payload.data); setError(''); }
      else { setAssessmentNotice(null); setPrivacyAccepted(false); setError(payload?.error?.message ?? '평가 안내를 확인하지 못했습니다.'); }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [code, isPreview, sessionId]);
  useEffect(() => { if (isPreview || !initialCode) return; const raw = localStorage.getItem(storageKey(initialCode)); if (!raw) return; try { const saved = JSON.parse(raw); setSessionId(saved.sessionId); setToken(saved.token); } catch { localStorage.removeItem(storageKey(initialCode)); } }, [initialCode, isPreview]);

  const load = useCallback(async () => {
    if (isPreview || !sessionId || !token) return;
    const response = await fetch(`/api/public/live-assessments/${sessionId}`, { headers: { authorization: `Bearer ${token}` } });
    const payload = await response.json();
    if (payload.ok) { setData(payload.data); setAnswers(Object.fromEntries(payload.data.answers.map((answer: any) => [answer.item_id, answer.selected_index]))); }
    else setError(payload.error?.message);
  }, [isPreview, sessionId, token]);

  useEffect(() => { if (isPreview) return; load(); const timer = setInterval(load, 2500); return () => clearInterval(timer); }, [isPreview, load]);

  const saveToLibrary = useCallback(async () => {
    if (isPreview) { setSaveState('saved'); setSavedUploadId('preview'); return; }
    if (!sessionId || !token || saveState !== 'idle') return;
    setSaveState('saving'); setError('');
    const response = await fetch(`/api/live-assessments/${sessionId}/save`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
    const payload = await response.json();
    if (response.status === 401) { const next = `/join?code=${encodeURIComponent(code)}&save=1`; window.location.href = `/login?next=${encodeURIComponent(next)}`; return; }
    if (!payload.ok) { setSaveState('idle'); setError(payload.error?.message ?? '문항을 저장하지 못했습니다.'); return; }
    setSavedUploadId(payload.data.uploadId); setSaveState('saved');
  }, [code, isPreview, saveState, sessionId, token]);

  useEffect(() => { if (search.get('save') === '1' && loggedIn && data?.session?.status === 'ended') saveToLibrary(); }, [data?.session?.status, loggedIn, saveToLibrary, search]);

  async function join() {
    setError('');
    if (!privacyAccepted) { setError('개인정보 수집·공유 안내를 확인해 주세요.'); return; }
    const response = await fetch('/api/public/live-assessments', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code, name, privacyAccepted, privacyVersion: PRIVACY_VERSION }) });
    const payload = await response.json();
    if (!payload.ok) { setError(payload.error?.message); return; }
    localStorage.setItem(storageKey(code.toUpperCase()), JSON.stringify(payload.data)); setSessionId(payload.data.sessionId); setToken(payload.data.token);
  }

  async function choose(itemId: string, choiceIndex: number) {
    setAnswers((current) => ({ ...current, [itemId]: choiceIndex }));
    if (isPreview) return;
    const response = await fetch(`/api/public/live-assessments/${sessionId}/answers`, { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ itemId, selectedIndex: choiceIndex }) });
    if (!response.ok) { setError('저장하지 못했습니다. 연결을 확인한 뒤 다시 선택해주세요.'); load(); }
  }

  async function submit() {
    if (submitting) return;
    const missing = data.questions.length - Object.keys(answers).length;
    if (!confirm(missing ? `미응답 문항이 ${missing}개 있습니다. 제출할까요?` : '제출 후에는 답안을 수정할 수 없습니다. 제출할까요?')) return;
    if (isPreview) { setData((current: any) => ({ ...current, participant: { ...current.participant, status: 'submitted' } })); return; }
    setSubmitting(true); setError('');
    try {
      const response = await fetch(`/api/public/live-assessments/${sessionId}/submit`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      const payload = await readApiResponse<{ submitted: boolean }>(response, '답안을 제출하지 못했습니다.');
      if (!response.ok || !payload.ok) { setError(payload.error?.message ?? '답안을 제출하지 못했습니다.'); return; }
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '답안을 제출하지 못했습니다.');
    } finally {
      setSubmitting(false);
    }
  }

  const root = 'student-live ll-student-formative-flow';
  if (!sessionId) return <main className={`${root} join-page`}><div className="join-shell"><Link className="join-brand" href="/" aria-label="LectureLink 홈으로"><span aria-hidden="true"><BookOpen /></span><b>LectureLink</b></Link><section className="join-panel"><div className="join-intro"><div className="join-heading"><p className="join-eyebrow">LectureLink 실시간 평가</p><h1><span>형성평가</span>에 참여하세요</h1></div><div className="join-illustration" aria-hidden="true"><span><BookOpenCheck /></span><i /><i /><i /></div></div><p className="join-description">교수자가 안내한 참여 코드와 이름을 입력해주세요.</p><form onSubmit={(event) => { event.preventDefault(); void join(); }}><label><span>참여 코드</span><input value={code} maxLength={6} inputMode="text" autoComplete="one-time-code" onChange={(event) => setCode(event.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase())} placeholder="6자리 코드" /></label><label><span>이름</span><input value={name} maxLength={40} autoComplete="name" onChange={(event) => setName(event.target.value)} placeholder="이름을 입력하세요" /></label>{assessmentNotice && <div className="join-assessment-owner"><b>{assessmentNotice.title}</b><span>{[assessmentNotice.institutionName, assessmentNotice.professorName].filter(Boolean).join(' · ')}</span></div>}<label className="join-privacy"><input type="checkbox" checked={privacyAccepted} disabled={!assessmentNotice} onChange={(event) => { setPrivacyAccepted(event.target.checked); setError(''); }} /><span><b>개인정보 수집·공유 안내를 확인했습니다. (필수)</b><small>이름, 답안, 점수와 접속 기록은 평가 운영·결과 제공을 위해 수집되어 위 평가 개설자에게 제공되며, 평가 종료 후 1년간 보관됩니다. 동의하지 않으면 평가에 참여할 수 없습니다. <Link href="/privacy" target="_blank">자세히 보기</Link></small></span></label>{error && <div className="live-error" role="alert">{error}</div>}<button type="submit" disabled={code.length !== 6 || !name.trim() || !privacyAccepted || !assessmentNotice}><span>참여하기</span><i className="join-button-icon" aria-hidden="true"><ArrowRight /></i></button></form><p className="join-save-note">형성평가 종료 후 로그인하면 형성평가 문항과 결과를 저장할 수 있어요.</p></section><p className="join-footer">강의와 학습을 연결하는 LectureLink</p></div></main>;
  if (!data) return <main className={root}><section className="join-panel">참여 정보를 불러오는 중입니다.</section></main>;
  const session = data.session, participant = data.participant;
  if (session.status === 'lobby') return <main className={`${root} lobby-page`}><section className="waiting lobby-waiting"><span className="waiting-badge">입장 완료</span><h1>{session.title}</h1><p>{participant.name}님, 교수님이 평가를 시작할 때까지<br />기다려주세요.</p><div className="pulse" /></section></main>;
  if (participant.status === 'submitted' && session.status !== 'ended') return <main className={`${root} submitted-page`}><div className="submitted-shell"><Link className="join-brand" href="/" aria-label="LectureLink 홈으로"><span aria-hidden="true"><BookOpen /></span><b>LectureLink</b></Link><section className="waiting submitted-card"><div className="submitted-illustration" aria-hidden="true"><span><ClipboardCheck /></span><i /><i /></div><span className="waiting-badge">제출 완료</span><h1><span>형성평가가</span><br />제출되었습니다.</h1><p className="submitted-copy">교수님이 평가를 종료하면<br />결과를 확인할 수 있습니다.</p><p className="submitted-save-note">형성평가 종료 후 로그인하면 형성평가 문항과 결과를 저장할 수 있어요.</p></section></div></main>;
  if (session.status === 'ended') { const correct = data.questions.filter((question: any) => answers[question.id] === question.answerIndex).length, score = participant.score ?? correct, total = participant.total ?? data.questions.length; return <main className={`${root} result-page`}><section className="result-hero"><p>평가 결과</p><h1>{score} / {total}</h1><span>정답률 {Math.round(score / Math.max(1, total) * 100)}%</span><div className="save-panel">{saveState === 'saved' ? <><strong>형성평가 문제집에 저장했습니다.</strong><Link href={`/library?set=${savedUploadId}`}>저장한 문항 복습하기</Link></> : <><p>문항과 정답을 내 문제집에 보관하고 언제든 다시 복습하세요.</p><button disabled={saveState === 'saving'} onClick={saveToLibrary}>{saveState === 'saving' ? '저장하는 중…' : loggedIn ? '내 문제집에 저장하기' : '로그인하고 문항 저장하기'}</button></>}{error && <div className="live-error">{error}</div>}</div></section><section className="review-list">{data.questions.map((question: any, questionIndex: number) => <article key={question.id}><b><span aria-hidden="true">{questionIndex + 1}</span>{question.stem}</b>{question.choices.map((choice: string, choiceIndex: number) => <div className={choiceIndex === question.answerIndex ? 'correct' : answers[question.id] === choiceIndex ? 'wrong' : ''} key={choiceIndex}>{choiceIndex + 1}. {choice}{answers[question.id] === choiceIndex ? ' · 내 선택' : ''}</div>)}<p><strong>해설</strong> {question.explanation}</p></article>)}</section></main>; }
  const question = data.questions[index];
  return <main className={`${root} runner`}><header><span>{session.title}</span><b>{index + 1} / {data.questions.length}</b></header><div className="progress"><i style={{ width: `${(index + 1) / data.questions.length * 100}%` }} /></div><article><h1>{question.stem}</h1>{question.imageDataUrl && <img src={question.imageDataUrl} alt="문항 참고 자료" />}<div>{question.choices.map((choice: string, choiceIndex: number) => <button className={answers[question.id] === choiceIndex ? 'selected' : ''} onClick={() => choose(question.id, choiceIndex)} key={choiceIndex}><b>{choiceIndex + 1}</b>{choice}</button>)}</div></article><footer><button disabled={index === 0 || submitting} onClick={() => setIndex(index - 1)}>이전</button>{index < data.questions.length - 1 ? <button className="runner-next" disabled={submitting} onClick={() => setIndex(index + 1)}><span>다음</span><ArrowRight aria-hidden="true" /></button> : <button className="submit" disabled={submitting} onClick={submit}>{submitting ? '제출 중…' : '제출 완료'}</button>}</footer>{error && <div className="toast" role="alert">{error}</div>}</main>;
}
