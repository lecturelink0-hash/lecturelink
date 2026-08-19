'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowRight,
  ChevronRight,
  Clock3,
  Info,
  Mic,
  MicOff,
  Search,
  Shuffle,
  X,
} from 'lucide-react';

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
  // 시나리오 작성 기준 파트를 그대로 노출한다. 한때 병력청취·진찰·정신행동 3개만 남기고 나머지를
  // '기타'로 합쳐뒀는데, 상담·의사소통 / 여성·산과 / 소아·특수 상황이 통째로 '기타'에 묻혀
  // 원래 분류를 아는 사용자가 증례를 찾지 못했다. rawPartGroups(=실제 데이터가 있는 파트)를 그대로 쓴다.
  const displayParts = useMemo(() => [
    { id: 'all', label: '전체', Icon: null, cats: categories },
    ...rawPartGroups,
  ].filter((group) => group.cats.length), [categories, rawPartGroups]);
  const [selectedPart, setSelectedPart] = useState('all');
  const activePart = displayParts.find((part) => part.id === selectedPart) || displayParts[0];
  const [selectedCategory, setSelectedCategory] = useState('');
  const [query, setQuery] = useState('');
  const directRef = useRef(null);

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

  // 진료 시간·음성 문진은 헤더에서 상시 조절하므로 시작 전에 따로 물을 것이 없다 —
  // 카드/행을 누르면 바로 진료가 시작된다(연습 설정 모달 제거).
  const startCase = (target, mode) => {
    if (!target) return;
    onStart(target, { mode });
  };
  const scrollToDirect = () => directRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const startRandom = () => startCase(pickRandomCase(cases), 'random');
  const handleCardKeyDown = (event, action) => {
    if (event.target !== event.currentTarget || event.key === 'Escape') return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      action();
    }
  };

  return <div className="cpx-start-experience">
    <header className="cpx-start-header">
      <div className="cpx-start-copy">
        <span className="cpx-start-eyebrow">CPX 실기 연습</span>
        {/* 내신 대비(/notes)·내 문제집(/library) 제목과 같은 2줄 구성 — 뒷문장을 블록 span 으로 내린다.
            좁은 폭에서는 이 강제 줄바꿈이 오히려 "통해"만 남는 짧은 줄을 만들어 CSS 에서 inline 으로 되돌린다.
            <br/> 을 display:none 으로 지우면 "통해CPX를" 처럼 공백 없이 붙으므로 span + 공백 조합을 쓴다. */}
        <h1>
          <span className="cpx-headline-accent">의사-환자 모의대화</span>를 통해{' '}
          <span className="cpx-h1-tail">CPX를 대비해보세요</span>
        </h1>
        <p>복습이 필요한 증례부터 랜덤 실전까지 원하는 방식으로 연습할 수 있어요.</p>
      </div>
      <div className="cpx-start-controls">
        <div
          className="cpx-time-seg"
          role="radiogroup"
          aria-label="진료 시간"
          title="실전(12분)보다 짧게 설정해 시간 압박에 대비할 수 있어요"
        >
          <Clock3 aria-hidden />
          {timeOptions.map((option) => <button
            key={option.seconds}
            type="button"
            role="radio"
            aria-checked={limitSeconds === option.seconds}
            onClick={() => onLimitChange(option.seconds)}
          >{option.label}</button>)}
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={voiceOn}
          className={`cpx-voice-btn ${voiceOn ? 'is-on' : ''}`}
          title="시끄러운 곳에서는 음성을 끄고 텍스트로만 진료할 수 있어요"
          onClick={() => onVoiceChange(!voiceOn)}
        >{voiceOn ? <Mic aria-hidden /> : <MicOff aria-hidden />}음성 {voiceOn ? 'ON' : 'OFF'}</button>
        <Link href="/cpx/history" className="cpx-record-link">나의 CPX 기록 <ArrowRight aria-hidden /></Link>
      </div>
    </header>

    <section className="cpx-quick-section" aria-labelledby="cpx-quick-title">
      <div className="cpx-section-heading">
        <h2 id="cpx-quick-title"><span className="cpx-sec-num" aria-hidden>1</span>빠른 시작</h2>
      </div>
      <div className="cpx-quick-grid">
        <article
          className="cpx-review-panel"
          role={recommendation ? 'button' : undefined}
          tabIndex={recommendation ? 0 : undefined}
          onClick={recommendation ? () => startCase(recommendation.target, 'recommendation') : undefined}
          onKeyDown={recommendation ? (event) => handleCardKeyDown(event, () => startCase(recommendation.target, 'recommendation')) : undefined}
        >
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
            <button type="button" className="cpx-quick-cta" onClick={(event) => { event.stopPropagation(); startCase(recommendation.target, 'recommendation'); }}>
              다시 연습하기 <ArrowRight aria-hidden />
            </button>
          </> : <div className="cpx-recommendation-empty">
            <h3>아직 분석할 연습 기록이 없어요</h3>
            <p>첫 CPX를 완료하면 실제 점수를 바탕으로 보완할 증례를 추천해 드려요.</p>
            <button type="button" onClick={scrollToDirect}>아래에서 첫 증례 고르기</button>
          </div>}
        </article>

        <article
          className="cpx-random-panel"
          role={cases.length ? 'button' : undefined}
          tabIndex={cases.length ? 0 : undefined}
          onClick={cases.length ? startRandom : undefined}
          onKeyDown={cases.length ? (event) => handleCardKeyDown(event, startRandom) : undefined}
        >
          <div className="cpx-quick-label">
            <span className="cpx-quick-icon"><Shuffle aria-hidden /></span>
            {/* 좌측 카드에만 보조 설명이 있으면 두 카드가 비대칭으로 읽혀, 같은 위치에 한 줄을 둔다. */}
            <div><strong>랜덤 실전</strong><span>시험처럼 증례를 모른 채 진행해요</span></div>
          </div>
          <div className="cpx-random-copy">
            <h3>증례 정보 없이 바로 시작</h3>
            <p>어떤 증례가 나올지는 진료 시작 후에 공개돼요</p>
          </div>
          <button type="button" className="cpx-quick-cta" onClick={(event) => { event.stopPropagation(); startRandom(); }} disabled={!cases.length}>
            시작하기 <ArrowRight aria-hidden />
          </button>
        </article>
      </div>
      {/* 연습 설정 모달에 있던 순응도 안내 — 모달을 없앴으므로 빠른 시작 바로 아래에 남긴다. */}
      <p className="cpx-quick-note"><Info aria-hidden /><span>실제 시험처럼 순응도가 낮은 환자를 무작위로 만날 수 있어요. 어떤 유형이었는지는 채점 후에 알려드려요.</span></p>
    </section>

    <section ref={directRef} className="cpx-direct-section" aria-labelledby="cpx-direct-title">
      <div className="cpx-direct-heading">
        <div className="cpx-section-heading">
          <h2 id="cpx-direct-title"><span className="cpx-sec-num" aria-hidden>2</span>증례 직접 선택</h2>
          <p>파트별 증상 및 주호소와 시나리오를 차례로 선택해보세요.</p>
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
            {visibleCases.map((item) => <button key={item.id} type="button" className="cpx-scenario-row" onClick={() => startCase(item, 'direct')}>
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

  </div>;
}
