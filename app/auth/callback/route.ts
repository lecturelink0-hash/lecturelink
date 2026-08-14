/**
 * Supabase Auth callback
 *
 * 매직 링크 클릭 시 ?code=xxx 와 함께 이 URL 로 리다이렉트.
 * 코드를 세션으로 교환하고 적절한 페이지로 이동.
 */

import { NextResponse } from 'next/server';
import type { EmailOtpType } from '@supabase/supabase-js';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';

export async function GET(request: Request) {
  const { searchParams, origin: reqOrigin } = new URL(request.url);
  const code = searchParams.get('code');
  const tokenHash = searchParams.get('token_hash');
  const type = searchParams.get('type'); // signup | email | invite | magiclink | recovery
  // GoTrue 가 /auth/v1/verify 검증 실패를 쿼리로 붙여 보낸 경우(만료·재사용 링크).
  const gotrueErrorCode = searchParams.get('error_code');
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
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return fallback;
    let { data: profile } = await supabase
      .from('users')
      .select('account_type, faculty_status, onboarded_at')
      .eq('id', user.id)
      .maybeSingle();

    const requestedProfessor =
      user.user_metadata?.requested_account_type === 'professor' ||
      user.user_metadata?.account_type === 'professor';

    // 일부 운영 DB의 이전 가입 트리거는 교수 선택값을 faculty_status=pending 으로만 남겼다.
    // 인증 직후 원래 요청값을 기준으로 교수 계정을 확정해 학생 온보딩으로 잘못 보내지 않게 한다.
    if (requestedProfessor && profile?.account_type !== 'professor') {
      const admin = createAdminClient();
      const { data: repaired, error: repairError } = await admin
        .from('users')
        .update({
          account_type: 'professor',
          faculty_status: 'approved',
          faculty_approved_at: new Date().toISOString(),
          faculty_approved_by: null,
        })
        .eq('id', user.id)
        .select('account_type, faculty_status, onboarded_at')
        .single();
      if (!repairError) profile = repaired;
    }

    if (profile?.account_type === 'professor') {
      return profile.onboarded_at ? '/professor' : '/professor-onboarding';
    }
    return fallback;
  }

  // 검증 실패 처리 — 같은 브라우저에 이미 로그인 세션이 있으면(링크 중복 클릭 등)
  // 실패가 아니라 정상 진입으로 취급한다. 오류 화면보다 앱으로 보내는 쪽이 항상 낫다.
  async function failureRedirect(errorCode: string) {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      return NextResponse.redirect(`${base}${await accountDestination(next)}`);
    }
    return NextResponse.redirect(`${base}/login?error=${errorCode}`);
  }

  // (A) 이메일 확인 링크(token_hash + type) — verifyOtp 로 검증.
  // 쿠키가 필요 없어 가입한 브라우저가 아니어도(메일앱 인앱 브라우저 등) 성립한다.
  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      type: type as EmailOtpType,
    });
    if (!error) {
      return NextResponse.redirect(`${base}${await accountDestination(next)}`);
    }
    return failureRedirect('confirm_link_expired');
  }

  // (B) OAuth / PKCE(?code) — 세션 교환.
  // 가입을 개시한 브라우저의 code_verifier 쿠키가 필요하다. 메일 링크를 다른
  // 브라우저(카카오톡·네이버 인앱 등)에서 열면 교환만 실패하고, GoTrue /verify 를
  // 거쳐 왔다면 이메일 인증 자체는 이미 완료된 상태다.
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${base}${await accountDestination(next)}`);
    }
    return failureRedirect('confirm_verified_login_needed');
  }

  // GoTrue 검증 실패 리다이렉트(만료·재사용 링크).
  if (gotrueErrorCode) {
    return failureRedirect(gotrueErrorCode === 'otp_expired' ? 'confirm_link_expired' : 'callback_failed');
  }

  // 파라미터 없음(구형 implicit 링크는 세션을 URL 프래그먼트로 전달해 서버가 볼 수 없다)
  return NextResponse.redirect(`${base}/login?error=callback_failed`);
}
