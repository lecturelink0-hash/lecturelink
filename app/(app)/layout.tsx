import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/auth/session';
import { Sidebar } from '@/components/layout/Sidebar';
import { Footer } from '@/components/layout/Footer';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await getCurrentSession();
  if (!session) {
    redirect('/login');
  }
  // 이메일 미보유(예: 카카오 로그인 — 이메일 동의 미제공) 계정은 이메일 필수 입력 단계로.
  if (!session.email) {
    redirect('/complete-profile');
  }

  return (
    <div className="ll-app-shell shell min-h-screen flex flex-col">
      <Sidebar
        user={{
          displayName: session.profile.displayName,
          schoolShortName: session.profile.school?.shortName ?? null,
          grade: session.profile.grade,
          planTier: session.profile.planTier,
          onboarded: !!session.profile.onboardedAt,
        }}
      />
      <main className="ll-app-main overflow-x-clip flex-1">
        <div className="ll-page-frame max-w-[1140px] mx-auto px-5 md:px-7 pt-[88px] pb-14">{children}</div>
      </main>
      <Footer />
    </div>
  );
}
