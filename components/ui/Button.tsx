import { forwardRef, type ButtonHTMLAttributes } from 'react';
import clsx from 'clsx';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'accent' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', loading, fullWidth, className, children, disabled, ...rest }, ref) => {
    const base = 'btn inline-flex whitespace-nowrap items-center justify-center gap-2 font-bold rounded-[var(--radius-md)] border border-transparent transition-[transform,opacity,background-color,border-color] duration-150 ease-out active:translate-y-px focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-line-strong)] focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed disabled:active:translate-y-0';
    const variants = {
      primary: 'bg-[var(--color-primary)] text-white hover:bg-[var(--color-primary-strong)]',
      accent: 'bg-[var(--color-accent)] text-white hover:bg-[var(--color-accent-dark)]',
      secondary: 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border)] hover:bg-[var(--color-surface-muted)] hover:border-[var(--color-line-strong)]',
      ghost: 'text-[var(--color-text)] hover:bg-[var(--color-surface-muted)]',
      danger: 'bg-[var(--color-warn)] text-white hover:opacity-90',
    };
    const sizes = {
      sm: 'h-9 px-3.5 text-sm',
      md: 'h-11 px-5 text-[15px]',
      lg: 'h-[52px] px-7 text-base',
    };

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={clsx(
          base,
          variants[variant],
          sizes[size],
          fullWidth && 'w-full',
          className,
        )}
        {...rest}
      >
        {loading && <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />}
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';
