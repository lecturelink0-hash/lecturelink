'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

const DEFAULT_PAGE_SIZE = 6;

/** 한 번에 보여줄 쪽 번호 개수. 이보다 쪽이 많으면 현재 쪽 주변만 잘라 보여주고 처음·끝 버튼을 붙인다. */
const WINDOW = 5;

// 세부 채점 항목은 한 영역에 20개 넘게 쌓인다. 모바일에서 전부 펼치면
// 한 영역을 지나가는 데만 화면 여러 장을 스크롤해야 해 끝까지 내리기 어렵다.
// 기본 6개씩 끊어 보여주고 아래 페이저로 넘긴다. 한 쪽에 다 들어가면 컨트롤을 그리지 않는다.
//
// 페이저는 쪽 번호를 직접 누르는 방식이다. 이전에는 "5–8 / 8개 오답 · 2/2쪽" 처럼
// 숫자를 세 번 말하면서도 원하는 쪽으로 한 번에 갈 수는 없었다.
// 쪽이 WINDOW 보다 많으면 « (첫 쪽) ‹ (이전) [번호…] › (다음) » (마지막 쪽) 이 붙고,
// 적으면 ‹ [1][2] › 처럼 번호를 전부 펼친다. 갈 수 없는 방향의 버튼은 disabled.
export default function CpxPagedList({ items, children, pageSize = DEFAULT_PAGE_SIZE, unitLabel = '항목' }) {
  const list = Array.isArray(items) ? items : [];
  const total = list.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const [page, setPage] = useState(0);
  const anchorRef = useRef(null);
  const pagedRef = useRef(false); // 최초 렌더에서는 스크롤을 건드리지 않는다

  // 항목 수가 줄어 현재 쪽이 사라지면(다른 세션 결과 로드 등) 마지막 쪽으로 당긴다.
  useEffect(() => { setPage((current) => Math.min(current, pageCount - 1)); }, [pageCount]);

  // 쪽을 넘기면 바뀐 목록의 첫 줄이 보이도록 올려준다 — 페이저는 목록 아래에 있어
  // 그대로 두면 새 쪽의 시작이 화면 위로 벗어난 채 남는다.
  useEffect(() => {
    if (!pagedRef.current) return;
    const node = anchorRef.current;
    if (!node || typeof window === 'undefined') return;
    const top = node.getBoundingClientRect().top + window.scrollY - 96; // 상단 셸 높이 여유
    if (node.getBoundingClientRect().top < 96) window.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [page]);

  const current = Math.min(page, pageCount - 1);
  const start = current * pageSize;
  const slice = list.slice(start, start + pageSize);
  const go = (next) => {
    const clamped = Math.max(0, Math.min(next, pageCount - 1));
    if (clamped === current) return;
    pagedRef.current = true;
    setPage(clamped);
  };

  // 현재 쪽을 가운데 두되 양 끝에서는 창을 안쪽으로 붙여 항상 WINDOW 개가 보이게 한다.
  const windowPages = useMemo(() => {
    const size = Math.min(WINDOW, pageCount);
    let from = Math.max(0, current - Math.floor(size / 2));
    from = Math.min(from, pageCount - size);
    return Array.from({ length: size }, (_, i) => from + i);
  }, [current, pageCount]);

  const showEdges = pageCount > WINDOW;
  const atFirst = current === 0;
  const atLast = current === pageCount - 1;

  return (
    <div ref={anchorRef}>
      {children(slice)}
      {pageCount > 1 && (
        <nav className="ll-pager" aria-label={`${total}${unitLabel} 쪽 이동`}>
          {showEdges && (
            <button type="button" className="ll-pager-step" onClick={() => go(0)} disabled={atFirst} aria-label="첫 쪽">
              <ChevronsLeft className="h-4 w-4" />
            </button>
          )}
          <button type="button" className="ll-pager-step" onClick={() => go(current - 1)} disabled={atFirst} aria-label="이전 쪽">
            <ChevronLeft className="h-4 w-4" />
          </button>

          <ol className="ll-pager-pages">
            {windowPages.map((p) => (
              <li key={p}>
                <button
                  type="button"
                  className={`ll-pager-page${p === current ? ' is-current' : ''}`}
                  onClick={() => go(p)}
                  aria-label={`${p + 1}쪽`}
                  aria-current={p === current ? 'page' : undefined}
                >
                  {p + 1}
                </button>
              </li>
            ))}
          </ol>

          <button type="button" className="ll-pager-step" onClick={() => go(current + 1)} disabled={atLast} aria-label="다음 쪽">
            <ChevronRight className="h-4 w-4" />
          </button>
          {showEdges && (
            <button type="button" className="ll-pager-step" onClick={() => go(pageCount - 1)} disabled={atLast} aria-label="마지막 쪽">
              <ChevronsRight className="h-4 w-4" />
            </button>
          )}
        </nav>
      )}
    </div>
  );
}
