/**
 * Supabase Auth callback
 *
 * 매직 링크 클릭 시 ?code=xxx 와 함께 이 URL 로 리다이렉트.
 * 코드를 세션으로 교환하고 적절한 페이지로 이동.
 */

import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createServerClient } from '@/lib/db/server';
import { cookies } from 'next/headers';

export async function GET(request: Request) {
  const { searchParams, origin: reqOrigin } = new URL(request.url);
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type'); // signup | email | invite | magiclink | recovery
  // 이메일 인증(회원가입 확인)이면 완료 안내 페이지로, 그 외(카카오 등)는 앱 홈으로.
  const isEmailConfirm = type === 'signup' || type === 'email' || type === 'invite';
  // / 는 이제 랜딩이므로, 인증 완료(이메일 확인·카카오) 후 기본 목적지는 앱 홈(/dashboard).
  const next = searchParams.get('next') ?? (isEmailConfirm ? '/auth/confirmed' : '/dashboard');

  // 리버스 프록시(nginx) 뒤에서는 request.url 의 origin 이 컨테이너 내부 주소
  // (http://localhost:<PORT>)로 잡혀, 확인 메일 링크가 localhost 로 튕긴다.
  // 신뢰 가능한 정식 앱 URL → 프록시 전달 헤더 → request origin 순으로 base 결정.
  const fwdHost = request.headers.get('x-forwarded-host');
  const fwdProto = request.headers.get('x-forwarded-proto') ?? 'https';
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    (fwdHost ? `${fwdProto}://${fwdHost}` : reqOrigin);

  const supabase = await createServerClient();

  async function accountDestination(fallback: string) {
    const cookieStore = await cookies();
    const pending = cookieStore.get('lecturelink_account_type')?.value;
    if (pending === 'professor' || pending === 'student') {
      await supabase.auth.updateUser({ data: { requested_account_type: pending } });
      cookieStore.delete('lecturelink_account_type');
      return fallback;
    }
    const { data } = await supabase.auth.getUser();
    return data.user ? '/' : fallback;
  }

  // (A) 이메일 확인 링크(token_hash + type) — verifyOtp 로 검증.
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    });
    if (!error) {
      return NextResponse.redirect(`${base}${await accountDestination(next)}`);
    }
  }

  // (B) OAuth / PKCE(?code) — 세션 교환.
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${base}${await accountDestination(next)}`);
    }
  }

  // 코드 없음 또는 교환 실패
  return NextResponse.redirect(`${base}/login?error=callback_failed`);
}
