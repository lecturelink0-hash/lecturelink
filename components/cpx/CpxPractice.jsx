'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Activity, Baby, Brain, CheckCircle2, ChevronDown, ChevronLeft, ChevronRight, ClipboardList, Clock3, Ear, Eye, Heart, MessageCircle, Mic, MinusCircle, PersonStanding, RotateCcw, Search, Send, Shield, ShieldAlert, Sparkles, Stethoscope, UserRound, Utensils, Wind, XCircle } from 'lucide-react';
import Avatar3D from './Avatar3D';
import { GeminiLivePatient } from './live';
import { startMic } from './mic';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';

const SESSION_SECONDS = 12 * 60;

// 시나리오 작성 시 나눴던 파트 기준 그룹. 주호소(카테고리)를 대분류로 묶어 먼저 제시한다.
// 백엔드에 새 카테고리가 생겨 어느 파트에도 없으면 '기타'로 폴백한다.
const PART_GROUPS = [
  {
    id: 'history', label: '병력청취 중심', Icon: ClipboardList,
    desc: '문진으로 감별하는 내과계 주호소',
    cats: ['수면장애', '피로', '두통', '어지럼', '발열', '소화불량/만성복통', '콧물/코막힘',
      '배뇨 이상', '변비', '기침', '실신', '기억력 저하', '체중 감소', '설사', '이상지질혈증',
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
  // 파트(대분류) → 주호소(카테고리) → 증례 3단계. 세션 진입 전(phase==='ready')에만 노출.
  const [selectedPart, setSelectedPart] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('');
  const casesByCategory = useMemo(() => {
    const grouped = {};
    for (const item of caseCatalog.cases) {
      if (!item?.category) continue;
      (grouped[item.category] ||= []).push(item);
    }
    return grouped;
  }, [caseCatalog]);
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
  const activePart = useMemo(() => partGroups.find((g) => g.id === selectedPart) ?? null, [partGroups, selectedPart]);
  const partCaseCount = (g) => g.cats.reduce((sum, c) => sum + (casesByCategory[c]?.length ?? 0), 0);
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
  const [expandedSection, setExpandedSection] = useState(null); // 채점 결과에서 펼친 영역 id
  const [gradingProgress, setGradingProgress] = useState(0); // 채점 로딩 원형 게이지(%)
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

  const start = async (overrideCase) => {
    const target = overrideCase && overrideCase.id ? overrideCase : selected;
    if (!target || phase === 'starting') return;
    if (caseId !== target.id) setCaseId(target.id);
    setError(''); setResult(null); setTranscript([]); setFindings([]); setAudioLevel(0); setPhase('starting'); setStatus('세션을 준비하고 있습니다.');
    try {
      const created = await request('/sessions', { method: 'POST', body: JSON.stringify({ caseId: target.id }) });
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
      <div className="flex flex-wrap items-center gap-2"><Badge>{caseCatalog.cases.length}개 증례</Badge><Badge variant="beta">12분</Badge><Link href="/cpx/history" className="inline-flex h-9 items-center gap-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white px-3 text-sm font-bold text-[var(--color-text)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)]">나의 기록 <ChevronRight className="h-4 w-4" /></Link></div>
    </section>

    {/* 세션 진입 전: 파트 선택 → (좌 주호소 리스트 / 우 시나리오 리스트) → 연습 시작 */}
    {phase === 'ready' && (
      catalogLoading ? (
        <div className="ll-card py-20 text-center text-[var(--color-muted)]">승인 증례를 불러오는 중…</div>
      ) : !activePart ? (
        <section className="cpx-parts space-y-4">
          <div className="grid-note text-right">먼저 연습할 파트를 선택하세요. 파트 안에서 주호소와 시나리오를 고릅니다.</div>
          <section className="cpx-part-grid">
            {partGroups.map((g) => (
              <button
                key={g.id}
                type="button"
                onClick={() => { setSelectedPart(g.id); setSelectedCategory(g.cats[0] ?? ''); }}
                className="cpx-part-card"
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
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <button type="button" onClick={() => { setSelectedPart(''); setSelectedCategory(''); }} className="inline-flex items-center gap-1 text-sm font-bold text-[var(--color-muted)] hover:text-[var(--color-primary)]">
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
                      <div className="cpx-case-desc">{item.description || item.variant || '표준화 환자와 12분 진료 세션을 진행합니다.'}</div>
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
      )
    )}

    {/* 세션 진행/결과 뷰 — 진료 시작 이후 */}
    {phase !== 'ready' && (<>
    {/* 진료 중 화면(아바타·전사·신체진찰) — 채점/결과 단계에서는 숨긴다 */}
    {(phase === 'starting' || phase === 'live') && (<>
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(340px,.9fr)]">
      <Card className="overflow-hidden p-0"><div className="relative min-h-[430px] bg-[#143c2c]"><div className="absolute left-4 top-4 z-10 rounded-[var(--radius-md)] bg-black/20 px-3 py-2 text-white"><div className="text-xs text-white/70">주소증</div><div className="font-bold">{selected?.category}</div></div><div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-full bg-white/10 px-3 py-1.5 text-sm font-bold text-white"><Wave active={phase === 'live'} />{status}</div>{examTarget && phase === 'live' && <button type="button" onClick={() => setExamTarget(null)} className="absolute bottom-4 left-4 z-10 inline-flex items-center gap-1.5 rounded-full bg-white/95 px-3.5 py-2 text-sm font-bold text-[var(--color-primary)] shadow-lg transition hover:bg-white"><PersonStanding className="h-4 w-4" /> 환자 앉히기</button>}<div className="h-[430px]"><Avatar3D gender={persona?.gender || '여성'} age={persona?.age || 48} speaking={audioLevel > 0.02} audioLevel={audioLevel} pose={examTarget ? 'lying' : 'sitting'} examTarget={examTarget} /></div></div><div className="border-t border-[var(--color-border)] bg-white p-4"><div className="space-y-2">{transcript.length ? transcript.slice(-3).map((event, index) => <div key={`${event.tOffsetMs}-${index}`} className={event.role === 'student' ? 'text-right' : 'text-left'}><span className={`inline-block max-w-[88%] rounded-[var(--radius-md)] px-3 py-2 text-sm ${event.role === 'student' ? 'bg-[var(--color-primary)] text-white' : 'bg-[var(--color-sage-100)] text-[var(--color-text)]'}`}>{event.text}</span></div>) : <p className="py-5 text-center text-sm text-[var(--color-muted)]">진료 시작 후 환자에게 질문하거나 음성으로 대화해 보세요.</p>}{transcript.length > 3 && <p className="pt-1 text-center text-[11px] text-[var(--color-muted)]">실제 시험처럼 최근 대화만 표시됩니다 · 전체 기록은 채점에 반영됩니다</p>}</div><form onSubmit={sendText} className="mt-3 flex gap-2"><input value={draft} onChange={(event) => setDraft(event.target.value)} disabled={phase !== 'live'} placeholder="보조 텍스트 입력 — 음성 문진도 자동 전사됩니다" className="h-11 min-w-0 flex-1 rounded-[var(--radius-md)] border border-[var(--color-border)] px-3 text-sm outline-none focus:border-[var(--color-primary)] disabled:bg-[var(--color-surface-muted)]"/><Button type="submit" variant="primary" disabled={phase !== 'live' || !draft.trim()}><Send className="h-4 w-4" />전송</Button></form></div></Card>

      <div className="space-y-6"><Card title="환자 정보" icon={<UserRound className="h-5 w-5" />}><div className="space-y-2 text-sm"><p className="font-bold text-[var(--color-text)]">{persona ? `${persona.name} · ${persona.age}세 · ${persona.gender}` : '진료 시작 시 환자 정보가 확정됩니다.'}</p><p className="text-[var(--color-muted)]">{selected?.title}</p><p className="text-[var(--color-muted)]">{selected?.variant}</p></div></Card><Card title="남은 시간" icon={<Clock3 className="h-5 w-5" />} action={<span className={`tnum text-2xl font-bold ${remaining < 120 ? 'text-[var(--color-warn)]' : 'text-[var(--color-primary)]'}`}>{formatTime(remaining)}</span>}><Button fullWidth variant="accent" onClick={finish} disabled={phase !== 'live'}><Activity className="h-4 w-4" />진료 종료 및 채점</Button></Card>
      {/* 신체진찰 — 전체 화면에서 우측 빈 공간(환자정보·남은시간 아래)에 배치 */}
      <Card title="신체진찰" description="신체 부위를 먼저 고른 뒤, 해당 부위의 진찰을 선택하세요." icon={<Stethoscope className="h-5 w-5" />}><div className="flex flex-wrap gap-2">{activeRegions.map((item) => <button key={item.id} onClick={() => { setRegion(item.id); setExamTarget(null); }} className={`rounded-full border px-3 py-1.5 text-sm font-bold transition ${region === item.id ? 'border-[var(--color-primary)] bg-[var(--color-primary)] text-white' : 'border-[var(--color-border)] bg-white text-[var(--color-muted)] hover:border-[var(--color-primary)]'}`}>{item.label}</button>)}</div><div className="mt-4 grid gap-2 sm:grid-cols-2">{visibleButtons.map((button) => <Button key={button.id} variant="secondary" fullWidth disabled={phase !== 'live'} onClick={() => examine(button)}><Stethoscope className="h-4 w-4" />{button.label}</Button>)}</div>{findings.length > 0 && <div className="mt-5 grid gap-3">{findings.map((card) => <div key={card.buttonId} className="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-sage-50)] p-4"><div className="font-bold text-[var(--color-text)]">{card.label}</div><ul className="mt-2 space-y-1 text-sm text-[var(--color-muted)]">{card.findings.map((finding, index) => <li key={index}>• {finding.finding}</li>)}</ul></div>)}</div>}</Card></div>
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

    {result && <Card title="CPX 결과" description="영역 카드를 누르면 항목별 상세 채점 근거가 펼쳐집니다." icon={<Sparkles className="h-5 w-5" />}><div className="grid gap-5 md:grid-cols-[auto_1fr]"><div className="rounded-[var(--radius-md)] bg-[var(--color-primary)] px-7 py-5 text-center text-white self-start"><div className="text-xs text-white/70">총점</div><div className="tnum mt-1 text-5xl font-bold">{result.totalScore}</div><div className="mt-1 text-sm">{result.overallGradeLabel}</div></div>
      <div className="space-y-3">
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
      <div className="flex justify-center">
        <Button variant="accent" size="lg" onClick={() => { setPhase('ready'); setSelectedPart(''); setSelectedCategory(''); setCaseId(''); setResult(null); setTranscript([]); setFindings([]); setSessionId(''); setPersona(null); setStatus('증례를 선택하고 진료를 시작하세요.'); setError(''); }}>
          <RotateCcw className="h-4 w-4" /> 다른 증례로 다시 연습
        </Button>
      </div>
    )}
    </>)}
  </div>;
}
