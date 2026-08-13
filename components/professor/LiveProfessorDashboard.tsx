'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, CheckCircle2, Download, ExternalLink, FileText, Link2, Medal, Play, Square, Users, UserX } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { createBrowserClient } from '@/lib/db/browser';
import { readApiResponse } from '@/lib/utils/read-api-response';
import { GuideLabel } from '@/components/ui/GuideLabel';
import './live-assessment.css';
import './live-assessment-progress.css';
import './live-assessment-results.css';
import '../formative/formative-flow.css';

const previewQuestions = [
  { id: 'preview-q1', stem: '다음 중 강의에서 설명한 핵심 개념으로 가장 적절한 것은?', choices: ['핵심 개념을 정확히 설명한 선택지', '일부 조건만 포함한 선택지', '강의 범위를 벗어난 선택지', '반대 의미의 선택지', '근거가 부족한 선택지'], answerIndex: 0, explanation: '핵심 조건을 모두 포함한 설명이 정답입니다.', objective: '핵심 개념 구분', sourcePages: [4] },
  { id: 'preview-q2', stem: '학습한 원리를 실제 상황에 적용한 예로 가장 적절한 것은?', choices: ['조건을 일부만 반영한 사례', '핵심 조건을 모두 반영한 사례', '원인과 결과를 반대로 연결한 사례', '자료에서 다루지 않은 사례', '판단 정보가 부족한 사례'], answerIndex: 1, explanation: '원리를 적용할 때는 제시된 핵심 조건을 모두 확인해야 합니다.', objective: '원리의 실제 적용', sourcePages: [7, 8] },
  { id: 'preview-q3', stem: '다음 설명 중 강의자료의 내용과 일치하지 않는 것은?', choices: ['주요 정의에 관한 설명', '기본 원리에 관한 설명', '판단 순서에 관한 설명', '강의 내용과 반대되는 설명', '주의사항에 관한 설명'], answerIndex: 3, explanation: '4번은 강의에서 설명한 방향과 반대되는 진술입니다.', objective: '강의 핵심 내용 판별', sourcePages: [11] },
];

const previewJoinedAt = '2026-08-10T09:00:00.000Z';

const previewParticipants = [
  { id: 'p1', name: '김민준', status: 'submitted', score: 3, total: 3, joined_at: previewJoinedAt, submitted_at: '2026-08-10T09:04:15.000Z', live_assessment_answers: [{ item_id: 'preview-q1', selected_index: 0 }, { item_id: 'preview-q2', selected_index: 1 }, { item_id: 'preview-q3', selected_index: 3 }] },
  { id: 'p2', name: '이서연', status: 'submitted', score: 2, total: 3, joined_at: previewJoinedAt, submitted_at: '2026-08-10T09:03:42.000Z', live_assessment_answers: [{ item_id: 'preview-q1', selected_index: 0 }, { item_id: 'preview-q2', selected_index: 2 }, { item_id: 'preview-q3', selected_index: 3 }] },
  { id: 'p3', name: '박지훈', status: 'joined', score: null, total: 3, joined_at: previewJoinedAt, live_assessment_answers: [{ item_id: 'preview-q1', selected_index: 1 }] },
];

const previewData = {
  session: { id: 'preview', title: '부정맥 약물 형성평가', status: 'lobby', join_code: '482731', question_snapshot: previewQuestions },
  participants: previewParticipants,
};

