'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, Download, Link2, Play, Square, UserX } from 'lucide-react';
import { QRCodeCanvas } from 'qrcode.react';
import { createBrowserClient } from '@/lib/db/browser';
import './live-assessment.css';
import './live-assessment-progress.css';
import '../formative/formative-flow.css';

const previewQuestions = [
  { id: 'preview-q1', stem: '다음 중 강의에서 설명한 핵심 개념으로 가장 적절한 것은?', choices: ['핵심 개념을 정확히 설명한 선택지', '일부 조건만 포함한 선택지', '강의 범위를 벗어난 선택지', '반대 의미의 선택지', '근거가 부족한 선택지'], answerIndex: 0 },
  { id: 'preview-q2', stem: '학습한 원리를 실제 상황에 적용한 예로 가장 적절한 것은?', choices: ['조건을 일부만 반영한 사례', '핵심 조건을 모두 반영한 사례', '원인과 결과를 반대로 연결한 사례', '자료에서 다루지 않은 사례', '판단 정보가 부족한 사례'], answerIndex: 1 },
  { id: 'preview-q3', stem: '다음 설명 중 강의자료의 내용과 일치하지 않는 것은?', choices: ['주요 정의에 관한 설명', '기본 원리에 관한 설명', '판단 순서에 관한 설명', '강의 내용과 반대되는 설명', '주의사항에 관한 설명'], answerIndex: 3 },
];

const previewJoinedAt = '2026-08-10T09:00:00.000Z';

const previewParticipants = [
  { id: 'p1', name: '김민준', status: 'submitted', score: 3, total: 3, joined_at: previewJoinedAt, live_assessment_answers: [{ item_id: 'preview-q1', selected_index: 0 }, { item_id: 'preview-q2', selected_index: 1 }, { item_id: 'preview-q3', selected_index: 3 }] },
  { id: 'p2', name: '이서연', status: 'submitted', score: 2, total: 3, joined_at: previewJoinedAt, live_assessment_answers: [{ item_id: 'preview-q1', selected_index: 0 }, { item_id: 'preview-q2', selected_index: 2 }, { item_id: 'preview-q3', selected_index: 3 }] },
  { id: 'p3', name: '박지훈', status: 'joined', score: null, total: 3, joined_at: previewJoinedAt, live_assessment_answers: [{ item_id: 'preview-q1', selected_index: 1 }] },
];

const previewData = {
  session: { id: 'preview', title: '순환기학 형성평가', status: 'lobby', join_code: '482731', question_snapshot: previewQuestions },
  participants: previewParticipants,
};

export function LiveProfessorDashboard({ sessionId }: { sessionId: string }) {
  const isPreview = sessionId === 'preview' && process.env.NODE_ENV === 'development';
  const [data, setData] = useState<any>(isPreview ? previewData : undefined);
  const [error, setError] = useState('');
  const qr = useRef<HTMLCanvasElement>(null);

  const load = useCallback(() => {
    if (isPreview) return Promise.resolve();
    return fetch(`/api/professor/live-sessions/${sessionId}`)
      .then((response) => response.json())
      .then((payload) => payload.ok ? setData(payload.data) : setError(payload.error?.message));
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
  const stats = useMemo(() => questions.map((question: any) => {
    const responses = participants.flatMap((participant: any) => participant.live_assessment_answers ?? []).filter((answer: any) => answer.item_id === question.id);
    return { ...question, count: responses.length, correct: responses.filter((answer: any) => answer.selected_index === question.answerIndex).length, choiceCounts: question.choices.map((_: any, index: number) => responses.filter((answer: any) => answer.selected_index === index).length) };
  }), [questions, participants]);

  async function action(next: 'start' | 'end') {
    if (next === 'end' && !confirm(`아직 제출하지 않은 학생은 ${participants.length - submitted}명입니다. 미응답은 오답 처리하고 종료할까요?`)) return;
    if (isPreview) {
      setData((current: any) => ({ ...current, session: { ...current.session, status: next === 'start' ? 'live' : 'ended' } }));
      return;
    }
    await fetch(`/api/professor/live-sessions/${sessionId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: next, confirm: true }) });
    load();
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

  return <main className="live-shell ll-formative-flow ll-live-professor">
    <header className="live-head">
      <div>
        <p className="flow-eyebrow">교수 도구 · 실시간 형성평가 · {statusLabel}</p>
        {session.status === 'lobby' ? (
          <h1>QR 코드를 통해 <span className="live-title-accent">형성평가</span>에 참여하세요</h1>
        ) : (
          <h1>{session.title}</h1>
        )}
        <p className="flow-lead">{statusDescription}</p>
      </div>
      <div className="flow-header-tools">
        <div className="formative-guide">
          <button type="button" className="formative-guide-trigger">
            <span className="formative-guide-icon">?</span>
            사용 설명서
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
            <button className="danger" onClick={() => action('end')}><Square /> 평가 종료</button>
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
            <button className="qr-start-action" onClick={() => action('start')}>
              <Play />평가 시작
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
                <button aria-label={`${participant.name} 내보내기`} onClick={async () => { if (isPreview) { setData((current: any) => ({ ...current, participants: current.participants.filter((item: any) => item.id !== participant.id) })); return; } await fetch(`/api/professor/live-sessions/${sessionId}?participantId=${participant.id}`, { method: 'DELETE' }); load(); }}>
                  <UserX />
                </button>
              </div>
            ))}
          </div>
          <p className="people-live-note">입장 현황은 실시간으로 반영됩니다.</p>
        </div>
      </section>
    )}
    {session.status === 'live' && <section className="live-progress-card"><div className="live-progress-illustration"><BookOpen /><i /><i /><i /></div><p>형성평가가 진행 중입니다</p><h2>{submitted}/{participants.length} 제출 완료</h2><span>학생들이 답안을 제출하면 실시간으로 현황이 반영됩니다.</span></section>}
    {session.status === 'ended' && <><section className="metric-row"><div><small>전체 참여</small><b>{participants.length}</b></div><div><small>제출 완료</small><b>{submitted}</b></div><div><small>평균 점수</small><b>{participants.length ? Math.round(participants.reduce((sum: number, participant: any) => sum + (participant.score ?? 0), 0) / participants.length) : '—'}</b></div></section><section className="analysis-card"><h2>문항별 응답 현황</h2>{stats.map((question: any, index: number) => <article key={question.id}><div><b><span className="analysis-question-number" aria-hidden="true">{index + 1}</span>{question.stem}</b><span>{question.count}/{participants.length} 응답 · 정답률 {question.count ? Math.round(question.correct / question.count * 100) : 0}%</span></div><div className="bar-row">{question.choices.map((_: string, choiceIndex: number) => <span className={choiceIndex === question.answerIndex ? 'is-correct-choice' : ''} key={choiceIndex} style={{ flex: question.choiceCounts[choiceIndex] + 1 }}>{choiceIndex + 1}번 {question.choiceCounts[choiceIndex]}</span>)}</div></article>)}</section><section className="analysis-card student-results-card"><h2>학생별 결과</h2>{[...participants].sort((a: any, b: any) => (b.score ?? 0) - (a.score ?? 0)).map((participant: any) => <div className="result-line" key={participant.id}><span>{participant.name}{participant.auto_submitted ? ' · 자동 제출' : ''}</span><b>{participant.score}/{participant.total}</b></div>)}</section></>}
  </main>;
}
