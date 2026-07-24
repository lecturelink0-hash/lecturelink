import type { ReactNode } from 'react';
import clsx from 'clsx';

export function UploadNextSteps({
  steps,
  footer,
  className,
}: {
  steps: Array<{ number: number; title: string; description: string }>;
  footer: ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={clsx(
        'upload-next-steps flex flex-col justify-center rounded-2xl border-2 border-dashed border-[var(--color-border)] bg-[var(--color-sage-50)]/50 p-6',
        className,
      )}
    >
      <p className="text-sm font-bold text-sage-700 mb-4">업로드하면 이렇게 진행돼요</p>
      <ol className="space-y-4">
        {steps.map((step) => (
          <li className="flex items-start gap-3" key={step.number}>
            <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full border-2 border-dashed border-[var(--color-sage-400)] text-base font-bold text-[var(--color-sage-500)]">
              {step.number}
            </span>
            <div>
              <div className="text-sm font-semibold text-sage-700">{step.title}</div>
              <div className="text-xs text-[var(--color-muted)] mt-0.5 leading-relaxed">{step.description}</div>
            </div>
          </li>
        ))}
      </ol>
      <p className="mt-5 text-xs text-[var(--color-muted)] leading-relaxed">{footer}</p>
    </aside>
  );
}
