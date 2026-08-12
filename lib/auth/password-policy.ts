export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 128;
export const PASSWORD_HINT = '영문을 포함한 8자 이상';
export const PASSWORD_ERROR =
  '비밀번호는 영문을 포함해 8자 이상으로 입력해 주세요.';

/**
 * 영문을 하나 이상 포함하되 숫자·기호·공백 등은 막지 않는다.
 * 클라이언트 검증은 UX용이며, 최소 길이는 Auth 서버에서도 반드시 강제해야 한다.
 */
export function isValidPassword(password: string): boolean {
  return (
    password.length >= PASSWORD_MIN_LENGTH &&
    password.length <= PASSWORD_MAX_LENGTH &&
    /[A-Za-z]/.test(password)
  );
}
