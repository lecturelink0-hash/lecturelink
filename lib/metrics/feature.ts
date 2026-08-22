/**
 * 경로 → 기능 이름 (분담표 A1)
 *
 * import 를 두지 않는다 — 산식 검사 스크립트(scripts/check-metrics.mjs)가 별칭 해석 없이
 * 이 파일만 불러 회귀를 잡을 수 있어야 한다. 저장소의 다른 check 스크립트와 같은 관례다.
 */

/** UUID·숫자·긴 16진수처럼 요청마다 달라지는 조각. 기능 이름에 섞이면 집계가 쪼개진다. */
const ID_SEGMENT = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+|[0-9a-f]{16,})$/i;

/**
 * 경로 → 기능 이름.
 *
 *   POST /api/questions/generate                  → questions_generate
 *   GET  /api/uploads/3f2a.../diagnostics         → uploads_diagnostics
 *   POST /api/cpx/sessions/abc/evaluate           → cpx_proxy
 *
 * CPX 하위 경로를 한 이름으로 접는 이유: CPX 백엔드가 자기 계측을 이미 상세히 남긴다.
 * 여기서 다시 쪼개면 같은 요청이 두 대시보드에 다른 이름으로 두 번 나타난다.
 */
export function featureFromPath(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  if (parts[0] !== 'api') return 'page';
  const rest = parts.slice(1);
  if (rest.length === 0) return 'api_root';
  if (rest[0] === 'cpx') return 'cpx_proxy';
  const named = rest.filter((segment) => !ID_SEGMENT.test(segment));
  return (named.length ? named : rest).join('_').replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 80);
}
