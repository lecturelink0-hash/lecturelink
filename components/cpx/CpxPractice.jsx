'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, ChevronRight, Clock3, Mic, Send, ShieldAlert, Sparkles, Stethoscope, UserRound } from 'lucide-react';
import Avatar3D from './Avatar3D';
import { GeminiLivePatient } from './live';
import { startMic } from './mic';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

const SESSION_SECONDS = 12 * 60;

function request(path, options = {}) {
  return fetch(`/api/cpx${path}`, {
    headers: { 'content-type': 'application/json' },
    ...options,
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.detail || `요청 실패 (${response.status})`);
    return body;
  });
}

function formatTime(seconds) {
  const safe = Math.max(0, seconds);
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

function sanitizePatientText(value) {
  return String(value || '')
    .replace(/\[SYS_EVENT[^\]]*\]/gi, '')
    .replace(/\[[^\]]{0,40}\]/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s"“”']+|[\s"“”']+$/g, '')
    .trim();
}

function Wave({ active }) {
  return <div className="flex h-7 items-center gap-1" aria-label={active ? '음성 연결 중' : '음성 대기 중'}>{Array.from({ length: 9 }, (_, i) => <span key={i} className={`h-2 w-1 rounded-full bg-[var(--color-gold)] ${active ? 'cpx-wave' : ''}`} style={{ animationDelay: `${i * 85}ms` }} />)}</div>;
}

