import { redirect } from 'next/navigation';
import { getCurrentSession } from '@/lib/auth/session';
import { CompleteEmailForm } from './CompleteEmailForm';

/**
 * 이메일 미보유 계정(카카오 로그인 등)의 이메일 필수 입력 단계.
 * (app) 그룹 밖에 두어 레이아웃 이메일 게이트와 리다이렉트 루프가 나지 않게 한다.
 */
export default async function CompleteProfilePage() {
  const session = await getCurrentSession();
  if (!session) redirect('/login');
  if (session.email) redirect('/dashboard'); // 이미 이메일 보유 → 통과

  return <CompleteEmailForm displayName={session.profile.displayName} />;
}
