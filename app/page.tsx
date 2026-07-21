import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/auth/session';
import { Landing } from '@/components/landing/Landing';

export default async function HomePage() {
  const session = await getCurrentSession();

  if (session) {
    if (session.profile.accountType === 'professor') {
      redirect('/professor');
    }
    if (!session.profile.onboardedAt) {
      redirect('/onboarding');
    }
    redirect('/dashboard');
  }

  return <Landing />;
}
