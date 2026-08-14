'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Activity, Baby, Brain, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock3, Ear, Eye, Heart, MessageCircle, Mic, MicOff, MinusCircle, PersonStanding, RotateCcw, Search, Send, Shield, ShieldAlert, Sparkles, Stethoscope, UserRound, Utensils, Wind, XCircle } from 'lucide-react';
import Avatar3D from './Avatar3D';
import CpxStartExperience from './CpxStartExperience';
import CpxTimeAnalysis from './CpxTimeAnalysis';
import CpxTranscriptView from './CpxTranscriptView';
import { GeminiLivePatient } from './live';
import { startMic } from './mic';
import { sanitizePatientText } from './sanitize';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { PRIVACY_VERSION } from '@/lib/legal/config';

// 진료 시간은 짧은 순서로 제시하며, 실전 기준은 12분이다.
const TIME_LIMIT_OPTIONS = [
  { seconds: 11 * 60, label: '11분' },
  { seconds: 11 * 60 + 30, label: '11분 30초' },
  { seconds: 12 * 60, label: '12분' },
];

// 시나리오 작성 시 나눴던 파트 기준 그룹. 주호소(카테고리)를 대분류로 묶어 먼저 제시한다.
// 백엔드에 새 카테고리가 생겨 어느 파트에도 없으면 '기타'로 폴백한다.
const PART_GROUPS = [
  {
    id: 'history', label: '병력청취 중심', Icon: ClipboardList,
    desc: '문진으로 감별하는 내과계 주호소',
    cats: ['수면장애', '피로', '두통', '어지럼', '발열', '소화불량/만성복통', '콧물/코막힘',
      '배뇨 이상', '붉은색 소변', '변비', '기침', '실신', '기억력 저하', '체중 감소', '설사', '이상지질혈증',
      '구토', '토혈', '혈변', '객혈', '황달', '핍뇨', '요실금', '체중 증가', '다뇨', '쉽게 멍이 듦'],
  },
  {
    id: 'exam', label: '진찰 중심', Icon: Search,
    desc: '신체진찰이 감별의 핵심인 주호소',
    cats: ['관절 통증', '가슴 통증', '급성 복통', '고혈압', '호흡곤란', '두근거림', '허리 통증',
      '목 통증', '피부 발진', '손떨림', '팔다리 근력 약화 및 감각 이상', '경련', '의식장애'],
  },
  {
    id: 'psych', label: '정신·행동 중심', Icon: Brain,
    desc: '정신과적 평가와 위험도 판단',
    cats: ['불안', '음주 문제', '기분 변화', '자살', '물질 오남용'],
  },
  {
    id: 'counsel', label: '상담·의사소통', Icon: MessageCircle,
    desc: '설명·교육·나쁜 소식 전달 중심',
    cats: ['나쁜소식 전하기', '금연 상담', '예방접종'],
  },
  {
    id: 'women', label: '여성·산과', Icon: Baby,
    desc: '산과·부인과 주호소',
    cats: ['산전 진찰', '월경 이상/월경통', '질 분비물', '유방통/유방덩이'],
  },
  {
    id: 'special', label: '소아·특수 상황', Icon: Shield,
    desc: '소아·가정폭력·성폭력 등 민감 상황',
    cats: ['발달 지연', '가정폭력', '성폭력'],
  },
];

// 주호소 → 흑백 라인 아이콘(lucide). 이모지 대신 사용해 시안과 톤을 맞춘다.
const CAT_ICON_RULES = [
  [/두통|어지럼|기억|치매|의식|경련|근력|감각|손떨림/, Brain],
  [/가슴|흉통|두근|심계|고혈압|실신/, Heart],
  [/호흡|기침|객혈|콧물|비염/, Wind],
  [/복통|소화|위|변비|설사|혈변|토혈|구토|황달/, Utensils],
  [/목|귀|이비/, Ear],
  [/피부|발진|멍|유방|월경|질|산전/, Eye],
  [/불안|음주|기분|우울|자살|물질|금연|나쁜소식|예방접종/, Brain],
];
function catIcon(cat) {
  for (const [re, Icon] of CAT_ICON_RULES) if (re.test(cat)) return Icon;
  return Stethoscope;
}

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

function Wave({ active }) {
  return <div className="flex h-7 items-center gap-1" aria-label={active ? '음성 연결 중' : '음성 대기 중'}>{Array.from({ length: 9 }, (_, i) => <span key={i} className={`h-2 w-1 rounded-full bg-[var(--color-gold)] ${active ? 'cpx-wave' : ''}`} style={{ animationDelay: `${i * 85}ms` }} />)}</div>;
}

