'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { shiftDateKey } from '@/lib/utils/kst';

export interface StudyCalendarDayInfo {
  count: number;
  hasExam: boolean;
}

interface StudyCalendarProps {
  viewYear: number;
  viewMonth: number; // 1~12
  selectedDate: string; // 'YYYY-MM-DD'
  todayKey: string; // KST 기준 오늘
  getDay: (dateKey: string) => StudyCalendarDayInfo;
  onSelectDate: (dateKey: string) => void;
  onPrevMonth: () => void;
  onNextMonth: () => void;
  /** "오늘" 버튼 — 오늘이 속한 달로 이동 + 오늘 선택 */
  onGoToday?: () => void;
}

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

function toDateKey(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(y, m, 0).getDate();
}

function firstDayOfWeek(y: number, m: number): number {
  return new Date(y, m - 1, 1).getDay();
}

function dayOfWeek(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

// 흰 글자는 4.5:1 을 넘는 sage-600(#2f6a4c) 이상 배경에서만 쓴다.
function countBgClass(count: number): string {
  if (count === 0) return '';
  if (count < 10) return 'bg-[var(--color-sage-200)]';
  if (count < 30) return 'bg-sage-600 text-white';
  return 'bg-sage-800 text-white';
}

/**
 * 학습 캘린더 — ARIA grid 패턴.
 * 로빙 탭인덱스(그리드 전체가 Tab 정지점 하나), 방향키 ±1일/±7일,
 * Home/End 주 시작·끝, PageUp/PageDown 월 이동. 선택은 Enter/Space/클릭.
 */
export function StudyCalendar({
  viewYear,
  viewMonth,
  selectedDate,
  todayKey,
  getDay,
  onSelectDate,
  onPrevMonth,
  onNextMonth,
  onGoToday,
}: StudyCalendarProps) {
  const [focusedDate, setFocusedDate] = useState(selectedDate);
  const pendingFocus = useRef(false);
  const cellRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // 키보드 이동으로 월이 바뀐 뒤, 새로 렌더된 셀에 포커스를 옮긴다.
  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    cellRefs.current[focusedDate]?.focus();
  });

  const monthPrefix = `${viewYear}-${String(viewMonth).padStart(2, '0')}-`;
  const inView = (key: string) => key.startsWith(monthPrefix);
  // 로빙 탭인덱스의 현재 정지점: 포커스했던 날 → 선택한 날 → 1일 순으로 폴백.
  const focusKey = inView(focusedDate)
    ? focusedDate
    : inView(selectedDate)
      ? selectedDate
      : toDateKey(viewYear, viewMonth, 1);

  function moveFocus(nextKey: string) {
    const nextYear = Number(nextKey.slice(0, 4));
    const nextMonth = Number(nextKey.slice(5, 7));
    if (nextYear !== viewYear || nextMonth !== viewMonth) {
      if (nextYear < viewYear || (nextYear === viewYear && nextMonth < viewMonth)) {
        onPrevMonth();
      } else {
        onNextMonth();
      }
    }
    pendingFocus.current = true;
    setFocusedDate(nextKey);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>, dateKey: string) {
    let next: string | null = null;
    switch (event.key) {
      case 'ArrowRight':
        next = shiftDateKey(dateKey, 1);
        break;
      case 'ArrowLeft':
        next = shiftDateKey(dateKey, -1);
        break;
      case 'ArrowDown':
        next = shiftDateKey(dateKey, 7);
        break;
      case 'ArrowUp':
        next = shiftDateKey(dateKey, -7);
        break;
      case 'Home':
        next = shiftDateKey(dateKey, -dayOfWeek(dateKey));
        break;
      case 'End':
        next = shiftDateKey(dateKey, 6 - dayOfWeek(dateKey));
        break;
      case 'PageUp': {
        const py = viewMonth === 1 ? viewYear - 1 : viewYear;
        const pm = viewMonth === 1 ? 12 : viewMonth - 1;
        next = toDateKey(py, pm, Math.min(Number(dateKey.slice(8, 10)), daysInMonth(py, pm)));
        break;
      }
      case 'PageDown': {
        const ny = viewMonth === 12 ? viewYear + 1 : viewYear;
        const nm = viewMonth === 12 ? 1 : viewMonth + 1;
        next = toDateKey(ny, nm, Math.min(Number(dateKey.slice(8, 10)), daysInMonth(ny, nm)));
        break;
      }
      default:
        return;
    }
    event.preventDefault();
    if (next) moveFocus(next);
  }

  // 그리드 셀 구성 (앞뒤 공백 포함 7일 단위 행)
  const totalDays = daysInMonth(viewYear, viewMonth);
  const startDow = firstDayOfWeek(viewYear, viewMonth);
  const cells: (number | null)[] = [
    ...Array<null>(startDow).fill(null),
    ...Array.from({ length: totalDays }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (number | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));

  return (
    <div>
      {/* Month navigation */}
      <div className="flex items-center justify-between mb-4">
        <button
          type="button"
          onClick={onPrevMonth}
          className="w-11 h-11 flex items-center justify-center rounded-lg hover:bg-[var(--color-sage-100)] text-sage-700 transition-colors"
          aria-label="이전 달"
        >
          <ChevronLeft size={18} />
        </button>
        <span className="text-[20px] font-bold text-sage-800" aria-live="polite">
          {viewYear}년 {viewMonth}월
        </span>
        <div className="flex items-center gap-1">
          {onGoToday && !todayKey.startsWith(monthPrefix) && (
            <button
              type="button"
              onClick={onGoToday}
              className="min-h-11 px-3 rounded-lg text-[16px] font-semibold text-sage-700 hover:bg-[var(--color-sage-100)] transition-colors"
            >
              오늘
            </button>
          )}
          <button
            type="button"
            onClick={onNextMonth}
            className="w-11 h-11 flex items-center justify-center rounded-lg hover:bg-[var(--color-sage-100)] text-sage-700 transition-colors"
            aria-label="다음 달"
          >
            <ChevronRight size={18} />
          </button>
        </div>
      </div>

      <div role="grid" aria-label={`${viewYear}년 ${viewMonth}월 학습 캘린더`}>
        {/* Day-of-week header — 일요일은 관례대로 warn 톤으로 은은하게 구분 */}
        <div role="row" className="grid grid-cols-7 mb-1">
          {DOW_LABELS.map((dow, dowIndex) => (
            <div
              key={dow}
              role="columnheader"
              className={`text-center text-[14px] font-semibold py-1 ${
                dowIndex === 0 ? 'text-[var(--color-warn)] opacity-70' : 'text-[var(--color-muted)]'
              }`}
            >
              {dow}
            </div>
          ))}
        </div>

        {/* Date cells */}
        <div className="space-y-0.5">
          {weeks.map((week, weekIndex) => (
            <div key={weekIndex} role="row" className="grid grid-cols-7 gap-0.5">
              {week.map((day, dayIndex) => {
                if (day === null) {
                  return (
                    <div
                      key={`empty-${weekIndex}-${dayIndex}`}
                      role="gridcell"
                      className="aspect-square min-h-11"
                    />
                  );
                }

                const dateKey = toDateKey(viewYear, viewMonth, day);
                const { count, hasExam } = getDay(dateKey);
                const isToday = dateKey === todayKey;
                const isSelected = dateKey === selectedDate;
                const bgClass = countBgClass(count);
                const label = [
                  `${viewYear}년 ${viewMonth}월 ${day}일`,
                  count > 0 ? `${count}문항 학습` : null,
                  hasExam ? '시험 일정 있음' : null,
                ]
                  .filter(Boolean)
                  .join(', ');

                return (
                  <button
                    key={dateKey}
                    type="button"
                    role="gridcell"
                    ref={(el) => {
                      cellRefs.current[dateKey] = el;
                    }}
                    tabIndex={dateKey === focusKey ? 0 : -1}
                    onClick={() => onSelectDate(dateKey)}
                    onKeyDown={(event) => handleKeyDown(event, dateKey)}
                    onFocus={() => setFocusedDate(dateKey)}
                    aria-selected={isSelected}
                    aria-current={isToday ? 'date' : undefined}
                    aria-label={label}
                    className={[
                      'relative aspect-square min-h-11 rounded-lg flex flex-col items-center justify-center transition-all text-[15px] font-medium',
                      bgClass,
                      !bgClass && 'hover:bg-[var(--color-sage-100)]',
                      isSelected && 'ring-2 ring-sage-900',
                      isToday && !isSelected && 'ring-2 ring-sage-400',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                  >
                    <span className={count >= 10 ? 'text-white' : 'text-sage-800'}>{day}</span>
                    {count > 0 && (
                      <span
                        className={`text-[13px] leading-none mt-0.5 ${
                          count >= 10 ? 'text-white/80' : 'text-sage-600'
                        }`}
                      >
                        {count}
                      </span>
                    )}
                    {hasExam && (
                      <span
                        className={`absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-[var(--color-warn)] ${
                          count >= 10 ? 'ring-1 ring-white/80' : ''
                        }`}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      {/* Legend — 스와치는 실제 셀과 같은 색을 쓴다 (빈 셀 = 카드 흰 배경) */}
      <div className="flex items-center gap-4 mt-4 pt-3 border-t border-[var(--color-border)]">
        <span className="text-[14px] text-[var(--color-muted)]">학습량:</span>
        <div className="flex items-center gap-2">
          {[
            { label: '없음', cls: 'bg-white border border-[var(--color-border)]' },
            { label: '1~9', cls: 'bg-[var(--color-sage-200)]' },
            { label: '10~29', cls: 'bg-sage-600' },
            { label: '30+', cls: 'bg-sage-800' },
          ].map((item) => (
            <div key={item.label} className="flex items-center gap-1">
              <span className={`w-3 h-3 rounded-sm inline-block ${item.cls}`} />
              <span className="text-[14px] text-[var(--color-muted)]">{item.label}</span>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-1 ml-2">
          <span className="w-2 h-2 rounded-full bg-[var(--color-warn)] inline-block" />
          <span className="text-[14px] text-[var(--color-muted)]">시험 일정</span>
        </div>
      </div>
    </div>
  );
}
