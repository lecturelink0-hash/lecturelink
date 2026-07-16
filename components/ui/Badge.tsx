import clsx from 'clsx';
import type { ReactNode } from 'react';

type BadgeVariant =
  | 'default'
  | 'curated'
  | 'community'
  | 'beta'
  | 'private'
  | 'warn'
  | 'gray';

interface BadgeProps {
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

const STYLES: Record<BadgeVariant, string> = {
  default:   'bg-[var(--color-sage-200)] text-sage-700',
  curated:   'bg-[var(--color-curated-bg)] text-[var(--color-curated)] border border-[var(--color-sage-500)]',
  community: 'bg-[var(--color-sage-200)] text-sage-700 border border-[var(--color-sage-400)]',
  beta:      'bg-[var(--color-beta-bg)] text-[var(--color-beta)] border border-[#E0CC8A]',
  private:   'bg-[var(--color-private-bg)] text-[var(--color-private)] border border-[#f0cbb0]',
  warn:      'bg-[var(--color-warn-bg)] text-[var(--color-warn)]',
  gray:      'bg-gray-100 text-gray-700',
};

export function Badge({ variant = 'default', children, className }: BadgeProps) {
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-semibold',
        STYLES[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}
