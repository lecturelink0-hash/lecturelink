'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import { Button, type ButtonVariant } from './Button';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** 확인 전에 받을 추가 입력(해지 사유 등). 설명과 버튼 사이에 놓인다. */
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: ButtonVariant;
  cancelVariant?: ButtonVariant;
  /** 파괴적 액션(삭제 등)이면 확인 버튼을 danger 스타일로 */
  danger?: boolean;
  loading?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 브랜드 스타일 확인 다이얼로그 — window.confirm()/alert() 대체.
 * 열릴 때 취소 버튼(안전한 기본값)에 포커스, Escape 로 취소, Tab 은 내부 순환,
 * 닫히면 이전 포커스로 복귀.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  children,
  confirmLabel = '확인',
  cancelLabel = '취소',
  danger,
  confirmVariant,
  cancelVariant = 'secondary',
  loading,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();

    function handleKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (!loading) onCancel();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      // children 으로 라디오·입력이 들어올 수 있으므로 버튼만 잡으면 포커스 트랩이 그것들을 건너뛴다.
      const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !dialogRef.current.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !dialogRef.current.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      previouslyFocused?.focus?.();
    };
  }, [loading, onCancel, open]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-5">
      <div
        className="absolute inset-0 bg-[rgb(20_60_44_/_0.34)]"
        aria-hidden="true"
        onClick={loading ? undefined : onCancel}
      />
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={description ? 'confirm-dialog-desc' : undefined}
        className="relative w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-white p-6 shadow-xl"
      >
        <h2 id="confirm-dialog-title" className="text-base font-bold text-sage-800 tracking-tight">
          {title}
        </h2>
        {description && (
          <p id="confirm-dialog-desc" className="mt-2 text-sm text-[var(--color-muted)] leading-relaxed">
            {description}
          </p>
        )}
        {children}
        {error && (
          <p role="alert" className="mt-4 rounded-xl border border-red-200 bg-red-50 px-3.5 py-3 text-sm leading-relaxed text-red-700">
            {error}
          </p>
        )}
        <div className="mt-5 flex justify-end gap-2">
          <Button ref={cancelRef} variant={cancelVariant} size="sm" onClick={onCancel} disabled={loading}>
            {cancelLabel}
          </Button>
          <Button variant={confirmVariant ?? (danger ? 'danger' : 'primary')} size="sm" onClick={onConfirm} loading={loading}>
            {confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
