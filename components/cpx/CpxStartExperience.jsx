'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  BarChart3,
  ChevronRight,
  Clock3,
  Mic,
  MicOff,
  Search,
  Shuffle,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';

// 시안의 '다시 연습' 아이콘은 다트가 꽂힌 과녁 — lucide에 없는 형태라 인라인 SVG로 재현.
function TargetArrowIcon(props) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M12 7a5 5 0 1 0 5 5" />
      <path d="M13 3.055a9 9 0 1 0 7.941 7.945" />
      <path d="M15 6v3h3l3-3h-3V3z" />
      <path d="M15 9l-3 3" />
    </svg>
  );
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function sectionRatio(section) {
  const score = Number(section?.score);
  const weight = Number(section?.weightPercent);
  return Number.isFinite(score) && Number.isFinite(weight) && weight > 0 ? score / weight : 1;
}

function sectionScore(section) {
  const ratio = sectionRatio(section);
  return Number.isFinite(ratio) ? Math.round(Math.max(0, Math.min(ratio, 1)) * 100) : null;
}

function caseSubtitle(item) {
  const title = String(item?.title || '').trim();
  const category = String(item?.category || '').trim();
  const parenthetical = title.match(/\(([^()]+)\)\s*$/);
  if (parenthetical) return parenthetical[1];
  if (title && title !== category) return title;
  return item?.variant || title;
}

