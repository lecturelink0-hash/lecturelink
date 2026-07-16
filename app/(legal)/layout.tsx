import Link from 'next/link';
import { Stethoscope, ArrowLeft } from 'lucide-react';

export default function LegalLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-[var(--color-bg)]">
      <header className="border-b border-[var(--color-border)] bg-white">
        <div className="max-w-3xl mx-auto px-5 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 text-sage-700 font-bold">
            <Stethoscope className="w-5 h-5" strokeWidth={2.2} />
            렉처링크
          </Link>
          <Link
            href="/"
            className="inline-flex items-center gap-1 text-sm text-[var(--color-muted)] hover:text-sage-700 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            홈으로
          </Link>
        </div>
      </header>
      <main className="max-w-3xl mx-auto px-5 py-10">{children}</main>
    </div>
  );
}