export default function CpxPractice() {
  const [caseCatalog, setCaseCatalog] = useState({ categories: [], cases: [] });
  const [caseId, setCaseId] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const selected = useMemo(() => caseCatalog.cases.find((item) => item.id === caseId) ?? null, [caseCatalog, caseId]);
  const [phase, setPhase] = useState('ready');
  const [status, setStatus] = useState('증례를 선택하고 진료를 시작하세요.');
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState('');
  const [persona, setPersona] = useState(null);
  const [transcript, setTranscript] = useState([]);
  const [draft, setDraft] = useState('');
  const [buttons, setButtons] = useState([]);
  const [region, setRegion] = useState('');
  const [examTarget, setExamTarget] = useState(null);
  const [findings, setFindings] = useState([]);
  const [elapsed, setElapsed] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);
  const [result, setResult] = useState(null);
  const liveRef = useRef(null);
  const micRef = useRef(null);
  const bufferRef = useRef([]);
  const startedAtRef = useRef(0);

  const remaining = Math.max(0, SESSION_SECONDS - elapsed);
  const push = useCallback((role, text) => {
    const clean = String(text || '').replace(/\s+/g, ' ').trim();
    if (!clean) return;
    // Live 전사 완료 신호와 텍스트 전송 응답이 같은 문장을 다시 보낼 수 있다.
    // 직전 이벤트와 완전히 같으면 한 번만 세션 로그에 남긴다.
    const previous = bufferRef.current[bufferRef.current.length - 1];
    if (previous?.role === role && previous.text === clean) return;
    const event = { role, text: clean, tOffsetMs: Math.max(0, Date.now() - startedAtRef.current) };
    bufferRef.current.push(event);
    setTranscript((current) => [...current, event]);
  }, []);

  const flush = useCallback(async () => {
    if (!sessionId || !bufferRef.current.length) return;
    const events = bufferRef.current.splice(0);
    try {
      await request(`/sessions/${sessionId}/events`, { method: 'POST', body: JSON.stringify(events), keepalive: true });
    } catch {
      bufferRef.current.unshift(...events);
    }
  }, [sessionId]);

  useEffect(() => {
    if (phase !== 'live') return undefined;
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000)), 1000);
    const saver = window.setInterval(flush, 3000);
    return () => { window.clearInterval(timer); window.clearInterval(saver); };
  }, [phase, flush]);

  useEffect(() => () => {
    micRef.current?.stop?.();
    liveRef.current?.disconnect?.({ silent: true });
  }, []);

  useEffect(() => {
    let active = true;
    request('/cases')
      .then((data) => {
        const cases = Array.isArray(data.cases) ? data.cases.filter((item) => item?.id) : [];
        const categories = [...new Set(cases.map((item) => item.category).filter(Boolean))];
        if (!active) return;
        setCaseCatalog({ categories, cases });
        setCaseId((current) => cases.some((item) => item.id === current) ? current : (cases[0]?.id ?? ''));
        setCatalogError(cases.length ? '' : '현재 연습할 수 있는 승인 증례가 없습니다.');
      })
      .catch((nextError) => {
        if (!active) return;
        setCatalogError(nextError instanceof Error ? nextError.message : '증례 목록을 불러오지 못했습니다.');
      })
      .finally(() => { if (active) setCatalogLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!selected) {
      setButtons([]);
      setRegion('');
      return;
    }
    request(`/exam-buttons?caseId=${encodeURIComponent(selected.id)}`)
      .then((data) => {
        const nextButtons = Array.isArray(data.buttons) ? data.buttons : [];
        setButtons(nextButtons);
        setRegion(nextButtons[0]?.bodyRegion ?? '');
        setExamTarget(null);
      })
      .catch(() => setButtons([]));
  }, [selected]);

  const start = async () => {
    if (!selected || phase === 'starting') return;
    setError(''); setResult(null); setTranscript([]); setFindings([]); setAudioLevel(0); setPhase('starting'); setStatus('세션을 준비하고 있습니다.');
    try {
      const created = await request('/sessions', { method: 'POST', body: JSON.stringify({ caseId: selected.id }) });
      setSessionId(created.sessionId); setPersona(created.persona); startedAtRef.current = Date.now(); setElapsed(0);
      const token = await request(`/sessions/${created.sessionId}/live-token`, { method: 'POST' });
      const live = new GeminiLivePatient({
        onStatus: (_state, nextStatus) => setStatus(nextStatus),
        onPatientText: (text) => push('patient', sanitizePatientText(text)),
        onInputText: (text, meta) => { if (meta?.final) push('student', text); },
        onAudioLevel: setAudioLevel,
      });
      liveRef.current = live;
      await live.connect(token);
      try {
        micRef.current = await startMic(live);
      } catch {
        // 텍스트 문진은 마이크 권한과 무관하게 계속 가능해야 한다.
        setError('마이크를 사용할 수 없습니다. 아래 입력창으로 텍스트 문진은 계속할 수 있습니다.');
      }
      setPhase('live'); setStatus('진료 중 — 환자에게 질문해 보세요.');
    } catch (nextError) {
      liveRef.current?.disconnect?.({ silent: true });
      micRef.current?.stop?.();
      setPhase('ready'); setError(nextError instanceof Error ? nextError.message : 'CPX 세션을 시작하지 못했습니다.');
      setStatus('연결 실패');
    }
  };

  const sendText = async (event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || phase !== 'live') return;
    setDraft('');
    // 텍스트 입력은 음성 전사 콜백이 오지 않는 환경에서도 채점 로그에 남아야 한다.
    push('student', text);
    try {
      await liveRef.current.askText(text);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '환자 응답을 받지 못했습니다.');
    }
  };

  const examine = async (button) => {
    if (!sessionId || phase !== 'live') return;
    try {
      setExamTarget(button.avatarTarget || null);
      const card = await request(`/sessions/${sessionId}/exam`, { method: 'POST', body: JSON.stringify({ buttonId: button.id, tOffsetMs: Date.now() - startedAtRef.current }) });
      setFindings((current) => [card, ...current.filter((item) => item.buttonId !== card.buttonId)]);
      setTranscript((current) => [...current, { role: 'student', text: card.declaration, tOffsetMs: Date.now() - startedAtRef.current }]);
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : '신체진찰을 기록하지 못했습니다.');
    }
  };

  const finish = async () => {
    if (!sessionId || phase !== 'live') return;
    setPhase('finishing'); setStatus('채점 근거를 정리하고 있습니다.');
    try {
      micRef.current?.stop?.(); liveRef.current?.disconnect?.({ silent: true }); await flush();
      await request(`/sessions/${sessionId}/end`, { method: 'POST' });
      const evaluation = await request(`/sessions/${sessionId}/evaluate`, { method: 'POST' });
      setResult(evaluation); setPhase('ended'); setStatus('채점 완료');
    } catch (nextError) {
      setPhase('live'); setStatus('진료 중'); setError(nextError instanceof Error ? nextError.message : '채점을 완료하지 못했습니다.');
    }
  };

  const visibleButtons = buttons.filter((button) => button.bodyRegion === region);
  const activeRegions = useMemo(() => {
    const regions = new Map();
    for (const button of buttons) {
      if (button.bodyRegion && !regions.has(button.bodyRegion)) {
        regions.set(button.bodyRegion, { id: button.bodyRegion, label: button.bodyRegionLabel || button.bodyRegion });
      }
    }
    return [...regions.values()];
  }, [buttons]);

  return <div className="ll-system-page space-y-7">
    <section className="flex flex-col gap-4 border-b border-[var(--color-border)] pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div><span className="ll-eyebrow"><Stethoscope className="h-3.5 w-3.5" /> CPX 실전 연습</span><h1 className="mt-2 text-3xl font-bold tracking-[-.035em] text-[var(--color-text)]">표준화 환자와 실제처럼 진료하세요</h1><p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">음성 문진, 부위별 신체진찰, 루브릭 기반 피드백을 한 세션에서 이어갑니다.</p></div>
      <div className="flex items-center gap-2"><Badge>{caseCatalog.cases.length}개 증례</Badge><Badge variant="beta">12분</Badge></div>
    </section>

    <Card className="p-5 sm:p-6"><div className="grid gap-4 lg:grid-cols-[1fr_auto]"><label className="grid gap-2 text-sm font-bold text-[var(--color-text)]">증례 선택<select value={caseId} onChange={(event) => setCaseId(event.target.value)} disabled={catalogLoading || phase === 'live' || phase === 'starting'} className="h-11 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-3 font-medium outline-none focus:border-[var(--color-primary)]"><option value="">{catalogLoading ? '승인 증례를 불러오는 중…' : '증례를 선택하세요'}</option>{caseCatalog.categories.map((category) => <optgroup key={category} label={category}>{caseCatalog.cases.filter((item) => item.category === category).map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}</optgroup>)}</select></label><div className="flex items-end"><Button variant="accent" size="lg" onClick={start} loading={phase === 'starting'} disabled={!selected || phase === 'live' || phase === 'finishing'}><Mic className="h-4 w-4" /> {phase === 'ended' ? '새 진료 시작' : '진료 시작'}</Button></div></div><p className="mt-3 text-sm text-[var(--color-muted)]">{selected?.description || catalogError || '서비스에 공개된 증례만 표시합니다.'}</p>{(error || catalogError) && <div role="alert" className="mt-4 flex gap-2 rounded-[var(--radius-md)] border border-[var(--color-warn)] bg-[var(--color-warn-bg)] p-3 text-sm text-[var(--color-warn)]"><ShieldAlert className="h-5 w-5 shrink-0" />{error || catalogError}</div>}</Card>

    <section className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,.9fr)]">
      <Card className="overflow-hidden p-0"><div className="relative min-h-[430px] bg-[#143c2c]"><div className="absolute left-4 top-4 z-10 rounded-[var(--radius-md)] bg-black/20 px-3 py-2 text-white"><div className="text-xs text-white/70">주소증</div><div className="font-bold">{selected?.category}</div></div><div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-sm font-bold text-white"><Wave active={phase === 'live'} />{status}</div><div className="h-[430px]"><Avatar3D gender={persona?.gender || '여성'} age={persona?.age || 48} speaking={audioLevel > 0.02} audioLevel={audioLevel} pose={examTarget ? 'lying' : 'sitting'} examTarget={examTarget} /></div></div><div className="border-t border-[var(--color-border)] bg-white p-4"><div className="max-h-52 space-y-2 overflow-y-auto pr-1">{transcript.length ? transcript.map((event, index) => <div key={`${event.tOffsetMs}-${index}`} className={event.role === 'student' ? 'text-right' : 'text-left'}><span className={`inline-block max-w-[88%] rounded-[var(--radius-md)] px-3 py-2 text-sm ${event.role === 'student' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-sage-100)] text-[var(--color-text)]'}`}>{event.text}</span></div>) : <p className="py-5 text-center text-sm text-[var(--color-muted)]">진료 시작 후 환자에게 질문하거나 음성으로 대화해 보세요.</p>}</div><form onSubmit={sendText} className="mt-3 flex gap-2"><input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={phase !== 'live'} placeholder="보조 텍스트 입력 — 음성 문진도 자동 전사됩니다" className="h-11 min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 text-sm outline-none focus:border-[var(--color-primary)] disabled:bg-[var(--color-surface-muted)]"/><Button type="submit" variant="primary" disabled={phase !== 'live' || !draft.trim()}><Send className="h-4 w-4" />전송</Button></form></div></Card>

      <div className="space-y-6"><Card title="환자 정보" icon={<UserRound className="h-5 w-5" />}><div className="space-y-2 text-sm"><p className="font-bold text-[var(--color-text)]">{persona ? `${persona.name} · ${persona.age}세 · ${persona.gender}` : '진료 시작 시 환자 정보가 확정됩니다.'}</p><p className="text-[var(--color-muted)]">{selected?.title}</p><p className="text-[var(--color-muted)]">{selected?.variant}</p></div></Card><Card title="남은 시간" icon={<Clock3 className="h-5 w-5" />} action={<span className={`tnum text-2xl font-bold ${remaining < 120 ? 'text-[var(--color-warn)]' : 'text-[var(--color-primary)]'}`}>{formatTime(remaining)}</span>}><Button fullWidth variant="accent" onClick={finish} disabled={phase !== 'live'}><Activity className="h-4 w-4" />진료 종료 및 채점</Button></Card></div>
    </section>

    <Card title="신체진찰" description="신체 부위를 먼저 고른 뒤, 해당 부위의 진찰을 선택하세요." icon={<Stethoscope className="h-5 w-5" />}><div className="flex flex-wrap gap-2">{activeRegions.map((item) => <button key={item.id} onClick={() => { setRegion(item.id); setExamTarget(null); }} className={`rounded-full border px-3 py-1.5 text-sm font-bold transition ${region === item.id ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white' : 'border-[var(--color-border)] bg-white text-[var(--color-muted)] hover:border-[var(--color-primary)]'}`}>{item.label}</button>)}</div><div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{visibleButtons.map((button) => <Button key={button.id} variant="secondary" fullWidth disabled={phase !== 'live'} onClick={() => examine(button)}><Stethoscope className="h-4 w-4" />{button.label}</Button>)}</div>{findings.length > 0 && <div className="mt-5 grid gap-3">{findings.map((card) => <div key={card.buttonId} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-sage-50)] p-4"><div className="font-bold text-[var(--color-text)]">{card.label}</div><ul className="mt-2 space-y-1 text-sm text-[var(--color-muted)]">{card.findings.map((finding, index) => <li key={index}>• {finding.finding}</li>)}</ul></div>)}</div>}</Card>

    {result && <Card title="CPX 결과" description="루브릭 항목별 근거를 바탕으로 계산된 이번 세션의 결과입니다." icon={<Sparkles className="h-5 w-5" />}><div className="grid gap-5 md:grid-cols-[auto_1fr]"><div className="rounded-[var(--radius-md)] bg-[var(--color-primary)] px-7 py-5 text-center text-white"><div className="text-xs text-white/70">총점</div><div className="tnum mt-1 text-5xl font-bold">{result.totalScore}</div><div className="mt-1 text-sm">{result.overallGradeLabel}</div></div><div className="grid gap-3 sm:grid-cols-2">{(result.sections || []).map((section) => <div key={section.id} className="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3"><div className="flex items-center justify-between gap-3"><span className="font-bold text-[var(--color-text)]">{section.name}</span><span className="tnum font-bold text-[var(--color-primary)]">{section.score}</span></div><p className="mt-1 text-xs text-[var(--color-muted)]">충족 {section.satisfiedCount}/{section.applicableCount}</p></div>)}</div></div></Card>}
  </div>;
}
