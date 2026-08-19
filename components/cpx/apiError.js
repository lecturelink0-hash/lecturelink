// CPX 요청 실패 메시지 추출 — 응답 형식이 두 가지라 한쪽만 보면 안내가 사라진다.
//
// Fly(FastAPI)는 `{ detail: '...' }`, Next.js 프록시는 앱 표준인
// `{ ok:false, error:{ code, message, details } }` 를 돌려준다. 클라이언트가 `detail` 만
// 읽고 있어서 프록시가 낸 오류는 메시지가 통째로 버려지고 "요청 실패 (402)" 만 보였다 —
// 정작 필요한 "CPX 이용 시간 한도를 초과했습니다. 남은 양: 0" 이 사라진 것이다
// (2026-08-18 감사 P2). 두 형식을 모두 읽고, 없을 때만 상태 코드로 물러난다.
export function apiErrorMessage(body, status) {
  if (body && typeof body === 'object') {
    if (typeof body.detail === 'string' && body.detail.trim()) return body.detail;
    const error = body.error;
    if (error && typeof error === 'object' && typeof error.message === 'string' && error.message.trim()) {
      return error.message;
    }
    if (typeof body.message === 'string' && body.message.trim()) return body.message;
  }
  return `요청 실패 (${status})`;
}

// 오류 코드도 함께 봐야 하는 호출부(쿼터 초과 안내 등)를 위해 코드만 따로 뽑는다.
export function apiErrorCode(body) {
  if (body && typeof body === 'object') {
    const error = body.error;
    if (error && typeof error === 'object' && typeof error.code === 'string') return error.code;
    if (typeof body.code === 'string') return body.code;
  }
  return '';
}
