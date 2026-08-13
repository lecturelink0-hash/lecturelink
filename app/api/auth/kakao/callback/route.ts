/**
 * 카카오 커스텀 로그인 콜백
 *
 * 1) state(CSRF) 검증
 * 2) code → 카카오 토큰 교환 (client_secret 은 앱 설정 시에만 사용)
 * 3) 카카오 사용자 정보(id·닉네임) 조회
 * 4) 이 카카오 id 로 Supabase 사용자 조회/생성 (이메일은 합성값, 카카오 id 를 메타데이터에 보관
 *    → 추후 정식(비즈앱) 카카오 provider 로 이전 시 이 id 로 계정 병합 가능)
 * 5) magiclink 를 관리자 권한으로 발급해 /auth/callback 로 넘겨 세션 성립
 */
import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/db/admin';
import { PRIVACY_VERSION, TERMS_VERSION } from '@/lib/legal/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function baseUrl(request: Request): string {
  const fwdHost = request.headers.get('x-forwarded-host');
  const fwdProto = request.headers.get('x-forwarded-proto') ?? 'https';
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (fwdHost ? `${fwdProto}://${fwdHost}` : new URL(request.url).origin)
  );
}

function readCookie(request: Request, name: string): string | undefined {
  const raw = request.headers.get('cookie') || '';
  const m = raw.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return m ? m[1] : undefined;
}

export async function GET(request: Request) {
  const base = baseUrl(request);
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const kakaoError = searchParams.get('error');

  const cookieState = readCookie(request, 'kakao_oauth_state');
  const nextRaw = readCookie(request, 'kakao_oauth_next');
  const next = nextRaw ? decodeURIComponent(nextRaw) : '/dashboard';

  const fail = (reason: string) => {
    const res = NextResponse.redirect(`${base}/login?error=${reason}`);
    res.cookies.delete('kakao_oauth_state');
    res.cookies.delete('kakao_oauth_next');
    res.cookies.delete('lecturelink_account_type');
    res.cookies.delete('lecturelink_legal_consent');
    return res;
  };

  if (kakaoError) return fail('kakao_denied');
  if (!code || !state || !cookieState || state !== cookieState) return fail('kakao_state');

  let legalConsent: { termsVersion?: string; privacyVersion?: string; acceptedAt?: string; ageOver14?: boolean } | null = null;
  try {
    const rawConsent = readCookie(request, 'lecturelink_legal_consent');
    legalConsent = rawConsent ? JSON.parse(decodeURIComponent(rawConsent)) : null;
  } catch {
    legalConsent = null;
  }
  const acceptedAtMs = legalConsent?.acceptedAt ? Date.parse(legalConsent.acceptedAt) : Number.NaN;
  const consentIsCurrent = legalConsent?.termsVersion === TERMS_VERSION
    && legalConsent?.privacyVersion === PRIVACY_VERSION
    && legalConsent?.ageOver14 === true
    && Number.isFinite(acceptedAtMs)
    && Date.now() - acceptedAtMs >= 0
    && Date.now() - acceptedAtMs <= 10 * 60 * 1000;
  if (!consentIsCurrent) return fail('legal_consent_required');

  const clientId = process.env.KAKAO_CLIENT_ID;
  const clientSecret = process.env.KAKAO_CLIENT_SECRET;
  if (!clientId) return fail('kakao_not_configured');
  const redirectUri = `${base}/api/auth/kakao/callback`;

  // 2) 토큰 교환
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    redirect_uri: redirectUri,
    code,
  });
  if (clientSecret) tokenBody.set('client_secret', clientSecret);

  let accessToken = '';
  try {
    const tokenRes = await fetch('https://kauth.kakao.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' },
      body: tokenBody,
    });
    const tokenJson = await tokenRes.json();
    if (!tokenRes.ok || !tokenJson.access_token) {
      console.error('[kakao] token exchange failed:', tokenJson?.error_code, tokenJson?.error_description);
      return fail('kakao_token');
    }
    accessToken = tokenJson.access_token;
  } catch (e) {
    console.error('[kakao] token exchange error:', e);
    return fail('kakao_token');
  }

  // 3) 사용자 정보
  let kakaoId = '';
  let nickname = '카카오 사용자';
  try {
    const meRes = await fetch('https://kapi.kakao.com/v2/user/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const me = await meRes.json();
    if (!meRes.ok || !me.id) {
      console.error('[kakao] userinfo failed:', me);
      return fail('kakao_userinfo');
    }
    kakaoId = String(me.id);
    nickname =
      me.properties?.nickname ||
      me.kakao_account?.profile?.nickname ||
      nickname;
  } catch (e) {
    console.error('[kakao] userinfo error:', e);
    return fail('kakao_userinfo');
  }

  // 4) Supabase 사용자 조회/생성 — 카카오 id 기반 합성 이메일(수신 불가 도메인)
  const email = `kakao_${kakaoId}@kakao.users.lecturelink.kro.kr`;
  const requestedAccountType = readCookie(request, 'lecturelink_account_type') === 'professor'
    ? 'professor'
    : 'student';
  const admin = createAdminClient();
  const recordedAt = new Date().toISOString();
  const { error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
    // 계정 유형은 신규 생성 시점에만 반영한다. 기존 계정은 쿠키로 승격하지 않는다.
    user_metadata: {
      display_name: nickname,
      kakao_id: kakaoId,
      provider: 'kakao',
      requested_account_type: requestedAccountType,
      terms_version: TERMS_VERSION,
      terms_accepted_at: recordedAt,
      privacy_notice_version: PRIVACY_VERSION,
      privacy_noticed_at: recordedAt,
      age_over_14_confirmed_at: recordedAt,
    },
    app_metadata: { provider: 'kakao', kakao_id: kakaoId },
  });
  if (createErr && !/registered|already|exists/i.test(createErr.message)) {
    console.error('[kakao] createUser failed:', createErr.message);
    return fail('kakao_user');
  }

  // 5) magiclink 발급 → /auth/callback 에서 verifyOtp 로 세션 성립
  const { data: linkData, error: linkErr } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
  });
  const tokenHash = linkData?.properties?.hashed_token;
  if (linkErr || !tokenHash) {
    console.error('[kakao] generateLink failed:', linkErr?.message);
    return fail('kakao_session');
  }

  const res = NextResponse.redirect(
    `${base}/auth/callback?token_hash=${encodeURIComponent(tokenHash)}&type=magiclink&next=${encodeURIComponent(next)}`,
  );
  res.cookies.delete('kakao_oauth_state');
  res.cookies.delete('kakao_oauth_next');
  res.cookies.delete('lecturelink_account_type');
  res.cookies.delete('lecturelink_legal_consent');
  return res;
}
