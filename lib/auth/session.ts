/**
 * 인증 세션 헬퍼
 *
 * Route Handlers / Server Components 에서 현재 사용자 정보 조회.
 */

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
 */
export async function getCurrentSession(): Promise<AuthSession | null> {
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
        accountType:
          profile.account_type === 'professor' ||
          (!('account_type' in profile) && user.user_metadata?.account_type === 'professor')
            ? 'professor'
            : 'student',
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
        accountType: user.user_metadata?.account_type === 'professor' ? 'professor' : 'student',
        facultyStatus: user.user_metadata?.account_type === 'professor' ? 'approved' : 'not_requested',
      };

  const role: 'user' | 'admin' =
    profile && (profile as { role?: string }).role === 'admin' ? 'admin' : 'user';

  return {
    userId: user.id,
    email: user.email ?? '',
    profile: userProfile,
    role,
  };
}

/**
 * 인증된 세션을 강제. null이면 UnauthorizedException throw.
 * withErrorHandling 과 함께 사용하면 401 응답으로 자동 변환된다.
 */
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
