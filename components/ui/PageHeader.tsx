import { type ReactNode } from 'react';
import clsx from 'clsx';

interface PageHeaderProps {
  title: string;
  description?: string;
  eyebrow?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** 페이지 상단 헤더 — eyebrow 라벨 + 큰 제목 + 설명 + 우측 액션 (전 페이지 통일) */
export function PageHeader({ title, description, eyebrow, action, className }: PageHeaderProps) {
  return (
    <div className={clsx('page-head ll-page-header flex flex-col sm:flex-row sm:items-end justify-between gap-4 mb-8 md:mb-10', className)}>
      <div className="min-w-0 max-w-2xl">
        {eyebrow && <span className="ll-eyebrow mb-2">{eyebrow}</span>}
        <h1 className="text-[clamp(1.9rem,4vw,2.55rem)] leading-[1.12] font-bold text-[var(--color-text)] tracking-[-0.035em]">
          {title}
        </h1>
        {description && (
          <p className="mt-2.5 text-[15px] text-[var(--color-muted)] leading-relaxed">
            {description}
          </p>
        )}
      </div>
      {action && <div className="flex-shrink-0 w-full sm:w-auto">{action}</div>}
    </div>
  );
}