function buildRecommendation(sessions, cases) {
  if (!Array.isArray(sessions) || !sessions.length || !cases.length) return null;
  const caseMap = new Map(cases.map((item) => [item.id, item]));
  const usable = sessions.filter((session) => caseMap.has(session.caseId));
  if (!usable.length) return null;

  const weaknessCounts = new Map();
  for (const session of usable) {
    const id = session.weakestSection?.id;
    if (id) weaknessCounts.set(id, (weaknessCounts.get(id) || 0) + 1);
  }
  const repeated = [...weaknessCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const repeatedId = repeated?.[1] >= 2 ? repeated[0] : null;
  const candidates = repeatedId
    ? usable.filter((session) => session.weakestSection?.id === repeatedId)
    : usable;
  const selectedSession = [...candidates].sort((a, b) => {
    const sectionGap = sectionRatio(a.weakestSection) - sectionRatio(b.weakestSection);
    if (sectionGap !== 0) return sectionGap;
    return Number(a.totalScore ?? 101) - Number(b.totalScore ?? 101);
  })[0];
  const target = caseMap.get(selectedSession.caseId);
  if (!target) return null;

  const weakest = selectedSession.weakestSection;
  return {
    target,
    weakest,
    weakestScore: weakest?.name ? sectionScore(weakest) : null,
    totalScore: Number.isFinite(Number(selectedSession.totalScore))
      ? Math.round(Number(selectedSession.totalScore))
      : null,
  };
}

function pickRandomCase(cases) {
  if (!cases.length) return null;
  if (globalThis.crypto?.getRandomValues) {
    const value = new Uint32Array(1);
    globalThis.crypto.getRandomValues(value);
    return cases[value[0] % cases.length];
  }
  return cases[Math.floor(Math.random() * cases.length)];
}

export default function CpxStartExperience({
  caseCatalog,
  rawPartGroups,
  historySessions,
  historyLoading,
  historyError,
  onRetryHistory,
  timeOptions,
  limitSeconds,
  onLimitChange,
  voiceOn,
  onVoiceChange,
  onStart,
}) {
  const cases = caseCatalog.cases || [];
  const categories = caseCatalog.categories || [];
  const recommendation = useMemo(
    () => buildRecommendation(historySessions, cases),
    [historySessions, cases],
  );
  const displayParts = useMemo(() => {
    const coreIds = new Set(['history', 'exam', 'psych']);
    const core = rawPartGroups.filter((group) => coreIds.has(group.id));
    const coreCats = new Set(core.flatMap((group) => group.cats));
    const otherCats = categories.filter((category) => !coreCats.has(category));
    return [
      { id: 'all', label: '전체', Icon: null, cats: categories },
      ...core,
      { id: 'other', label: '기타', Icon: BarChart3, cats: otherCats },
    ].filter((group) => group.cats.length);
  }, [categories, rawPartGroups]);
  const [selectedPart, setSelectedPart] = useState('all');
  const activePart = displayParts.find((part) => part.id === selectedPart) || displayParts[0];
  const [selectedCategory, setSelectedCategory] = useState('');
  const [query, setQuery] = useState('');
  const [setup, setSetup] = useState(null);
  const directRef = useRef(null);
  const startButtonRef = useRef(null);
  const previousFocusRef = useRef(null);

  const casesByCategory = useMemo(() => {
    const grouped = {};
    for (const item of cases) {
      if (!item?.category) continue;
      (grouped[item.category] ||= []).push(item);
    }
    return grouped;
  }, [cases]);

  useEffect(() => {
    const partCategories = activePart?.cats || [];
    if (!partCategories.includes(selectedCategory)) setSelectedCategory(partCategories[0] || '');
  }, [activePart, selectedCategory]);

  useEffect(() => {
    if (!setup) return undefined;
    previousFocusRef.current = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => startButtonRef.current?.focus());
    const onKeyDown = (event) => {
      if (event.key === 'Escape') setSetup(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      // preventScroll: 진료 시작이 안내 미확인으로 막히면 페이지가 안내 배너로 스크롤되는데,
      // 포커스 복원의 기본 스크롤이 그 이동을 다시 위로 끌어올리지 않도록 막는다.
      previousFocusRef.current?.focus?.({ preventScroll: true });
    };
  }, [setup]);

  const q = normalize(query);
  const activeCategories = activePart?.cats || [];
  const visibleCategories = q
    ? activeCategories.filter((category) => {
      if (normalize(category).includes(q)) return true;
      return (casesByCategory[category] || []).some((item) =>
        normalize(`${item.title}${item.description || ''}${item.variant || ''}${item.tags || ''}`).includes(q));
    })
    : activeCategories;
  const visibleCases = q
    ? cases.filter((item) => activeCategories.includes(item.category)
      && normalize(`${item.category}${item.title}${item.description || ''}${item.variant || ''}${item.tags || ''}`).includes(q))
    : (casesByCategory[selectedCategory] || []);

  const openSetup = (target, mode) => {
    if (!target) return;
    setSetup({ target, mode });
  };
  const scrollToDirect = () => directRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const openRandomSetup = () => openSetup(pickRandomCase(cases), 'random');
  const confirmStart = () => {
    const pending = setup;
    if (!pending) return;
    setSetup(null);
    onStart(pending.target, { mode: pending.mode });
  };

  return <div className="cpx-start-experience">
    <header className="cpx-start-header">
      <div>
        <span className="cpx-start-eyebrow">CPX 실기 연습</span>
        <h1><span className="cpx-headline-accent">의사-환자 모의대화</span>를 통해 CPX를 대비해보세요</h1>
        <p>복습이 필요한 증례부터 랜덤 실전까지 원하는 방식으로 연습할 수 있어요.</p>
      </div>
      <Link href="/cpx/history" className="cpx-record-link">나의 CPX 기록 <ArrowRight aria-hidden /></Link>
    </header>

    <section className="cpx-quick-section" aria-labelledby="cpx-quick-title">
      <div className="cpx-section-heading">
        <h2 id="cpx-quick-title">빠른 시작</h2>
      </div>
      <div className="cpx-quick-grid">
        <article className="cpx-review-panel">
          <div className="cpx-quick-label">
            <span className="cpx-quick-icon"><TargetArrowIcon aria-hidden /></span>
            <div>
              <strong>부족했던 증례 다시 연습</strong>
              {recommendation && !historyLoading && !historyError
                && <span>지난 연습에서 가장 낮았던 영역이에요</span>}
            </div>
          </div>
          {historyLoading ? <div className="cpx-recommendation-loading" aria-live="polite">
            <span className="cpx-loading-bar" /><span className="cpx-loading-bar is-short" />
            <span className="sr-only">CPX 기록을 분석하고 있습니다.</span>
          </div> : historyError ? <div className="cpx-recommendation-empty">
            <h3>기록을 불러오지 못했어요</h3>
            <p>추천을 만들려면 나의 CPX 기록을 다시 불러와야 해요.</p>
            <button type="button" onClick={onRetryHistory}>다시 불러오기</button>
          </div> : recommendation ? <>
            <div className="cpx-recommendation-case">
              <h3>{recommendation.target.category}</h3>
              <p>
                {caseSubtitle(recommendation.target)}
                {recommendation.weakest?.name && recommendation.weakestScore !== null
                  ? <> · {recommendation.weakest.name} 점수 {recommendation.weakestScore}점</>
                  : recommendation.totalScore !== null && <> · 총점 {recommendation.totalScore}점</>}
              </p>
            </div>
            <button type="button" className="cpx-quick-cta" onClick={() => openSetup(recommendation.target, 'recommendation')}>
              다시 연습하기 <ArrowRight aria-hidden />
            </button>
          </> : <div className="cpx-recommendation-empty">
            <h3>아직 분석할 연습 기록이 없어요</h3>
            <p>첫 CPX를 완료하면 실제 점수를 바탕으로 보완할 증례를 추천해 드려요.</p>
            <button type="button" onClick={scrollToDirect}>아래에서 첫 증례 고르기</button>
          </div>}
        </article>

        <article className="cpx-random-panel">
          <div className="cpx-quick-label">
            <span className="cpx-quick-icon"><Shuffle aria-hidden /></span>
            <div><strong>랜덤 실전</strong></div>
          </div>
          <div className="cpx-random-copy">
            <h3>증례 정보 없이 바로 시작</h3>
            <p>시험처럼 증례를 무작위로 진행해요</p>
          </div>
          <button type="button" className="cpx-quick-cta" onClick={openRandomSetup} disabled={!cases.length}>
            시작하기 <ArrowRight aria-hidden />
          </button>
        </article>
      </div>
    </section>

    <section ref={directRef} className="cpx-direct-section" aria-labelledby="cpx-direct-title">
      <div className="cpx-direct-heading">
        <div className="cpx-section-heading">
          <h2 id="cpx-direct-title">증례 직접 선택</h2>
          <p>파트별 증상 및 주호소와 시나리오를 차례로 선택해봐요.</p>
        </div>
        <label className="cpx-direct-search">
          <Search aria-hidden />
          <span className="sr-only">주호소 또는 시나리오 검색</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="주호소·시나리오 검색" />
          {query && <button type="button" onClick={() => setQuery('')} aria-label="검색어 지우기"><X aria-hidden /></button>}
        </label>
      </div>

      <div className="cpx-part-tabs" aria-label="CPX 파트 선택">
        {displayParts.map((part) => <button
          key={part.id}
          type="button"
          aria-pressed={part.id === activePart?.id}
          onClick={() => { setSelectedPart(part.id); setQuery(''); }}
        >
          {part.Icon && <part.Icon aria-hidden />}{part.label}
        </button>)}
      </div>

      <div className="cpx-browser-grid">
        <aside className="cpx-complaint-browser" aria-label="주호소 목록">
          <div className="cpx-browser-title"><span>주호소</span><b>{visibleCategories.length}</b></div>
          <label className="cpx-mobile-complaint-select">
            <span>주호소 선택</span>
            <select value={selectedCategory} onChange={(event) => setSelectedCategory(event.target.value)}>
              {activeCategories.map((category) => <option key={category} value={category}>{category} ({(casesByCategory[category] || []).length})</option>)}
            </select>
          </label>
          <div className="cpx-complaint-list">
            {visibleCategories.map((category) => <button
              key={category}
              type="button"
              className={category === selectedCategory && !q ? 'is-active' : ''}
              aria-pressed={category === selectedCategory && !q}
              onClick={() => { setSelectedCategory(category); setQuery(''); }}
            >
              <span>{category}</span><b>{(casesByCategory[category] || []).length}</b><ChevronRight aria-hidden />
            </button>)}
            {!visibleCategories.length && <p className="cpx-list-empty">검색 결과가 없습니다.</p>}
          </div>
        </aside>

        <div className="cpx-scenario-browser">
          <div className="cpx-browser-title">
            <span>{q ? '검색된 시나리오' : `${selectedCategory || '선택한 주호소'} 시나리오`}</span>
            <b>{visibleCases.length}</b>
          </div>
          <div className="cpx-scenario-list">
            {visibleCases.map((item) => <button key={item.id} type="button" className="cpx-scenario-row" onClick={() => openSetup(item, 'direct')}>
              <span className="cpx-scenario-copy">
                {q && <span className="cpx-scenario-category">{item.category}</span>}
                <span className="cpx-scenario-name">{item.title}</span>
                <span className="cpx-scenario-description">{item.description || item.variant || '표준화 환자와 CPX 진료 세션을 진행합니다.'}</span>
              </span>
              <span className="cpx-scenario-action">연습하기 <ArrowRight aria-hidden /></span>
            </button>)}
            {!visibleCases.length && <div className="cpx-list-empty">조건에 맞는 시나리오가 없습니다.</div>}
          </div>
        </div>
      </div>
    </section>

    {setup && <div className="cpx-setup-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSetup(null); }}>
      <section className="cpx-setup-dialog" role="dialog" aria-modal="true" aria-labelledby="cpx-setup-title">
        <button type="button" className="cpx-dialog-close" onClick={() => setSetup(null)} aria-label="연습 설정 닫기"><X aria-hidden /></button>
        <div className="cpx-dialog-heading">
          <h2 id="cpx-setup-title">연습 설정</h2>
          {setup.mode === 'random'
            ? <p>무작위 증례는 진료가 시작될 때 공개됩니다.</p>
            : <p><strong>{setup.target.category}</strong> · {setup.target.title}</p>}
        </div>
        <div className="cpx-setting-group">
          <div className="cpx-setting-label"><Clock3 aria-hidden /><div><strong>진료 시간</strong></div></div>
          <div className="cpx-time-options" role="radiogroup" aria-label="진료 시간">
            {timeOptions.map((option) => <div key={option.seconds} className="cpx-time-option">
              <button
                type="button"
                role="radio"
                aria-checked={limitSeconds === option.seconds}
                aria-describedby={option.seconds === 720 ? 'cpx-time-real' : undefined}
                onClick={() => onLimitChange(option.seconds)}
              >{option.label}</button>
              {option.seconds === 720 && <span id="cpx-time-real" className="cpx-time-tag">실전</span>}
            </div>)}
          </div>
        </div>
        <button type="button" role="switch" aria-checked={voiceOn} aria-describedby="cpx-voice-description" className="cpx-setting-group cpx-voice-setting" onClick={() => onVoiceChange(!voiceOn)}>
          <span className="cpx-setting-label">{voiceOn ? <Mic aria-hidden /> : <MicOff aria-hidden />}<span className="cpx-setting-copy"><strong>음성 문진</strong><span id="cpx-voice-description">{voiceOn ? '음성으로 환자와 문진할 수 있어요.' : '끄면 텍스트로만 진료할 수 있어요.'}</span></span></span>
          <span className={`cpx-voice-switch ${voiceOn ? 'is-on' : ''}`} aria-hidden><i /></span>
        </button>
        <div className="cpx-dialog-summary">
          <span>{timeOptions.find((option) => option.seconds === limitSeconds)?.label}</span>
          <span>음성 문진 {voiceOn ? 'ON' : 'OFF'}</span>
          {setup.mode === 'random' && <span>증례 비공개</span>}
        </div>
        {/* 순응도 낮은 환자는 상시 무작위 배정(직접 선택 25% · 랜덤 실전 40%) — 사용자 설정 불가, 유형은 채점 후 공개 */}
        <p className="mt-2 text-xs text-[var(--color-muted)]">실제 시험처럼 순응도가 낮은 환자를 무작위로 만날 수 있어요. 어떤 유형이었는지는 채점 후에 알려드려요.</p>
        <Button ref={startButtonRef} type="button" size="lg" fullWidth onClick={confirmStart}>
          진료 시작 <ArrowRight aria-hidden />
        </Button>
      </section>
    </div>}
  </div>;
}
