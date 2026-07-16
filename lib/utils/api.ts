/**
 * API 응답 유틸리티
 *
 * Next.js Route Handlers 에서 일관된 응답 포맷 제공.
 */

import { NextResponse } from 'next/server';
import { ZodError } from 'zod';

// ───────────── 공통 응답 타입 ─────────────

export interface ApiSuccess<T> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResponse<T> = ApiSuccess<T> | ApiError;

// ───────────── 응답 헬퍼 ─────────────

export function ok<T>(data: T, status = 200) {
  return NextResponse.json<ApiSuccess<T>>({ ok: true, data }, { status });
}

export function err(
  code: string,
  message: string,
  status = 400,
  details?: unknown,
) {
  return NextResponse.json<ApiError>(
    { ok: false, error: { code, message, details } },
    { status },
  );
}

// ───────────── 표준 에러 ─────────────

export const ApiErrors = {
  unauthorized: () => err('unauthorized', '로그인이 필요합니다.', 401),
  forbidden: () => err('forbidden', '권한이 없습니다.', 403),
  notFound: (resource: string) =>
    err('not_found', `${resource}을(를) 찾을 수 없습니다.`, 404),
  badRequest: (message: string, details?: unknown) =>
    err('bad_request', message, 400, details),
  conflict: (message: string) => err('conflict', message, 409),
  rateLimit: () => err('rate_limit', '요청이 너무 많습니다.', 429),
  quotaExceeded: (resource: string) =>
    err(
      'quota_exceeded',
      `${resource} 사용량 한도를 초과했습니다.`,
      402,
    ),
  internal: (message = '서버 오류가 발생했습니다.') =>
    err('internal_error', message, 500),
} as const;

// ───────────── Zod 에러 변환 ─────────────

/**
 * Zod 에러를 사용자 친화적 메시지 + 필드별 첫 에러만 노출 (스키마 내부 구조 노출 차단).
 */
export function handleZodError(error: ZodError) {
  const flat = error.flatten();
  // fieldErrors 의 각 필드 첫 메시지만 채택
  const fieldErrors: Record<string, string> = {};
  for (const [field, messages] of Object.entries(flat.fieldErrors)) {
    if (messages && messages.length > 0) {
      fieldErrors[field] = messages[0];
    }
  }
  const sanitized = {
    fieldErrors,
    formErrors: flat.formErrors.slice(0, 5),
  };
  return ApiErrors.badRequest('입력값이 올바르지 않습니다.', sanitized);
}

// ───────────── 예외 래퍼 ─────────────

// ───────────── 표준 예외 클래스 ─────────────

export class ApiException extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number = 400,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'ApiException';
  }
}

export class UnauthorizedException extends ApiException {
  constructor(message = '로그인이 필요합니다.') {
    super('unauthorized', message, 401);
    this.name = 'UnauthorizedException';
  }
}

export class ForbiddenException extends ApiException {
  constructor(message = '권한이 없습니다.') {
    super('forbidden', message, 403);
    this.name = 'ForbiddenException';
  }
}

export class CostCapExceededException extends ApiException {
  constructor(currentUsd: number, capUsd: number) {
    super(
      'cost_cap_exceeded',
      `일일 AI 비용 한도(${capUsd} USD)를 초과했습니다. 현재 ${currentUsd.toFixed(2)} USD.`,
      402,
      { currentUsd, capUsd },
    );
    this.name = 'CostCapExceededException';
  }
}

// ───────────── 예외 래퍼 ─────────────

/**
 * Route Handler 를 감싸 예외를 일관된 응답으로 변환.
 *
 * 사용:
 *   export const GET = withErrorHandling(async (req) => {
 *     ...
 *     return ok({ ... });
 *   });
 */
export function withErrorHandling<T extends unknown[]>(
  handler: (...args: T) => Promise<Response>,
) {
  return async (...args: T): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ZodError) {
        return handleZodError(error);
      }
      if (error instanceof ApiException) {
        return err(error.code, error.message, error.status, error.details);
      }
      // request.json() 같은 native body 파싱이 실패한 경우: SyntaxError 가 일반 500 으로
      // 새 나가지 않도록 400 으로 일반화. 내부 메시지는 노출하지 않음.
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && /JSON/i.test(error.message))
      ) {
        console.error('[api error] body parse:', error.message);
        return err('invalid_body', '요청 본문이 올바른 JSON 이 아닙니다.', 400);
      }
      console.error('[api error]', error);
      // 사용자 응답에는 일반 메시지만 노출. 내부 메시지는 서버 로그에만 남는다.
      return ApiErrors.internal();
    }
  };
}
