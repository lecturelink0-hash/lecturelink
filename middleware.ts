/**
 * Next.js 미들웨어
 *
 * 책임:
 *   1. Supabase 인증 쿠키 자동 갱신
 *   2. 보호 경로 접근 시 인증/온보딩 게이트
 *
 * 경로 정책:
 *   - 공개:   / (랜딩), /login, /auth/*, /api/webhooks/*, /api/queue/*, 정적 자산
 *   - 인증 필요: 그 외 모든 경로
 *   - 온보딩 필요: /dashboard, /practice, /notes, /analysis, /bank, /plan, /admin
 *                 → onboarded_at 없으면 /onboarding 으로 리다이렉트
 */

import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

interface CookieToSet {
  name: string;
  value: string;
  options?: CookieOptions;
}

const PUBLIC_PREFIXES = [
  '/login',
  '/auth/',
  '/api/webhooks/',
  '/api/queue/',
  '/terms',
  '/privacy',
  '/faq',
  '/contact', // 문의하기 (비로그인도 접근 가능)
  '/landing.html', // 정적 랜딩 (루트 rewrite 대상 · 직접 접근 허용)
];

const ONBOARDING_REQUIRED_PREFIXES = [
  '/dashboard',
  '/practice',
  '/notes',
  '/analysis',
  '/bank',
  '/plan',
  '/admin',
  '/exam',
  '/cpx',
  '/mock',
  '/wrong-notes',
  '/library',
  '/mypage',
];

function isPublicPath(pathname: string): boolean {
  // 루트(랜딩)는 미인증도 접근 가능. app/page.tsx 가 세션 유무로 분기한다.
  if (pathname === '/') return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

function requiresOnboarding(pathname: string): boolean {
  return ONBOARDING_REQUIRED_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export async function middleware(request: NextRequest) {
  const isRoot = request.nextUrl.pathname === '/';

  // 홈(/): 세션 쿠키가 아예 없는 익명 방문은 인증 조회 없이 바로 랜딩(빠른 경로).
  // 세션 쿠키가 있으면 아래에서 getUser 로 검증 후 로그인 사용자는 /dashboard 로 보낸다(기획서: 기 사용자 바로 홈).
  if (isRoot) {
    const hasAuthCookie = request.cookies
      .getAll()
      .some((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name) && c.value);
    if (!hasAuthCookie) {
      const url = request.nextUrl.clone();
      url.pathname = '/landing.html';
      return NextResponse.rewrite(url);
    }
  }

  let response = NextResponse.next({ request });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value),
          );
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options),
          );
        },
      },
    },
  );

  // 손상/만료 쿠키에서 세션 파싱이 throw 할 수 있으므로(예: base64 깨짐 → Invalid UTF-8)
  // 안전하게 감싸고, 실패 시 미인증으로 취급한다.
  let user: Awaited<ReturnType<typeof supabase.auth.getUser>>['data']['user'] = null;
  try {
    const { data } = await supabase.auth.getUser();
    user = data.user;
  } catch {
    user = null;
  }
  const { pathname } = request.nextUrl;

  // 홈(/): 세션 쿠키는 있었으나 실제 로그인 상태에 따라 분기.
  //   - 로그인됨(기 사용자) → 바로 홈(/dashboard)
  //   - 아니면(만료 등)     → 랜딩
  if (isRoot) {
    const url = request.nextUrl.clone();
    url.pathname = user ? '/dashboard' : '/landing.html';
    return user ? NextResponse.redirect(url) : NextResponse.rewrite(url);
  }

  // 공개 경로는 그대로
  if (isPublicPath(pathname)) {
    return response;
  }

  // 미인증
  if (!user) {
    // API 라우트는 401 으로 반환되도록 그대로 통과 (각 라우트의 requireSession 이 처리)
    if (pathname.startsWith('/api/')) {
      return response;
    }
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }

  // 온보딩 필요 경로 게이트
  if (requiresOnboarding(pathname) && pathname !== '/onboarding') {
    // users.onboarded_at 조회 — 미들웨어에서 anon client 로 RLS 통과 (본인 행)
    const { data: profile } = await supabase
      .from('users')
      .select('onboarded_at')
      .eq('id', user.id)
      .maybeSingle();

    if (!profile || !profile.onboarded_at) {
      const url = request.nextUrl.clone();
      url.pathname = '/onboarding';
      return NextResponse.redirect(url);
    }
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
