/**
 * 카카오 커스텀 로그인 시작 (Supabase 기본 provider 대체)
 *
 * Supabase 내장 카카오 provider 는 account_email 동의를 강제해 KOE205 를 유발한다.
 * (이메일 수집은 카카오 비즈앱=사업자등록 필요.) 이를 우회하기 위해 이메일을 요구하지 않고
 * profile_nickname 만 받는 카카오 OAuth 를 직접 개시한다. → /api/auth/kakao/callback 로 복귀.
 */
import { NextResponse } from 'next/server';
import { randomBytes } from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const KAKAO_AUTHORIZE = 'https://kauth.kakao.com/oauth/authorize';

function baseUrl(request: Request): string {
  const fwdHost = request.headers.get('x-forwarded-host');
  const fwdProto = request.headers.get('x-forwarded-proto') ?? 'https';
  return (
    process.env.NEXT_PUBLIC_APP_URL ||
    (fwdHost ? `${fwdProto}://${fwdHost}` : new URL(request.url).origin)
  );
}

export async function GET(request: Request) {
  const base = baseUrl(request);
  const clientId = process.env.KAKAO_CLIENT_ID;
  if (!clientId) {
    return NextResponse.redirect(`${base}/login?error=kakao_not_configured`);
  }

  const { searchParams } = new URL(request.url);
  const nextParam = searchParams.get('next') || '/dashboard';
  const next = nextParam.startsWith('/') && !nextParam.startsWith('/login') ? nextParam : '/dashboard';

  const state = randomBytes(16).toString('hex');
  const redirectUri = `${base}/api/auth/kakao/callback`;

  const authUrl = new URL(KAKAO_AUTHORIZE);
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', 'profile_nickname'); // 이메일 미요청 — KOE205 회피
  authUrl.searchParams.set('state', state);

  const res = NextResponse.redirect(authUrl.toString());
  const secure = base.startsWith('https://');
  const opts = { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: 600 };
  res.cookies.set('kakao_oauth_state', state, opts);
  res.cookies.set('kakao_oauth_next', next, opts);
  return res;
}
