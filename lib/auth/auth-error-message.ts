/**
 * Supabase Auth(GoTrue) 에러를 한국어 사용자 메시지로 변환.
 *
 * supabase-js v2 의 AuthError 는 `code`(예: 'invalid_credentials')를 제공한다.
 * 우선 code 로 매핑하고, 구버전/예외는 message 문자열로 보조 매핑하며,
 * 그래도 모르면 일반 한국어 메시지로 폴백한다(영어 원문 노출 방지).
 */

interface AuthLikeError {
  code?: string;
  message?: string;
  status?: number;
}

const BY_CODE: Record<string, string> = {
  invalid_credentials: '이메일 또는 비밀번호를 확인해 주세요.',
  email_not_confirmed: '이메일 인증이 완료되지 않았습니다. 받은 편지함의 인증 메일을 확인해 주세요.',
  user_already_exists: '가입 요청을 확인했습니다. 받은 편지함을 확인해 주세요.',
  email_exists: '가입 요청을 확인했습니다. 받은 편지함을 확인해 주세요.',
  user_not_found: '이메일 또는 비밀번호를 확인해 주세요.',
  weak_password: '비밀번호가 안전 기준을 충족하지 않습니다. 다른 비밀번호를 사용해 주세요.',
  same_password: '기존 비밀번호와 다른 비밀번호를 입력해 주세요.',
  over_email_send_rate_limit: '요청이 잠시 몰렸습니다. 잠시 후 다시 시도해 주세요.',
  over_request_rate_limit: '요청이 잠시 몰렸습니다. 잠시 후 다시 시도해 주세요.',
  email_address_invalid: '유효하지 않은 이메일 주소입니다.',
  validation_failed: '입력값을 다시 확인해 주세요.',
  signup_disabled: '현재 회원가입이 비활성화되어 있습니다.',
  email_provider_disabled: '이메일 회원가입이 비활성화되어 있습니다.',
  otp_expired: '인증 코드가 만료되었습니다. 다시 요청해 주세요.',
  session_expired: '세션이 만료되었습니다. 다시 로그인해 주세요.',
  bad_jwt: '인증 정보가 올바르지 않습니다. 다시 로그인해 주세요.',
};

// code 가 없는 구버전 응답 대비 — message 부분 문자열 매핑.
const BY_MESSAGE: Array<[RegExp, string]> = [
  [/invalid login credentials|user not found/i, '이메일 또는 비밀번호를 확인해 주세요.'],
  [/email not confirmed/i, '이메일 인증이 완료되지 않았습니다. 받은 편지함의 인증 메일을 확인해 주세요.'],
  [/user already registered|already registered/i, '가입 요청을 확인했습니다. 받은 편지함을 확인해 주세요.'],
  [/email rate limit exceeded|rate limit/i, '요청이 잠시 몰렸습니다. 잠시 후 다시 시도해 주세요.'],
  [/password should be at least|weak password/i, '비밀번호가 안전 기준을 충족하지 않습니다. 다른 비밀번호를 사용해 주세요.'],
  [/unable to validate email|invalid format|invalid email/i, '유효하지 않은 이메일 주소입니다.'],
  [/error sending confirmation email/i, '인증 메일 발송에 실패했습니다. 잠시 후 다시 시도해 주세요.'],
];

const FALLBACK = '지금은 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.';

export function isExistingAccountError(error: unknown): boolean {
  if (!error) return false;
  const e = error as AuthLikeError;
  return (
    e.code === 'user_already_exists' ||
    e.code === 'email_exists' ||
    Boolean(e.message && /user already registered|already registered/i.test(e.message))
  );
}

export function authErrorMessage(error: unknown): string {
  if (!error) return FALLBACK;
  const e = error as AuthLikeError;

  if (e.code && BY_CODE[e.code]) return BY_CODE[e.code];

  if (e.message) {
    for (const [pattern, msg] of BY_MESSAGE) {
      if (pattern.test(e.message)) return msg;
    }
  }

  return FALLBACK;
}