export function LiveProfessorDashboard({ sessionId }: { sessionId: string }) {
  const isPreview = sessionId === 'preview' && process.env.NODE_ENV === 'development';
  const [data, setData] = useState<any>(isPreview ? previewData : undefined);
  const [error, setError] = useState('');
  const [actionPending, setActionPending] = useState<'start' | 'end' | 'remove' | null>(null);
  const [resultTab, setResultTab] = useState<'responses' | 'weaknesses'>('responses');
  const [evidenceQuestion, setEvidenceQuestion] = useState<any>(null);
  const qr = useRef<HTMLCanvasElement>(null);

  const load = useCallback(() => {
    if (isPreview) return Promise.resolve();
    return fetch(`/api/professor/live-sessions/${sessionId}`)
      .then(async (response) => ({ response, payload: await readApiResponse<any>(response, '평가실 상태를 불러오지 못했습니다.') }))
      .then(({ response, payload }) => {
        if (response.ok && payload.ok && payload.data) {
          setData((current: any) => ({
            ...payload.data,
            sourceMaterial: current?.sourceMaterial?.url && current.sourceMaterial.fileName === payload.data.sourceMaterial?.fileName
              ? current.sourceMaterial
              : payload.data.sourceMaterial,
          }));
          setError('');
        }
        else setError(payload.error?.message ?? '평가실 상태를 불러오지 못했습니다.');
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : '평가실 상태를 불러오지 못했습니다.'));
  }, [isPreview, sessionId]);

  useEffect(() => {
    if (isPreview) return;
    load();
    const db = createBrowserClient();
    const channel = db.channel(`live-${sessionId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_assessment_participants', filter: `session_id=eq.${sessionId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_assessment_answers' }, load)
      .subscribe();
    const timer = setInterval(load, 5000);
    return () => { clearInterval(timer); db.removeChannel(channel); };
  }, [isPreview, load, sessionId]);

  const url = typeof window === 'undefined' ? '' : `${location.origin}/join?code=${data?.session.join_code ?? ''}`;
  const questions = data?.session.question_snapshot ?? [];
  const participants = data?.participants ?? [];
  const submitted = participants.filter((participant: any) => participant.status === 'submitted').length;
  const submissionPercent = participants.length ? Math.round(submitted / participants.length * 100) : 0;
  const stats = useMemo(() => questions.map((question: any) => {
    const responses = participants.flatMap((participant: any) => participant.live_assessment_answers ?? []).filter((answer: any) => answer.item_id === question.id);
    return { ...question, count: responses.length, correct: responses.filter((answer: any) => answer.selected_index === question.answerIndex).length, choiceCounts: question.choices.map((_: any, index: number) => responses.filter((answer: any) => answer.selected_index === index).length) };
  }), [questions, participants]);
  const rankedParticipants = useMemo(() => [...participants]
    .filter((participant: any) => participant.status === 'submitted')
    .sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0) || new Date(a.submitted_at ?? 8640000000000000).getTime() - new Date(b.submitted_at ?? 8640000000000000).getTime()), [participants]);
  const weakQuestions = useMemo(() => [...stats].sort((a: any, b: any) => (a.count ? a.correct / a.count : 0) - (b.count ? b.correct / b.count : 0)), [stats]);
  const weakGroups = useMemo(() => {
    const grouped = new Map<string, any>();
    weakQuestions.forEach((question: any, index: number) => {
      const key = question.objective?.trim() || question.stem;
      const current = grouped.get(key) ?? { ...question, objective: key, correct: 0, count: 0, questionNumbers: [] };
      current.correct += question.correct;
      current.count += question.count;
      current.questionNumbers.push(questions.findIndex((item: any) => item.id === question.id) + 1 || index + 1);
      grouped.set(key, current);
    });
    return [...grouped.values()].sort((a, b) => (a.count ? a.correct / a.count : 0) - (b.count ? b.correct / b.count : 0));
  }, [questions, weakQuestions]);

  async function action(next: 'start' | 'end') {
    if (actionPending) return;
    const pending = participants.length - submitted;
    if (next === 'end' && !confirm(pending > 0
      ? `아직 제출하지 않은 학생이 ${pending}명 있습니다. 응답한 문항까지만 집계하고 평가를 종료할까요?`
      : '모든 학생이 제출했습니다. 평가를 종료하고 결과를 확인할까요?')) return;
    if (isPreview) {
      setData((current: any) => ({ ...current, session: { ...current.session, status: next === 'start' ? 'live' : 'ended' } }));
      return;
    }
    setActionPending(next); setError('');
    try {
      const response=await fetch(`/api/professor/live-sessions/${sessionId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: next, confirm: true }) });
      const payload=await readApiResponse<{status:string}>(response, next === 'start' ? '평가를 시작하지 못했습니다.' : '평가를 종료하지 못했습니다.');
      if(!response.ok || !payload.ok) { setError(payload.error?.message ?? '요청을 완료하지 못했습니다.'); return; }
      await load();
    } catch(cause) { setError(cause instanceof Error ? cause.message : '요청을 완료하지 못했습니다.'); }
    finally { setActionPending(null); }
  }

  async function removeParticipant(participant: any) {
    if (actionPending) return;
    if (isPreview) { setData((current: any) => ({ ...current, participants: current.participants.filter((item: any) => item.id !== participant.id) })); return; }
    setActionPending('remove'); setError('');
    try {
      const response=await fetch(`/api/professor/live-sessions/${sessionId}?participantId=${participant.id}`, { method: 'DELETE' });
      const payload=await readApiResponse<{removed:boolean}>(response, '학생을 내보내지 못했습니다.');
      if(!response.ok || !payload.ok) setError(payload.error?.message ?? '학생을 내보내지 못했습니다.');
      else await load();
    } catch(cause) { setError(cause instanceof Error ? cause.message : '학생을 내보내지 못했습니다.'); }
    finally { setActionPending(null); }
  }

  if (!data) return <main className="live-shell ll-formative-flow ll-live-professor">{error || '평가실을 준비하고 있습니다.'}</main>;
  const session = data.session;
  const subjectName = session.title.replace(/\s*형성평가\s*$/, '').trim();
  const statusLabel = session.status === 'lobby' ? '배포 준비' : session.status === 'live' ? '진행 중' : '결과 확인';
  const statusDescription = session.status === 'lobby'
    ? `${subjectName || '이번'} 형성평가입니다. 모두 빠짐없이 참여해주세요.`
    : session.status === 'live'
      ? '학생 제출 현황을 실시간으로 확인하고 필요한 시점에 평가를 종료하세요.'
      : '문항별 응답 분포와 학생별 결과를 확인해 수업 이해도를 살펴보세요.';

  if (evidenceQuestion) {
    const questionIndex = questions.findIndex((question: any) => question.id === evidenceQuestion.id);
    const sourcePage = evidenceQuestion.sourcePages?.[0];
    const sourceUrl = data.sourceMaterial?.url && sourcePage ? `${data.sourceMaterial.url}#page=${sourcePage}` : data.sourceMaterial?.url;
    return <main className="live-shell ll-formative-flow ll-live-professor evidence-view">
      <button type="button" className="evidence-back" onClick={() => setEvidenceQuestion(null)}><ArrowLeft />형성평가 결과로 돌아가기</button>
      <header className="evidence-head">
        <div><span>문항 {questionIndex + 1} 출제 근거</span><h1>{data.sourceMaterial?.fileName ?? '강의자료'}</h1></div>
        {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer">새 창에서 열기 <ExternalLink /></a>}
      </header>
      <section className="evidence-document" aria-label="출제 근거 자료">
        {sourceUrl && data.sourceMaterial?.fileType === 'pdf'
          ? <iframe src={sourceUrl} title={`문항 ${questionIndex + 1} 근거자료 ${sourcePage ? `${sourcePage}쪽` : ''}`} />
          : <div className="evidence-unavailable"><FileText /><strong>{sourcePage ? `${sourcePage}쪽` : '근거 페이지'}</strong><p>브라우저에서 바로 표시할 PDF 자료가 없습니다. 아래 문항 정보에서 출제 근거를 확인해주세요.</p></div>}
      </section>
      <section className="evidence-question">
        <div className="evidence-question-title"><span>{questionIndex + 1}</span><div><small>문제 원문</small><h2>{evidenceQuestion.stem}</h2></div></div>
        <ol>{evidenceQuestion.choices.map((choice: string, index: number) => <li className={index === evidenceQuestion.answerIndex ? 'is-answer' : ''} key={index}><span>{index + 1}</span><p>{choice}</p>{index === evidenceQuestion.answerIndex && <b>정답</b>}</li>)}</ol>
        <dl><div><dt>정답</dt><dd>{evidenceQuestion.answerIndex + 1}번</dd></div><div><dt>해설</dt><dd>{evidenceQuestion.explanation || '등록된 해설이 없습니다.'}</dd></div><div><dt>근거 페이지</dt><dd>{evidenceQuestion.sourcePages?.length ? `${evidenceQuestion.sourcePages.join(', ')}쪽` : '페이지 정보 없음'}</dd></div></dl>
      </section>
    </main>;
  }

  return <main className="live-shell ll-formative-flow ll-live-professor">
    {error && <div className="studio-error" role="alert">{error}</div>}
    <header className="live-head">
      <div>
        <p className="flow-eyebrow">교수 도구 · 실시간 형성평가 · {statusLabel}</p>
        {session.status === 'lobby' ? (
          <h1>QR 코드를 통해 <span className="live-title-accent">형성평가</span>에 참여하세요</h1>
        ) : (
          <h1>{subjectName || session.title} <span className="live-title-accent">형성평가</span></h1>
        )}
        <p className="flow-lead">{statusDescription}</p>
      </div>
      <div className="flow-header-tools">
        <div className="formative-guide">
          <button type="button" className="formative-guide-trigger">
            <span className="formative-guide-icon">?</span>
            <GuideLabel />
          </button>
          <div className="formative-guide-panel">
            <h2>어떻게 사용하나요?</h2>
            <ol>
              <li><strong>학생 초대</strong>: QR 코드나 링크를 공유해 학생의 입장을 받습니다.</li>
              <li><strong>평가 진행</strong>: 입장 현황을 확인한 뒤 평가를 시작하고 제출 수를 살펴봅니다.</li>
              <li><strong>결과 확인</strong>: 평가 종료 후 문항별 응답과 학생별 결과를 확인합니다.</li>
            </ol>
          </div>
        </div>
        {session.status === 'live' && (
          <div className="live-head-actions">
            <button className="danger live-end-action" disabled={Boolean(actionPending)} onClick={() => action('end')}><Square /> {actionPending === 'end' ? '종료 중' : '평가 종료'}</button>
          </div>
        )}
      </div>
    </header>
    {session.status === 'lobby' && (
      <section className="lobby-grid">
        <div className="qr-card">
          <QRCodeCanvas ref={qr} value={url} size={270} level="M" />
          <b>{session.join_code}</b>
          <div className="qr-actions">
            <button className="qr-secondary-action" onClick={() => navigator.clipboard.writeText(url)}>
              <Link2 />링크 복사
            </button>
            <button className="qr-secondary-action" onClick={() => { const link = document.createElement('a'); link.download = `${session.join_code}-qr.png`; link.href = qr.current!.toDataURL(); link.click(); }}>
              <Download />QR 저장
            </button>
            <button className="qr-start-action" disabled={Boolean(actionPending)} onClick={() => action('start')}>
              <Play />{actionPending === 'start' ? '시작 중' : '평가 시작'}
            </button>
          </div>
        </div>
        <div className="people-card">
          <h2>
            <span><i className="people-ready-dot" aria-hidden="true" />입장 학생</span>
            <b>{participants.length}</b>
          </h2>
          <div className="people-list">
            {participants.map((participant: any) => (
              <div className="people-row" key={participant.id}>
                <span>{participant.name}</span>
                <small>{new Date(participant.joined_at).toLocaleTimeString()}</small>
                <button disabled={Boolean(actionPending)} aria-label={`${participant.name} 내보내기`} onClick={() => void removeParticipant(participant)}>
                  <UserX />
                </button>
              </div>
            ))}
          </div>
          <p className="people-live-note">입장 현황은 실시간으로 반영됩니다.</p>
        </div>
      </section>
    )}
    {session.status === 'live' && (
      <section className="live-progress-card" aria-labelledby="live-progress-title">
        <div className="live-progress-main">
          <div className="live-progress-copy">
            <div className="live-progress-brand" aria-label="LectureLink">
              <span><BookOpen aria-hidden="true" /></span>
              <b>LectureLink</b>
            </div>
            <p className="live-progress-status"><i aria-hidden="true" />형성평가 진행 중</p>
            <h2 id="live-progress-title"><strong>{submitted}</strong><span> / {participants.length}명 제출 완료</span></h2>
            <div className="live-submission-track" role="progressbar" aria-label="답안 제출률" aria-valuemin={0} aria-valuemax={100} aria-valuenow={submissionPercent}>
              <i style={{ transform: `scaleX(${submissionPercent / 100})` }} />
            </div>
            <p className="live-progress-description">학생들이 답안을 제출하면 현황이 바로 반영됩니다. 제출 상태를 확인한 뒤 적절한 시점에 평가를 종료하세요.</p>
          </div>
          <div className="live-progress-visual" aria-hidden="true">
            {/* A project-owned raster illustration is intentional here: the previous loose SVG shapes did not communicate one coherent scene. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/formative/live-assessment-progress.png" alt="" width={768} height={576} />
          </div>
        </div>
        <div className="live-progress-footer">
          <div className="live-progress-stat">
            <Users aria-hidden="true" />
            <span><small>참여 학생</small><b>{participants.length}명</b></span>
          </div>
          <div className="live-progress-stat">
            <CheckCircle2 aria-hidden="true" />
            <span><small>제출 완료</small><b>{submitted}명</b></span>
          </div>
          <p>형성평가가 끝난 후 로그인하면 문항을 저장할 수 있어요.</p>
        </div>
      </section>
    )}
    {session.status === 'ended' && <>
      <section className="metric-row"><div><small>전체 참여</small><b>{participants.length}</b></div><div><small>제출 완료</small><b>{submitted}</b></div><div><small>평균 점수</small><b>{participants.length ? Math.round(participants.reduce((sum: number, participant: any) => sum + (participant.score ?? 0), 0) / participants.length) : '—'}</b></div></section>
      {rankedParticipants.length > 0 && <section className="result-podium" aria-labelledby="podium-title"><div><h2 id="podium-title">이번 평가 상위 학생</h2><p>정답 수가 같으면 먼저 제출한 학생이 앞섭니다.</p></div><ol>{rankedParticipants.slice(0, 3).map((participant: any, index: number) => <li key={participant.id}><span><Medal aria-hidden="true" />{index + 1}위</span><strong>{participant.name}</strong><small>{participant.score}/{participant.total} · {participant.submitted_at ? new Date(participant.submitted_at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '제출 시각 없음'}</small></li>)}</ol></section>}
      <div className="result-tabs" role="tablist" aria-label="평가 결과 분석"><button type="button" role="tab" aria-selected={resultTab === 'responses'} onClick={() => setResultTab('responses')}>문항별 응답</button><button type="button" role="tab" aria-selected={resultTab === 'weaknesses'} onClick={() => setResultTab('weaknesses')}>학생들이 취약했던 부분</button></div>
      {resultTab === 'responses' ? <section className="analysis-card"><div className="analysis-section-head"><div><h2>문항별 응답 현황</h2><p>막대 길이로 선지별 선택 비율을 비교할 수 있습니다.</p></div></div>{stats.map((question: any, index: number) => <article key={question.id}><div><b><span className="analysis-question-number" aria-hidden="true">{index + 1}</span>{question.stem}</b><span>{question.count}/{participants.length} 응답 · 정답률 {question.count ? Math.round(question.correct / question.count * 100) : 0}%</span></div><div className="choice-chart">{question.choices.map((choice: string, choiceIndex: number) => { const percent = question.count ? Math.round(question.choiceCounts[choiceIndex] / question.count * 100) : 0; return <div className={choiceIndex === question.answerIndex ? 'is-correct-choice' : ''} key={choiceIndex}><span>{choiceIndex + 1}</span><p title={choice}>{choice}</p><i><b style={{ width: `${percent}%` }} /></i><strong>{question.choiceCounts[choiceIndex]}명 <small>{percent}%</small></strong></div>; })}</div><button type="button" className="evidence-button" onClick={() => setEvidenceQuestion(question)}><FileText />근거자료{question.sourcePages?.length ? ` · ${question.sourcePages.join(', ')}쪽` : ''}</button></article>)}</section>
      : <section className="analysis-card weakness-card"><div className="analysis-section-head"><div><h2>학생들이 취약했던 부분</h2><p>같은 학습목표의 문항은 묶고, 응답한 문항의 정답률을 기준으로 정리했습니다.</p></div></div>{weakGroups.map((group: any, index: number) => { const accuracy = group.count ? Math.round(group.correct / group.count * 100) : 0; return <article key={group.objective}><div className="weakness-rank"><span>보완 {index + 1} · 문항 {group.questionNumbers.join(', ')}</span><strong>{group.count ? `정답률 ${accuracy}%` : '응답 없음'}</strong></div><h3>{group.objective}</h3><p>{accuracy < 40 ? '핵심 정의와 판단 기준을 먼저 다시 짚고, 해당 문항의 오답 선지를 근거별로 비교해보세요.' : accuracy < 70 ? '대표 사례를 하나 더 제시한 뒤 학생이 선택 근거를 직접 설명하게 해보세요.' : '대부분 이해했습니다. 혼동이 있었던 선지만 짧게 대조하면 충분합니다.'}</p><button type="button" className="evidence-button" onClick={() => setEvidenceQuestion(group)}><FileText />대표 문항과 근거 확인</button></article>; })}</section>}
      <section className="analysis-card student-results-card"><h2>학생별 결과</h2>{participants.map((participant: any, index: number) => { const answered = participant.live_assessment_answers?.length ?? 0; const unanswered = Math.max(0, questions.length - answered); return <div className="result-line" key={participant.id}><span><small>{index + 1}</small>{participant.name}{participant.auto_submitted ? ' · 종료 시 자동 제출' : ''}{unanswered > 0 ? ` · 미응답 ${unanswered}문항` : ''}</span><b>{participant.score ?? 0}/{questions.length}</b></div>; })}</section>
    </>}
  </main>;
}
