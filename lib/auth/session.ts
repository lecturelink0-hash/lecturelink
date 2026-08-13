/**
 * 인증 세션 헬퍼
 *
 * Route Handlers / Server Components 에서 현재 사용자 정보 조회.
 */

import { cache } from 'react';
import { createServerClient } from '@/lib/db/server';
import { createAdminClient } from '@/lib/db/admin';
import type { UserProfile } from '@/lib/types/domain';
import type { GradeLevel, PlanTier, SemesterTerm } from '@/lib/types/database';

export interface AuthSession {
  userId: string;
  email: string;
  profile: UserProfile;
  role: 'user' | 'admin';
}

/**
 * 현재 사용자 세션 조회. 인증되지 않은 경우 null.
 *
 * React cache() 로 감싸 같은 요청(RSC 렌더) 안에서 레이아웃·페이지가 각각 호출해도
 * Supabase auth/프로필 왕복은 1회만 발생한다.
 */
export const getCurrentSession = cache(async (): Promise<AuthSession | null> => {
  if (
    process.env.NODE_ENV === 'development' &&
    process.env.LOCAL_FACULTY_UI_PREVIEW === 'true'
  ) {
    return {
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'professor.preview@lecturelink.local',
      role: 'user',
      profile: {
        id: '00000000-0000-4000-8000-000000000001',
        displayName: '백원기',
        school: {
          id: '00000000-0000-4000-8000-000000000002',
          name: 'LectureLink 의과대학',
          shortName: '렉처링크 의대',
        },
        grade: null,
        currentSemester: null,
        currentYear: null,
        planTier: 'free',
        onboardedAt: process.env.LOCAL_FACULTY_ONBOARDING_PREVIEW === 'true'
          ? null
          : new Date(0).toISOString(),
        accountType: 'professor',
        facultyStatus: 'approved',
      },
    };
  }

  const supabase = await createServerClient();

  const {
    data: { user },
    error: authError,
  } = await supabase.auth.getUser();

  if (authError || !user) {
    return null;
  }

  let { data: profile, error: profileError } = await supabase
    .from('users')
    .select(
      `
      id,
      display_name,
      grade,
      current_semester,
      current_year,
      plan_tier,
      onboarded_at,
      role,
      account_type,
      faculty_status,
      school:schools (
        id,
        name,
        short_name
      )
    `,
    )
    .eq('id', user.id)
    .maybeSingle();

  // Keep authentication working while the account_type migration is being
  // rolled out. Once the column exists, the database value remains the source
  // of truth; older schemas fall back to the auth metadata set at signup.
  if (profileError?.code === '42703' && profileError.message.includes('account_type')) {
    const fallback = await supabase
      .from('users')
      .select(
        `
        id,
        display_name,
        grade,
        current_semester,
        current_year,
        plan_tier,
        onboarded_at,
        role,
        school:schools (
          id,
          name,
          short_name
        )
      `,
      )
      .eq('id', user.id)
      .maybeSingle();

    profile = fallback.data as typeof profile;
    profileError = fallback.error;
  }

  if (profileError) {
    console.error('[auth] profile fetch error:', profileError);
    return null;
  }

  // 이전 교수 가입 트리거는 요청을 pending 상태의 학생 계정으로 저장했다.
  // 폐쇄 베타에서는 교수 자가가입을 허용하므로 이 조합을 발견하면 서버 권한으로 복구한다.
  if (profile?.account_type === 'student' && profile.faculty_status === 'pending') {
    const admin = createAdminClient();
    const { error: repairError } = await admin
      .from('users')
      .update({
        account_type: 'professor',
        faculty_status: 'approved',
        faculty_approved_at: new Date().toISOString(),
        faculty_approved_by: null,
      })
      .eq('id', user.id)
      .eq('faculty_status', 'pending');

    if (!repairError) {
      profile.account_type = 'professor';
      profile.faculty_status = 'approved';
    } else {
      console.error('[auth] professor account repair failed:', repairError);
    }
  }

  // profile 이 없으면 (auth.users 만 있고 public.users 미생성) 최소 정보로 반환
  const userProfile: UserProfile = profile
    ? {
        id: profile.id,
        displayName: profile.display_name,
        school: Array.isArray(profile.school)
          ? profile.school[0]
            ? {
                id: profile.school[0].id,
                name: profile.school[0].name,
                shortName: profile.school[0].short_name,
              }
            : null
          : profile.school
            ? {
                id: (profile.school as { id: string }).id,
                name: (profile.school as { name: string }).name,
                shortName: (profile.school as { short_name: string }).short_name,
              }
            : null,
        grade: profile.grade as GradeLevel | null,
        currentSemester: profile.current_semester as SemesterTerm | null,
        currentYear: profile.current_year,
        planTier: profile.plan_tier as PlanTier,
        onboardedAt: profile.onboarded_at,
        // 권한은 사용자가 수정할 수 있는 user_metadata 가 아니라 DB 프로필만 신뢰한다.
        accountType: profile.account_type === 'professor' ? 'professor' : 'student',
        facultyStatus: ('faculty_status' in profile && profile.faculty_status
          ? profile.faculty_status
          : profile.account_type === 'professor'
            ? 'approved'
            : 'not_requested') as UserProfile['facultyStatus'],
      }
    : {
        id: user.id,
        displayName: null,
        school: null,
        grade: null,
        currentSemester: null,
        currentYear: null,
        planTier: 'free',
        onboardedAt: null,
        // 프로필 생성 실패를 권한 상승으로 바꾸지 않도록 안전한 기본값을 사용한다.
        accountType: 'student',
        facultyStatus: 'not_requested',
      };

  const role: 'user' | 'admin' =
    profile && (profile as { role?: string }).role === 'admin' ? 'admin' : 'user';

  return {
    userId: user.id,
    email: user.email ?? '',
    profile: userProfile,
    role,
  };
});

