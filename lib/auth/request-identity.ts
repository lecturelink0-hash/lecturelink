/**
 * 미들웨어 → 서버 렌더/라우트 핸들러 인증 핸드오프
 *
 * 배경:
 *   supabase.auth.getUser() 는 매 호출마다 Supabase Auth 서버로 HTTPS 왕복이 발생한다.
 *   지금까지는 (1) 미들웨어가 한 번, (2) 같은 요청을 처리하는 RSC/라우트 핸들러가
 *   getCurrentSession()/requireAuthUser() 안에서 또 한 번 호출해서, 요청 하나당 인증
 *   왕복이 2회씩 들었다. 학생 화면 대부분이 마운트 직후 /api/* 를 여러 개 호출하므로
 *   화면 전환 한 번에 이 왕복이 10회 이상 쌓인다.
 *
 * 방식:
 *   미들웨어가 이미 검증한 사용자 정보를 요청 헤더에 실어 넘기고, 하위 계층은 그대로
 *   신뢰하지 않고 HMAC 서명을 검증한 뒤에만 사용한다. 서명 키는 서버 전용
 *   SUPABASE_SERVICE_ROLE_KEY 라 브라우저가 위조할 수 없다.
 *   (헤더는 미들웨어가 만든 내부 요청에만 붙는다. 외부에서 같은 이름의 헤더를 넣어도
 *    미들웨어가 항상 지우고 다시 쓰며, 설령 미들웨어를 우회하더라도 서명이 맞지 않는다.)
 *
 * 폴백:
 *   서명 키가 없거나 헤더가 없으면 기존대로 supabase.auth.getUser() 로 확인한다.
 *   즉 이 최적화가 꺼져도 동작은 동일하고, 느려질 뿐이다.
 */

export const IDENTITY_HEADER = 'x-ll-identity';

/** 같은 요청 안에서만 쓰이는 값이라 짧게 잡는다. 시계 오차 여유 포함. */
const TTL_MS = 120_000;

interface VerifiedIdentity {
  userId: string;
  email: string;
}

function signingSecret(): string | null {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return key && key.length > 0 ? key : null;
}

let cachedKey: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(secret: string): Promise<CryptoKey> {
  if (cachedKey && cachedKey.secret === secret) return cachedKey.key;
  const key = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  cachedKey = { secret, key };
  return key;
}

async function sign(body: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    'HMAC',
    await hmacKey(secret),
    new TextEncoder().encode(body),
  );
  let hex = '';
  for (const byte of new Uint8Array(signature)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

// 구분자('.')와 충돌하지 않도록 값은 base64url 로 감싼다.
// (이메일에는 점이 들어가므로 URL 인코딩만으로는 부족하다.)
function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** 길이가 같을 때 상수 시간 비교. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 미들웨어에서 호출. 서명 키가 없으면 null → 헤더를 붙이지 않고 하위 계층이 폴백한다.
 */
export async function encodeIdentity(
  userId: string,
  email: string,
  nowMs: number,
): Promise<string | null> {
  const secret = signingSecret();
  if (!secret) return null;
  const body = `${toBase64Url(userId)}.${toBase64Url(email)}.${nowMs + TTL_MS}`;
  return `${body}.${await sign(body, secret)}`;
}

/**
 * RSC / 라우트 핸들러에서 호출.
 * 검증 실패·미설정이면 null 을 돌려주고, 호출부는 getUser() 로 폴백한다.
 */
export async function decodeIdentity(
  header: string | null | undefined,
  nowMs: number,
): Promise<VerifiedIdentity | null> {
  if (!header) return null;
  const secret = signingSecret();
  if (!secret) return null;

  const lastDot = header.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const body = header.slice(0, lastDot);
  const signature = header.slice(lastDot + 1);

  const parts = body.split('.');
  if (parts.length !== 3) return null;
  const [encodedUserId, encodedEmail, expiresAt] = parts;
  if (!encodedUserId) return null;

  const expiry = Number(expiresAt);
  if (!Number.isFinite(expiry) || expiry < nowMs) return null;

  if (!timingSafeEqual(await sign(body, secret), signature)) return null;

  try {
    const userId = fromBase64Url(encodedUserId);
    if (!userId) return null;
    return { userId, email: fromBase64Url(encodedEmail) };
  } catch {
    return null;
  }
}
