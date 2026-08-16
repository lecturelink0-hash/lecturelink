'use client';

import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

const DEFAULT_PAGE_SIZE = 6;

// 세부 채점 항목은 한 영역에 20개 넘게 쌓인다. 모바일에서 전부 펼치면
// 한 영역을 지나가는 데만 화면 여러 장을 스크롤해야 해 끝까지 내리기 어렵다.
// 기본 6개씩 끊어 보여주고 ‹ › 로 넘긴다(10개는 근거 인용구까지 붙으면 여전히
// 한 화면을 넘겼다). 한 쪽에 다 들어가면 컨트롤을 그리지 않는다.
// unitLabel 은 카운터 접미사 전용('21개 항목') — aria 문구에 그대로 끼우면
// '다음 개 항목' 처럼 읽히므로 버튼 라벨은 고정 문구를 쓴다.
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
  const go = (next) => { pagedRef.current = true; setPage(next); };

  return (
    <div ref={anchorRef}>
      {children(slice)}
      {pageCount > 1 && (
        <div className="mt-3 flex items-center justify-between gap-2 border-t border-[var(--color-border)] pt-3">
          <button
            type="button"
            onClick={() => go(current - 1)}
            disabled={current === 0}
            aria-label="이전 항목"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white text-[var(--color-text)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="tnum text-xs font-semibold text-[var(--color-muted)]">
            {start + 1}–{start + slice.length} / {total}{unitLabel}
            <span className="ml-1 text-[var(--color-border)]">·</span>
            <span className="ml-1">{current + 1}/{pageCount}쪽</span>
          </span>
          <button
            type="button"
            onClick={() => go(current + 1)}
            disabled={current >= pageCount - 1}
            aria-label="다음 항목"
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-md)] border border-[var(--color-border)] bg-white text-[var(--color-text)] transition hover:border-[var(--color-primary)] hover:text-[var(--color-primary)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}