/**
 * 인증된 세션을 강제. null이면 UnauthorizedException throw.
 * withErrorHandling 과 함께 사용하면 401 응답으로 자동 변환된다.
 */
/**
 * 인증 여부만 확인하는 경량 세션 체크.
 * users 프로필 조회(학교 조인 포함)를 생략해 DB 왕복 1회를 줄인다.
 * 프로필/플랜 정보가 필요 없는 읽기 전용 엔드포인트(문항 목록·카운트 등)용.
 */
export async function requireAuthUser(): Promise<{ userId: string; email: string }> {
  if (
    process.env.NODE_ENV === 'development' &&
    process.env.LOCAL_FACULTY_UI_PREVIEW === 'true'
  ) {
    return {
      userId: '00000000-0000-4000-8000-000000000001',
      email: 'professor.preview@lecturelink.local',
    };
  }

  const supabase = await createServerClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user) {
    const { UnauthorizedException } = await import('@/lib/utils/api');
    throw new UnauthorizedException();
  }
  return { userId: user.id, email: user.email ?? '' };
}

export async function requireSession(): Promise<AuthSession> {
  const session = await getCurrentSession();
  if (!session) {
    const { UnauthorizedException } = await import('@/lib/utils/api');
    throw new UnauthorizedException();
  }
  return session;
}

/**
 * admin 권한을 강제. 비-admin 이면 ForbiddenException(403).
 */
export async function requireAdmin(): Promise<AuthSession> {
  const session = await requireSession();
  if (session.role !== 'admin') {
    const { ForbiddenException } = await import('@/lib/utils/api');
    throw new ForbiddenException('관리자 권한이 필요합니다.');
  }
  return session;
}

export async function requireProfessor(): Promise<AuthSession> {
  const session = await requireSession();
  if (session.role !== 'admin' && session.profile.accountType !== 'professor') {
    const { ForbiddenException } = await import('@/lib/utils/api');
    throw new ForbiddenException('교수 계정에서만 사용할 수 있습니다.');
  }
  return session;
}

export async function requireStudent(): Promise<AuthSession> {
  const session = await requireSession();
  if (session.role !== 'admin' && session.profile.accountType !== 'student') {
    const { ForbiddenException } = await import('@/lib/utils/api');
    throw new ForbiddenException('학생 계정에서만 사용할 수 있습니다.');
  }
  return session;
}

/**
 * admin 클라이언트로 직접 role 조회 (RLS 우회).
 * Webhook 등 인증되지 않은 컨텍스트에서 사용자 ID 만으로 admin 확인할 때.
 */
export async function isUserAdmin(userId: string): Promise<boolean> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('users')
    .select('role')
    .eq('id', userId)
    .maybeSingle();
  return (data as { role?: string } | null)?.role === 'admin';
}