export default function CpxPractice() {
  const [caseCatalog, setCaseCatalog] = useState({ categories: [], cases: [] });
  const [caseId, setCaseId] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState('');
  const [historySessions, setHistorySessions] = useState(null);
  const [historyError, setHistoryError] = useState('');
  const selected = useMemo(() => caseCatalog.cases.find((item) => item.id === caseId) ?? null, [caseCatalog, caseId]);
  // 실제 데이터가 있는 카테고리만 각 파트에 배치. 어느 파트에도 없는 카테고리는 '기타' 파트로.
  const partGroups = useMemo(() => {
    const present = new Set(caseCatalog.categories);
    const known = new Set();
    const groups = [];
    for (const g of PART_GROUPS) {
      const cats = g.cats.filter((c) => present.has(c));
      cats.forEach((c) => known.add(c));
      if (cats.length) groups.push({ ...g, cats });
    }
    const others = caseCatalog.categories.filter((c) => !known.has(c));
    if (others.length) groups.push({ id: 'other', label: '기타 주호소', emoji: '📋', desc: '그 외 주호소', cats: others });
    return groups;
  }, [caseCatalog]);
  const [phase, setPhase] = useState('ready');
  const [practiceMode, setPracticeMode] = useState('direct');
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
  const [expandedSection, setExpandedSection] = useState(null); // 채점 결과에서 펼친 영역 id
  const [showTranscript, setShowTranscript] = useState(false); // 채점 후 [전체 대화록] 패널 토글
  const [gradingProgress, setGradingProgress] = useState(0); // 채점 로딩 원형 게이지(%)
  const [voiceOn, setVoiceOn] = useState(true); // 음성 on/off (off 시 텍스트 전용)
  // 순응도 낮은 환자 모드(옵트인) — 저항 유형은 서버가 세션 시드로 뽑고 채점 후에만 공개된다.
  const [lowCompliance, setLowCompliance] = useState(false);
  const [processingNoticeAccepted, setProcessingNoticeAccepted] = useState(false);
  // 환자 인적사항 공개 여부 — 학생이 직접 물어봤을 때만 해당 항목을 노출한다.
  const [revealed, setRevealed] = useState({ name: false, age: false, gender: false });
  // 연습용 시간제한(초) — 세션 시작 전에만 변경 가능, 세션 생성 시 서버에 함께 저장된다.
  const [limitSeconds, setLimitSeconds] = useState(12 * 60);
  const liveRef = useRef(null);
  const micRef = useRef(null);
  const voiceBusyRef = useRef(false);
  const bufferRef = useRef([]);
  const usageRef = useRef([]); // Live 턴별 usageMetadata 버퍼 (원가 실측)
  const startedAtRef = useRef(0);
  const autoEndedRef = useRef(false); // 시간 종료 자동 채점은 세션당 1회만
  const finishRef = useRef(null);

  const remaining = Math.max(0, limitSeconds - elapsed);
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

  // Live API가 턴마다 돌려주는 토큰 사용량을 서버에 기록 — CPX 회당 원가 실측용.
  const flushUsage = useCallback(async () => {
    if (!sessionId || !usageRef.current.length) return;
    const events = usageRef.current.splice(0);
    try {
      await request(`/sessions/${sessionId}/usage`, { method: 'POST', body: JSON.stringify(events), keepalive: true });
    } catch {
      usageRef.current.unshift(...events);
    }
  }, [sessionId]);

  useEffect(() => {
    if (phase !== 'live') return undefined;
    const timer = window.setInterval(() => setElapsed(Math.round((Date.now() - startedAtRef.current) / 1000)), 1000);
    const saver = window.setInterval(flush, 3000);
    const usageSaver = window.setInterval(flushUsage, 3000);
    return () => { window.clearInterval(timer); window.clearInterval(saver); window.clearInterval(usageSaver); };
  }, [phase, flush, flushUsage]);

  // 채점(finishing) 중 원형 게이지를 95%까지 점점 느려지게 채운다.
  // 실제 채점은 단일 API 호출(진행률 이벤트 없음)이라 예상 소요시간 기반으로 시뮬레이션하며,
  // 채점이 끝나면 phase 가 'ended' 로 바뀌어 이 화면이 점수 화면으로 자동 전환된다.
  useEffect(() => {
    if (phase !== 'finishing') return undefined;
    setGradingProgress(8);
    const id = window.setInterval(() => {
      setGradingProgress((p) => (p >= 95 ? 95 : Math.min(95, p + Math.max(0.6, (95 - p) * 0.05))));
    }, 180);
    return () => window.clearInterval(id);
  }, [phase]);

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

  const loadHistory = useCallback(() => {
    setHistoryError('');
    setHistorySessions(null);
    request('/history')
      .then((data) => setHistorySessions(Array.isArray(data.sessions) ? data.sessions : []))
      .catch((nextError) => {
        setHistorySessions([]);
        setHistoryError(nextError instanceof Error ? nextError.message : 'CPX 기록을 불러오지 못했습니다.');
      });
  }, []);

  useEffect(() => {
    if (phase === 'ready') loadHistory();
  }, [phase, loadHistory]);

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

  const start = async (overrideCase, startOptions = {}) => {
    const target = overrideCase && overrideCase.id ? overrideCase : selected;
    if (!target || phase === 'starting') return;
    if (!processingNoticeAccepted) {
      setError('음성·대화 처리 안내를 확인해 주세요.');
      return;
    }
    if (caseId !== target.id) setCaseId(target.id);
    setPracticeMode(startOptions.mode || 'direct');
    setError(''); setResult(null); setTranscript([]); setFindings([]); setAudioLevel(0); setShowTranscript(false); setRevealed({ name: false, age: false, gender: false }); setPhase('starting'); setStatus('세션을 준비하고 있습니다.');
    autoEndedRef.current = false;
    usageRef.current = [];
    try {
      const noticeResponse = await fetch('/api/me/legal-consents', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          documentType: 'cpx_processing_notice',
          documentVersion: PRIVACY_VERSION,
        }),
      });
      if (!noticeResponse.ok) throw new Error('처리 안내 확인을 기록하지 못했습니다. 잠시 후 다시 시도해 주세요.');
      const created = await request('/sessions', { method: 'POST', body: JSON.stringify({ caseId: target.id, timeLimitSeconds: limitSeconds, lowCompliance }) });
      setSessionId(created.sessionId); setPersona(created.persona); startedAtRef.current = Date.now(); setElapsed(0);
      const token = await request(`/sessions/${created.sessionId}/live-token`, { method: 'POST' });
      const live = new GeminiLivePatient({
        onStatus: (_state, nextStatus) => setStatus(nextStatus),
        onPatientText: (text) => push('patient', sanitizePatientText(text)),
        onInputText: (text, meta) => { if (meta?.final) push('student', text); },
        onAudioLevel: setAudioLevel,
        onUsage: (usage) => { usageRef.current.push({ ...usage, tOffsetMs: Math.max(0, Date.now() - startedAtRef.current) }); },
      });
      liveRef.current = live;
      await live.connect(token);
      live.setMuted(!voiceOn);
      if (voiceOn) {
        try {
          micRef.current = await startMic(live);
        } catch {
          // 텍스트 문진은 마이크 권한과 무관하게 계속 가능해야 한다.
          setError('마이크를 사용할 수 없습니다. 아래 입력창으로 텍스트 문진은 계속할 수 있습니다.');
        }
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
      micRef.current?.stop?.(); micRef.current = null; liveRef.current?.disconnect?.({ silent: true }); liveRef.current = null; await flush(); await flushUsage();
      await request(`/sessions/${sessionId}/end`, { method: 'POST' });
      const evaluation = await request(`/sessions/${sessionId}/evaluate`, { method: 'POST' });
      setResult(evaluation); setPhase('ended'); setStatus('채점 완료');
    } catch (nextError) {
      setPhase('live'); setStatus('진료 중'); setError(nextError instanceof Error ? nextError.message : '채점을 완료하지 못했습니다.');
    }
  };
  useEffect(() => { finishRef.current = finish; });

  // 시간제한 종료 → 실제 시험처럼 자동으로 진료를 종료하고 채점한다.
  // 채점 실패(대화 부족 등)로 phase 가 live 로 돌아와도 autoEndedRef 가 재시도 루프를 막는다.
  useEffect(() => {
    if (phase !== 'live' || remaining > 0 || autoEndedRef.current) return;
    autoEndedRef.current = true;
    setStatus('제한시간이 종료되어 채점을 시작합니다.');
    finishRef.current?.();
  }, [phase, remaining]);

  // 학생이 이름·나이·성별을 물었고 환자 답변이 이어지면 해당 인적사항을 공개한다.
  useEffect(() => {
    if (!transcript.length) return;
    setRevealed((prev) => {
      const next = { ...prev };
      for (let i = 0; i < transcript.length; i += 1) {
        const ev = transcript[i];
        if (ev.role !== 'student') continue;
        const answered = transcript.slice(i + 1).some((e) => e.role === 'patient');
        if (!answered) continue;
        const q = ev.text || '';
        if (/이름|성함|성명|존함|누구세|누구시/.test(q)) { next.name = true; next.gender = true; }
        if (/나이|연세|몇\s*살|생년월일|생일|출생|태어/.test(q)) next.age = true;
        if (/성별/.test(q)) next.gender = true;
      }
      return next;
    });
  }, [transcript]);

  // 음성 on/off — off 면 마이크 정지 + 환자 오디오 mute(텍스트 문진만).
  // voiceBusyRef: 토글 진행 중(특히 startMic await 중) 잠금 — 빠른 연타 레이스 방지.
  const toggleVoice = async () => {
    if (voiceBusyRef.current) return;
    voiceBusyRef.current = true;
    try {
      const next = !voiceOn;
      setVoiceOn(next);
      liveRef.current?.setMuted?.(!next);
      // 세션 인스턴스(ref) 기준으로 판단 — phase state 클로저의 렌더 전파 지연에 의존하지 않아
      // 세션 시작 직후 찰나에도 마이크 재개가 정확히 동작한다.
      if (!liveRef.current) return;
      if (next) {
        if (!micRef.current && liveRef.current) {
          try { micRef.current = await startMic(liveRef.current); }
          catch { setError('마이크를 사용할 수 없습니다. 아래 입력창으로 텍스트 문진을 이어가세요.'); }
        }
      } else {
        micRef.current?.stop?.(); micRef.current = null;
      }
    } finally {
      voiceBusyRef.current = false;
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

  const recommendedCase = caseCatalog.cases[0] ?? null;
  const isCpxHome = false;

  return <div className={`ll-system-page space-y-7 ${isCpxHome ? 'cpx-home' : ''}`}>
    {phase !== 'ready' && (isCpxHome ? <section className="cpx-home-head flex flex-col gap-4 border-b border-[var(--color-border)] pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div><h1 className="text-3xl font-bold tracking-[-.035em] text-[var(--color-text)]">표준화 환자와<br className="hidden sm:block" /> <span>실제처럼 진료해보세요</span></h1><p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">음성 문진, 부위별 신체진찰, 루브릭 기반 피드백을 한 세션에서 이어갑니다.</p></div>
      <div className="flex flex-wrap items-center gap-2">
      <button type="button" onClick={toggleVoice} aria-pressed={voiceOn} title="시끄러운 곳에서는 음성을 끄고 텍스트로만 진료할 수 있어요" className={`cpx-voice-toggle inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border px-3 text-sm font-bold transition ${voiceOn ? 'is-on' : ''}`}>{voiceOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}음성 {voiceOn ? 'ON' : 'OFF'}</button>
      {/* 제한시간 선택 — 실전 12분 외 11:30·11:00 단축 연습. 세션 시작 후에는 잠금. */}
      <div role="group" aria-label="제한시간 선택" title="실전(12분)보다 짧게 설정해 시간 압박에 대비할 수 있어요" className="inline-flex h-9 items-center gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-1.5"><Clock3 className="h-4 w-4 text-[var(--color-muted)]" />{TIME_LIMIT_OPTIONS.map((opt) => <button key={opt.seconds} type="button" onClick={() => setLimitSeconds(opt.seconds)} disabled={phase !== 'ready'} aria-pressed={limitSeconds === opt.seconds} className={`tnum h-7 rounded-[calc(var(--radius-md)-3px)] px-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-55 ${limitSeconds === opt.seconds ? 'bg-[var(--color-primary)] text-white disabled:opacity-100' : 'text-[var(--color-muted)] hover:text-[var(--color-primary)]'}`}>{opt.label}</button>)}</div>
      <Link href="/cpx/history" className="cpx-history-link inline-flex h-9 items-center gap-1 px-1 text-sm font-bold text-[var(--color-primary)]">나의 CPX 기록 <ChevronRight className="h-4 w-4" /></Link></div>
    </section> : <section className="flex flex-col gap-4 border-b border-[var(--color-border)] pb-6 lg:flex-row lg:items-end lg:justify-between">
      <div><span className="ll-eyebrow"><Stethoscope className="h-3.5 w-3.5" /> CPX 실전 연습</span><h1 className="mt-2 text-3xl font-bold tracking-[-.035em] text-[var(--color-text)]">표준화 환자와 실제처럼 진료하세요</h1><p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">음성 문진, 부위별 신체진찰, 루브릭 기반 피드백을 한 세션에서 이어갑니다.</p></div>
      <div className="flex flex-wrap items-center gap-2"><div role="group" aria-label="제한시간 선택" title="실전(12분)보다 짧게 설정해 시간 압박에 대비할 수 있어요" className="inline-flex h-9 items-center gap-0.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-1.5"><Clock3 className="h-4 w-4 text-[var(--color-muted)]" />{TIME_LIMIT_OPTIONS.map((opt) => <button key={opt.seconds} type="button" onClick={() => setLimitSeconds(opt.seconds)} disabled={phase !== 'ready'} aria-pressed={limitSeconds === opt.seconds} className={`tnum h-7 rounded-[calc(var(--radius-md)-3px)] px-2 text-sm font-bold transition disabled:cursor-not-allowed disabled:opacity-55 ${limitSeconds === opt.seconds ? 'bg-[var(--color-primary)] text-white disabled:opacity-100' : 'text-[var(--color-muted)] hover:text-[var(--color-primary)]'}`}>{opt.label}</button>)}</div><button type="button" onClick={toggleVoice} aria-pressed={voiceOn} title="시끄러운 곳에서는 음성을 끄고 텍스트로만 진료할 수 있어요" className={`inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-md)] border px-3 text-sm font-bold transition ${voiceOn ? 'border-[var(--color-warn)] bg-[var(--color-warn)] text-white hover:opacity-90' : 'border-[var(--color-warn)] bg-white text-[var(--color-warn)] hover:bg-[var(--color-warn-bg)]'}`}>{voiceOn ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}음성 {voiceOn ? 'ON' : 'OFF'}</button><Link href="/cpx/history" className="inline-flex h-9 items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-3 text-sm font-bold text-[var(--color-text)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]">나의 기록 <ChevronRight className="h-4 w-4" /></Link></div>
    </section>)}

    {phase === 'ready' && (
      catalogLoading ? (
        <div className="ll-card py-20 text-center text-[var(--color-muted)]">승인 증례를 불러오는 중…</div>
      ) : (
        <>
          <CpxStartExperience
            caseCatalog={caseCatalog}
            rawPartGroups={partGroups}
            historySessions={historySessions}
            historyLoading={historySessions === null}
            historyError={historyError}
            onRetryHistory={loadHistory}
            timeOptions={TIME_LIMIT_OPTIONS}
            limitSeconds={limitSeconds}
            onLimitChange={setLimitSeconds}
            voiceOn={voiceOn}
            onVoiceChange={setVoiceOn}
            lowComplianceOn={lowCompliance}
            onLowComplianceChange={setLowCompliance}
            onStart={start}
          />
          {catalogError && <div role="alert" className="flex gap-2 rounded-[var(--radius-md)] border border-[var(--color-warn)] bg-[var(--color-warn-bg)] p-3 text-sm text-[var(--color-warn)]"><ShieldAlert className="h-5 w-5 shrink-0" />{catalogError}</div>}
          {error && <div role="alert" className="flex gap-2 rounded-[var(--radius-md)] border border-[var(--color-warn)] bg-[var(--color-warn-bg)] p-3 text-sm text-[var(--color-warn)]"><ShieldAlert className="h-5 w-5 shrink-0" />{error}</div>}
        </>
      )
    )}

    {phase === 'ready' && (
      <section className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-sage-50)] p-4" aria-labelledby="cpx-processing-notice-title">
        <div className="flex items-start gap-3">
          <Shield className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" />
          <div className="min-w-0 flex-1">
            <h2 id="cpx-processing-notice-title" className="text-sm font-bold text-[var(--color-text)]">음성·대화 처리 안내</h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-muted)]">
              연습 중 마이크 음성과 입력 문장은 Google Gemini에 실시간 전송되어 가상 환자 응답과 전사·AI 채점에 사용됩니다. 대화록과 평가 결과는 연습 기록 제공을 위해 저장되므로 실제 환자 이름·주민번호 등 개인정보를 말하지 마세요.
            </p>
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm font-semibold text-[var(--color-text)]">
              <input type="checkbox" checked={processingNoticeAccepted} onChange={(event) => { setProcessingNoticeAccepted(event.target.checked); setError(''); }} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
              위 처리 내용을 확인했습니다. (필수)
            </label>
            <p className="mt-2 text-xs text-[var(--color-muted)]"><Link href="/privacy" target="_blank" className="underline">개인정보처리방침 자세히 보기</Link> · AI 결과는 학습 보조용이며 의료행위 또는 공식 시험 판정이 아닙니다.</p>
            {error && <p role="alert" className="mt-2 text-sm font-semibold text-[var(--color-warn)]">{error}</p>}
          </div>
        </div>
      </section>
    )}

    {phase === 'ready' && (
      <section className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-sage-50)] p-4" aria-labelledby="cpx-processing-notice-title">
        <div className="flex items-start gap-3">
          <Shield className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-primary)]" />
          <div className="min-w-0 flex-1">
            <h2 id="cpx-processing-notice-title" className="text-sm font-bold text-[var(--color-text)]">음성·대화 처리 안내</h2>
            <p className="mt-1 text-sm leading-relaxed text-[var(--color-muted)]">
              연습 중 마이크 음성과 입력 문장은 Google Gemini에 실시간 전송되어 가상 환자 응답과 전사·AI 채점에 사용됩니다. 대화록과 평가 결과는 연습 기록 제공을 위해 저장되므로 실제 환자 이름·주민번호 등 개인정보를 말하지 마세요.
            </p>
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-sm font-semibold text-[var(--color-text)]">
              <input type="checkbox" checked={processingNoticeAccepted} onChange={(event) => { setProcessingNoticeAccepted(event.target.checked); setError(''); }} className="mt-0.5 h-4 w-4 accent-[var(--color-primary)]" />
              위 처리 내용을 확인했습니다. (필수)
            </label>
            <p className="mt-2 text-xs text-[var(--color-muted)]"><Link href="/privacy" target="_blank" className="underline">개인정보처리방침 자세히 보기</Link> · AI 결과는 학습 보조용이며 의료행위 또는 공식 시험 판정이 아닙니다.</p>
            {error && <p role="alert" className="mt-2 text-sm font-semibold text-[var(--color-warn)]">{error}</p>}
          </div>
        </div>
      </section>
    )}

    {/* 세션 진입 전: 파트 선택 → (좌 주호소 리스트 / 우 시나리오 리스트) → 연습 시작 */}
    {false && phase === 'ready' && (
      catalogLoading ? (
        <div className="ll-card py-20 text-center text-[var(--color-muted)]">승인 증례를 불러오는 중…</div>
      ) : (
      <div className="space-y-4">
        {!activePart && !searchResults && recommendedCase && <section className="cpx-featured-case" aria-labelledby="cpx-featured-title">
          <div className="cpx-featured-main">
            <div className="cpx-featured-label"><Stethoscope className="h-4 w-4" />오늘의 추천 증례</div>
            <h2 id="cpx-featured-title">{recommendedCase.title}</h2>
            <div className="cpx-featured-actions"><Button size="lg" onClick={() => start(recommendedCase)} loading={phase === 'starting' && caseId === recommendedCase.id}>추천 증례 시작하기 <ChevronRight className="h-4 w-4" /></Button><button type="button" onClick={() => document.getElementById('cpx-parts')?.scrollIntoView({ behavior: 'smooth' })}>다른 증례 고르기</button></div>
          </div>
          <aside className="cpx-session-guide" aria-label="CPX 연습 진행 과정"><h3>한 세션에서 이렇게 연습해요</h3><ol><li><b>01</b><span><strong>문진</strong>환자에게 직접 질문하기</span></li><li><b>02</b><span><strong>신체진찰</strong>필요한 진찰 선택하기</span></li><li><b>03</b><span><strong>피드백</strong>영역별 근거 확인하기</span></li></ol></aside>
        </section>}
        {/* 통합 검색창 (우측 상단) — 주호소·시나리오 키워드로 바로 찾기 */}
        <div className="flex justify-end">
          <div className="relative w-full sm:max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="주호소·시나리오 검색 (예: 두통, 흉통, 통풍)"
              className="h-11 w-full rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white pl-9 pr-9 text-sm outline-none transition focus:border-[var(--color-primary)]"
            />
            {query && <button type="button" onClick={() => setQuery('')} aria-label="검색어 지우기" className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--color-muted)] transition hover:text-[var(--color-text)]"><XCircle className="h-4 w-4" /></button>}
          </div>
        </div>

        {searchResults ? (
          /* 검색 결과: 주호소(클릭 → 시나리오 선택으로 이동) + 시나리오(바로 연습) */
          <div className="space-y-4">
            {searchResults.cats.length === 0 && searchResults.cases.length === 0 ? (
              <div className="cpx-empty">‘{query}’에 해당하는 주호소·시나리오가 없습니다.</div>
            ) : (<>
              {searchResults.cats.length > 0 && (
                <div className="cpx-cat-list">
                  <div className="cpx-col-head">주호소 · {searchResults.cats.length}</div>
                  {searchResults.cats.map((cat) => {
                    const CatIcon = catIcon(cat);
                    return (
                      <button key={cat} type="button" onClick={() => openCategory(cat)} className="cpx-cat-row">
                        <span className="cpx-cat-icon"><CatIcon className="w-[18px] h-[18px]" strokeWidth={1.9} /></span>
                        <span className="cpx-cat-name">{cat}</span>
                        <span className="cpx-cat-count">{casesByCategory[cat]?.length ?? 0}</span>
                        <ChevronRight className="w-4 h-4 shrink-0 text-[var(--color-muted)]" />
                      </button>
                    );
                  })}
                </div>
              )}
              {searchResults.cases.length > 0 && (
                <div className="cpx-case-list">
                  <div className="cpx-col-head">시나리오 · {searchResults.cases.length}</div>
                  {searchResults.cases.slice(0, 40).map((item) => (
                    <div key={item.id} className="cpx-case-row">
                      <div className="min-w-0">
                        <div className="cpx-case-title">{item.title}</div>
                        <div className="cpx-case-desc"><span className="font-semibold text-[var(--color-primary)]">{item.category}</span> · {item.description || item.variant || '표준화 환자와 12분 진료 세션을 진행합니다.'}{item.physicalExamRequired === false && <span className="font-semibold text-[var(--color-primary)]"> · 신체진찰 없음</span>}</div>
                      </div>
                      <Button variant="accent" size="sm" onClick={() => start(item)} loading={phase === 'starting' && caseId === item.id}>
                        <Mic className="h-4 w-4" /> 바로 연습
                      </Button>
                    </div>
                  ))}
                  {searchResults.cases.length > 40 && <div className="cpx-empty">상위 40개만 표시됩니다. 검색어를 더 구체적으로 입력해보세요.</div>}
                </div>
              )}
            </>)}
          </div>
        ) : !activePart ? (
        <section id="cpx-parts" className="cpx-parts space-y-4">
          <div className="cpx-parts-heading"><div><h2>전체 파트에서 찾아보기</h2><p>연습하려는 주호소나 시나리오를 선택하세요.</p></div></div>
          <section className="cpx-home-part-list">
            {partGroups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => { setSelectedPart(g.id); setSelectedCategory(g.cats[0] ?? ''); }}
                className="cpx-home-part-row"
              >
                <div className="cpx-part-head">
                  <span className="cpx-part-icon"><g.Icon className="w-6 h-6" strokeWidth={1.9} /></span>
                  <div>
                    <h3 className="cpx-part-title">{g.label}</h3>
                    <p className="cpx-part-desc">{g.desc}</p>
                  </div>
                </div>
                <div className="cpx-part-cats">
                  {g.cats.slice(0, 6).map((c) => <span key={c} className="cpx-part-chip">{c}</span>)}
                  {g.cats.length > 6 && <span className="cpx-part-chip cpx-part-chip-more">+{g.cats.length - 6}</span>}
                </div>
                <div className="cpx-part-foot">
                  <span><strong>{g.cats.length}</strong> 주호소 · <strong>{partCaseCount(g)}</strong> 시나리오</span>
                  <span className="cpx-part-go">선택 <ChevronRight className="w-4 h-4" /></span>
                </div>
              </button>
            ))}
          </section>
          {catalogError && <div role="alert" className="flex gap-2 rounded-[var(--radius-md)] border border-[var(--color-warn)] bg-[var(--color-warn-bg)] p-3 text-sm text-[var(--color-warn)]"><ShieldAlert className="h-5 w-5 shrink-0" />{catalogError}</div>}
        </section>
      ) : (
        <section className="cpx-selected-part space-y-4">
          <div className="cpx-selected-toolbar flex items-center justify-between gap-3">
            <button type="button" onClick={() => { setSelectedPart(''); setSelectedCategory(''); }} className="inline-flex items-center gap-1 text-sm font-bold text-[var(--color-primary)]">
              <ChevronLeft className="w-4 h-4" /> 파트 다시 선택
            </button>
            <h2 className="inline-flex items-center gap-2 text-lg font-bold text-[var(--color-text)]"><activePart.Icon className="w-5 h-5 text-[var(--color-primary)]" strokeWidth={2} /> {activePart.label}</h2>
          </div>
          <div className="cpx-split">
            {/* 좌: 주호소 리스트 */}
            <div className="cpx-cat-list">
              <div className="cpx-col-head">주호소</div>
              {activePart.cats.map((cat) => {
                const on = cat === selectedCategory;
                const CatIcon = catIcon(cat);
                return (
                  <button
                    key={cat}
                    type="button"
                    onClick={() => setSelectedCategory(cat)}
                    className={`cpx-cat-row ${on ? 'active' : ''}`}
                  >
                    <span className="cpx-cat-icon"><CatIcon className="w-[18px] h-[18px]" strokeWidth={1.9} /></span>
                    <span className="cpx-cat-name">{cat}</span>
                    <span className="cpx-cat-count">{casesByCategory[cat]?.length ?? 0}</span>
                    <ChevronRight className="w-4 h-4 shrink-0 text-[var(--color-muted)]" />
                  </button>
                );
              })}
            </div>
            {/* 우: 시나리오 리스트 */}
            <div className="cpx-case-list">
              <div className="cpx-col-head">{selectedCategory ? `${selectedCategory} 시나리오` : '시나리오'}</div>
              {!selectedCategory ? (
                <div className="cpx-empty">왼쪽에서 주호소를 선택하세요.</div>
              ) : (casesByCategory[selectedCategory] ?? []).length === 0 ? (
                <div className="cpx-empty">등록된 시나리오가 없습니다.</div>
              ) : (
                (casesByCategory[selectedCategory] ?? []).map((item) => (
                  <div key={item.id} className="cpx-case-row">
                    <div className="min-w-0">
                      <div className="cpx-case-title">{item.title}</div>
                      <div className="cpx-case-desc">{item.description || item.variant || '표준화 환자와 12분 진료 세션을 진행합니다.'}{item.physicalExamRequired === false && <span className="font-semibold text-[var(--color-primary)]"> · 신체진찰 없음</span>}</div>
                    </div>
                    <Button variant="accent" size="sm" onClick={() => start(item)} loading={phase === 'starting' && caseId === item.id}>
                      <Mic className="h-4 w-4" /> 연습 시작
                    </Button>
                  </div>
                ))
              )}
            </div>
          </div>
          {error && <div role="alert" className="flex gap-2 rounded-[var(--radius-md)] border border-[var(--color-warn)] bg-[var(--color-warn-bg)] p-3 text-sm text-[var(--color-warn)]"><ShieldAlert className="h-5 w-5 shrink-0" />{error}</div>}
        </section>
        )}
      </div>
      )
    )}

    {/* 세션 진행/결과 뷰 — 진료 시작 이후 */}
    {phase !== 'ready' && (<>
    {/* 진료 중 화면(아바타·전사·신체진찰) — 채점/결과 단계에서는 숨긴다 */}
    {(phase === 'starting' || phase === 'live') && (<>
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,.9fr)]">
      <Card className="overflow-hidden p-0"><div className="relative min-h-[430px] bg-[#143c2c]"><div className="absolute left-4 top-4 z-10 rounded-[var(--radius-md)] bg-black/20 px-3 py-2 text-white"><div className="text-xs text-white/70">주소증</div><div className="font-bold">{selected?.category}</div></div><div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-sm font-bold text-white"><Wave active={phase === 'live'} />{status}</div>{examTarget && phase === 'live' && <button type="button" onClick={() => setExamTarget(null)} className="absolute bottom-4 left-4 z-10 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3.5 py-2 text-sm font-bold text-[var(--color-primary)] shadow-lg transition hover:bg-white"><PersonStanding className="h-4 w-4" /> 환자 앉히기</button>}<div className="h-[430px]"><Avatar3D gender={persona?.gender || '여성'} age={persona?.age || 48} child={persona?.child || null} speaking={audioLevel > 0.02} audioLevel={audioLevel} pose={examTarget ? 'lying' : 'sitting'} examTarget={examTarget} category={selected?.category || ''} /></div></div><div className="border-t border-[var(--color-border)] bg-white p-4"><div className="space-y-2">{transcript.length ? transcript.slice(-3).map((event, index) => <div key={`${event.tOffsetMs}-${index}`} className={event.role === 'student' ? 'text-right' : 'text-left'}><span className={`inline-block max-w-[88%] rounded-[var(--radius-md)] px-3 py-2 text-sm ${event.role === 'student' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-sage-100)] text-[var(--color-text)]'}`}>{event.text}</span></div>) : <p className="py-5 text-center text-sm text-[var(--color-muted)]">진료 시작 후 환자에게 질문하거나 음성으로 대화해 보세요.</p>}{transcript.length > 3 && <p className="pt-1 text-center text-[11px] text-[var(--color-muted)]">실제 시험처럼 최근 대화만 표시됩니다 · 전체 기록은 채점에 반영됩니다</p>}</div><form onSubmit={sendText} className="mt-3 flex gap-2"><input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={phase !== 'live'} placeholder="보조 텍스트 입력 — 음성 문진도 자동 전사됩니다" className="h-11 min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 text-sm outline-none focus:border-[var(--color-primary)] disabled:bg-[var(--color-surface-muted)]"/><Button type="submit" variant="primary" disabled={phase !== 'live' || !draft.trim()}><Send className="h-4 w-4" />전송</Button></form></div></Card>

      <div className="space-y-6"><Card title="환자 정보" icon={<UserRound className="h-5 w-5" />}><div className="space-y-2 text-sm">{persona ? (<>{persona.child && <p className="text-xs font-bold text-[var(--color-primary)]">보호자 (대화 상대)</p>}<div className="space-y-1.5">{[['이름', revealed.name ? persona.name : null], ['나이', revealed.age ? `${persona.age}세` : null], ['성별', revealed.gender ? persona.gender : null]].map(([label, val]) => <div key={label} className="flex items-center justify-between gap-2"><span className="text-[var(--color-muted)]">{label}</span><span className={val ? 'font-bold text-[var(--color-text)]' : 'text-[var(--color-muted)]'}>{val || '—'}</span></div>)}</div>{persona.child && (<><p className="pt-1 text-xs font-bold text-[var(--color-primary)]">환아</p><div className="space-y-1.5">{[['이름', revealed.name ? persona.child.name : null], ['나이', revealed.age ? (persona.child.ageDetail || `${persona.child.age}세`) : null], ['성별', revealed.gender ? persona.child.gender : null]].map(([label, val]) => <div key={`child-${label}`} className="flex items-center justify-between gap-2"><span className="text-[var(--color-muted)]">{label}</span><span className={val ? 'font-bold text-[var(--color-text)]' : 'text-[var(--color-muted)]'}>{val || '—'}</span></div>)}</div></>)}{(!revealed.name || !revealed.age || !revealed.gender) && <p className="text-xs text-[var(--color-muted)]">{persona.child ? '보호자에게 환아의 이름·나이·성별을 직접 확인하세요.' : '환자에게 이름·나이·성별을 직접 여쭤보세요.'}</p>}</>) : <p className="font-bold text-[var(--color-text)]">진료 시작 시 환자 정보가 확정됩니다.</p>}{practiceMode === 'random' ? <div className="rounded-[var(--radius-md)] bg-[var(--color-sage-100)] p-3"><p className="font-bold text-[var(--color-text)]">무작위 실전 증례</p><p className="mt-1 text-xs text-[var(--color-muted)]">진단과 시나리오 정보는 채점 전까지 공개되지 않습니다.</p></div> : <><p className="text-[var(--color-muted)]">{selected?.title}</p><p className="text-[var(--color-muted)]">{selected?.variant}</p></>}</div></Card><Card title="남은 시간" icon={<Clock3 className="h-5 w-5" />} action={<span className={`tnum text-2xl font-bold ${remaining < 120 ? 'text-[var(--color-warn)]' : 'text-[var(--color-primary)]'}`}>{formatTime(remaining)}</span>}><Button fullWidth variant="accent" onClick={finish} disabled={phase !== 'live'}><Activity className="h-4 w-4" />진료 종료 및 채점</Button></Card>
      {/* 신체진찰 — 전체 화면에서 우측 빈 공간(환자정보·남은시간 아래)에 배치.
          신체진찰 면제 시나리오는 버튼 대신 안내만 보여주고, 채점에서도 진찰 영역이 제외된다. */}
      {selected?.physicalExamRequired === false ? (
      <Card title="신체진찰" icon={<Stethoscope className="h-5 w-5" />}>
        <p className="text-sm text-[var(--color-muted)]">이 시나리오는 신체진찰이 필요하지 않습니다. 진찰을 하지 않아도 감점되지 않으니 병력청취와 환자교육에 집중하세요.</p>
      </Card>
      ) : (
      <Card title="신체진찰" description="신체 부위를 먼저 고른 뒤, 해당 부위의 진찰을 선택하세요." icon={<Stethoscope className="h-5 w-5" />}><div className="flex flex-wrap gap-2">{activeRegions.map((item) => <button key={item.id} onClick={() => { setRegion(item.id); setExamTarget(null); }} className={`rounded-full border px-3 py-1.5 text-sm font-bold transition ${region === item.id ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white' : 'border-[var(--color-border)] bg-white text-[var(--color-muted)] hover:border-[var(--color-primary)]'}`}>{item.label}</button>)}</div><div className="mt-4 grid gap-2 sm:grid-cols-2">{visibleButtons.map((button) => <Button key={button.id} variant="secondary" fullWidth disabled={phase !== 'live'} onClick={() => examine(button)}><Stethoscope className="h-4 w-4" />{button.label}</Button>)}</div>{findings.length > 0 && <div className="mt-5 grid gap-3">{findings.map((card) => <div key={card.buttonId} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-sage-50)] p-4"><div className="font-bold text-[var(--color-text)]">{card.label}</div><ul className="mt-2 space-y-1 text-sm text-[var(--color-muted)]">{card.findings.map((finding, index) => <li key={index}>• {finding.finding}</li>)}</ul></div>)}</div>}</Card>
      )}</div>
    </section>

    </>)}

    {/* 채점 중 로딩 화면 — '진료 종료 및 채점' 직후 자동 표시, 완료되면 아래 점수 화면으로 자동 전환 */}
    {phase === 'finishing' && (
      <Card className="py-16">
        <div className="flex flex-col items-center justify-center text-center">
          <div className="relative h-44 w-44">
            <svg className="h-44 w-44 -rotate-90" viewBox="0 0 120 120" aria-hidden>
              <circle cx="60" cy="60" r="52" fill="none" stroke="var(--color-sage-100)" strokeWidth="10" />
              <circle
                cx="60" cy="60" r="52" fill="none"
                stroke="var(--color-primary)" strokeWidth="10" strokeLinecap="round"
                strokeDasharray={2 * Math.PI * 52}
                strokeDashoffset={2 * Math.PI * 52 * (1 - gradingProgress / 100)}
                style={{ transition: 'stroke-dashoffset 0.25s ease-out' }}
              />
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center">
              <span className="tnum text-4xl font-bold text-[var(--color-primary)]">{Math.round(gradingProgress)}%</span>
              <span className="mt-1 text-xs font-semibold text-[var(--color-muted)]">채점 진행</span>
            </div>
          </div>
          <h2 className="mt-7 text-xl font-bold text-[var(--color-text)]">채점 중입니다. 잠시만 기다려 주세요</h2>
          <p className="mt-2 text-sm text-[var(--color-muted)]">{status || '대화 기록과 진찰 내역을 바탕으로 루브릭 채점을 진행하고 있어요.'}</p>
        </div>
      </Card>
    )}

    {result && <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-sage-50)] p-3 text-sm text-[var(--color-muted)]"><b className="text-[var(--color-text)]">AI 생성 평가</b> · 학습 보조 결과이며 오류가 있을 수 있습니다. 항목별 근거를 확인하고 공식 평가나 의료 판단에 사용하지 마세요.</div>}
    {/* 순응도 낮은 환자 모드 — 어떤 저항 유형이었는지는 실제 SP 시험처럼 채점 후에만 공개.
        25% 확률에서 빗나간 세션은 협조적인 환자였다고 알려준다. */}
    {result?.lowCompliance?.enabled && (result.lowCompliance.behaviors?.length > 0
      ? <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-sage-50)] p-3 text-sm text-[var(--color-muted)]"><b className="text-[var(--color-text)]">순응도 낮은 환자</b> · 이번 환자의 저항 유형: {result.lowCompliance.behaviors.map((b) => b.name).join(' · ')}. 저항의 이유를 먼저 묻고 공감한 뒤 설득했는지 대화록에서 확인해 보세요.</div>
      : <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-sage-50)] p-3 text-sm text-[var(--color-muted)]"><b className="text-[var(--color-text)]">순응도 낮은 환자 모드</b> · 이번에는 협조적인 환자였어요. 실제 시험처럼 25% 확률로 저항하는 환자가 배정됩니다.</div>)}
    {result && <Card title="CPX 결과" description="영역 카드를 누르면 항목별 상세 채점 근거가 펼쳐집니다." icon={<Sparkles className="h-5 w-5" />}><div className="grid gap-5 md:grid-cols-[auto_1fr]"><div className="rounded-[var(--radius-md)] bg-[var(--color-primary)] px-7 py-5 text-center text-white self-start"><div className="text-xs text-white/70">총점</div><div className="tnum mt-1 text-5xl font-bold">{result.totalScore}</div><div className="mt-1 text-sm">{result.overallGradeLabel}</div></div>
      <div className="space-y-3">
        <CpxTimeAnalysis analysis={result.timeAnalysis} excludedSections={result.excludedSections} />
        <div className="grid gap-3 sm:grid-cols-2">{(result.sections || []).map((section) => { const open = expandedSection === section.id; const isDeduction = Array.isArray(section.satisfiedIds) === false && section.violationCount !== undefined; return (
          <button key={section.id} type="button" onClick={() => setExpandedSection(open ? null : section.id)} className={`text-left rounded-[var(--radius-md)] border p-3 transition ${open ? 'border-[var(--color-primary)] bg-[var(--color-sage-50)]' : 'border-[var(--color-border)] hover:border-[var(--color-primary)]'}`}>
            <div className="flex items-center justify-between gap-3"><span className="font-bold text-[var(--color-text)]">{section.name}</span><span className="inline-flex items-center gap-1"><span className="tnum font-bold text-[var(--color-primary)]">{section.score}</span><ChevronDown className={`h-4 w-4 text-[var(--color-muted)] transition-transform ${open ? 'rotate-180' : ''}`} /></span></div>
            <p className="mt-1 text-xs text-[var(--color-muted)]">{isDeduction ? `감점 위반 ${section.violationCount ?? 0}건 · 등급 ${section.gradeLabel ?? ''}` : `충족 ${section.satisfiedCount}/${section.applicableCount}${section.partialCount ? ` · 부분 ${section.partialCount}` : ''} · 등급 ${section.gradeLabel ?? ''}`}</p>
          </button>
        ); })}</div>
        {expandedSection && (() => { const s = (result.sections || []).find((x) => x.id === expandedSection); if (!s) return null; const tx = result.itemTexts || {}; const rows = [
          ...(s.satisfiedIds || []).map((id) => ({ id, kind: 'met' })),
          ...(s.partialIds || []).map((id) => ({ id, kind: 'partial' })),
          ...(s.missedIds || []).map((id) => ({ id, kind: 'missed' })),
        ]; return (
          <div className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white p-4">
            <div className="mb-2 text-sm font-bold text-[var(--color-text)]">{s.name} — 상세 채점</div>
            {rows.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">{s.violationCount !== undefined ? `위반 ${s.violationCount}건. 감점 영역은 위반 행위만 집계됩니다.` : '표시할 항목이 없습니다.'}</p>
            ) : (
              <ul className="space-y-1.5">{rows.map((r) => (
                <li key={r.id} className="flex items-start gap-2 text-sm">
                  {r.kind === 'met' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" /> : r.kind === 'partial' ? <MinusCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warn)]" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]" />}
                  <span className={r.kind === 'missed' ? 'text-[var(--color-muted)]' : 'text-[var(--color-text)]'}>{tx[r.id] || r.id}{r.kind === 'partial' && <em className="ml-1 not-italic text-[var(--color-warn)]">(부분)</em>}</span>
                </li>
              ))}</ul>
            )}
          </div>
        ); })()}
      </div>
    </div></Card>}

    {phase === 'ended' && (
      <>
        {/* 전체 대화록 — 세션 동안 쌓인 transcript state 그대로 표시 (진찰 선언 포함, 서버 조회 불필요) */}
        {showTranscript && (
          <Card title="전체 대화록" description="이번 진료에서 환자와 나눈 대화 전체입니다. 신체진찰 선언도 함께 표시됩니다." icon={<MessageCircle className="h-5 w-5" />}>
            <CpxTranscriptView events={transcript} />
          </Card>
        )}
        <div className="flex flex-wrap justify-center gap-3">
          <Button variant="secondary" size="lg" onClick={() => setShowTranscript((current) => !current)} aria-expanded={showTranscript}>
            <MessageCircle className="h-4 w-4" /> {showTranscript ? '전체 대화록 닫기' : '전체 대화록'}
          </Button>
          <Button variant="accent" size="lg" onClick={() => { setPhase('ready'); setPracticeMode('direct'); setCaseId(''); setResult(null); setTranscript([]); setFindings([]); setShowTranscript(false); setSessionId(''); setPersona(null); setStatus('증례를 선택하고 진료를 시작하세요.'); setError(''); }}>
            <RotateCcw className="h-4 w-4" /> 다른 증례로 다시 연습
          </Button>
        </div>
      </>
    )}
    </>)}
  </div>;
}
