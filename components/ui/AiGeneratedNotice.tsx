import { Sparkles } from 'lucide-react';

export function AiGeneratedNotice({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-start gap-2 rounded-xl border border-[var(--color-border)] bg-[var(--color-sage-50)] px-3.5 py-3 text-xs leading-relaxed text-[var(--color-muted)] ${className}`}>
      <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-primary)]" aria-hidden="true" />
      <p><b className="text-[var(--color-text)]">AI 생성·보조 콘텐츠</b>가 포함될 수 있습니다. 오류가 있을 수 있으므로 원자료와 교재를 함께 확인하고, 의료행위나 공식 평가의 유일한 근거로 사용하지 마세요.</p>
    </div>
  );
}
