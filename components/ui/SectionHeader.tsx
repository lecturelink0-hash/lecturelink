import { type ReactNode } from 'react';
import clsx from 'clsx';

interface SectionHeaderProps {
  title: string;
  /** 제목 위 필 라벨 (랜딩 톤) */
  eyebrow?: string;
  action?: ReactNode;
  /** 랜딩 피처 섹션처럼 중앙 정렬 */
  center?: boolean;
  className?: string;
}

/** 페이지 내 섹션 헤더 — 좌측 소형 볼드 제목 (절제된 앱 시안 톤) */
export function SectionHeader({ title, eyebrow, action, className }: SectionHeaderProps) {
  // center prop 은 호환을 위해 인터페이스에만 유지(시안은 좌측 정렬 소형 헤딩).
  return (
    <div className={clsx('mb-5 flex items-end justify-between gap-3', className)}>
      <div className="min-w-0">
        {eyebrow && <span className="ll-eyebrow mb-2 block">{eyebrow}</span>}
        <h2 className="text-[1.05rem] font-bold text-sage-800 tracking-tight">{title}</h2>
      </div>
      {action && <div className="flex-shrink-0">{action}</div>}
    </div>
  );
}
