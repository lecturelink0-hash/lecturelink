import { type HTMLAttributes, type ReactNode } from 'react';
import clsx from 'clsx';

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  title?: string;
  description?: string;
  action?: ReactNode;
  /** 헤더 좌측 아이콘 칩 (랜딩 시그니처) */
  icon?: ReactNode;
  /** 제목 위 작은 라벨 필 */
  eyebrow?: string;
  /** hover 시 살짝 떠오르는 리프트 (클릭 가능한 카드에) */
  hover?: boolean;
  /** 아이콘 칩 색조 */
  tone?: 'sage' | 'accent' | 'gold';
}

export function Card({
  title,
  description,
  action,
  icon,
  eyebrow,
  hover,
  tone = 'sage',
  className,
  children,
  ...rest
}: CardProps) {
  const chipTone =
    tone === 'accent' ? 'll-chip-accent' : tone === 'gold' ? 'll-chip-gold' : '';

  return (
    <div className={clsx('card ll-card p-5 sm:p-6', hover && 'll-card-hover', className)} {...rest}>
      {(title || action || eyebrow || icon) && (
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex items-start gap-3 min-w-0">
            {icon && <span className={clsx('ll-chip', chipTone)}>{icon}</span>}
            <div className="min-w-0">
              {eyebrow && <span className="ll-eyebrow mb-2">{eyebrow}</span>}
              {title && (
                <h3 className="text-base font-bold text-sage-800 tracking-tight">{title}</h3>
              )}
              {description && (
                <p className="text-sm text-[var(--color-muted)] mt-1 leading-relaxed">
                  {description}
                </p>
              )}
            </div>
          </div>
          {action && <div className="flex-shrink-0">{action}</div>}
        </div>
      )}
      {children}
    </div>
  );
}
