/**
 * 429 재시도 분류 회귀 검사 — 크레딧·결제·쿼터 소진은 바로 실패, 할당량 정보 없는 일시적 용량 부족은 재시도.
 *   npm run check:retry
 */
import { readFileSync } from 'node:fs';
import { isPermanentQuota429Message, PERMANENT_429_MARKERS } from '../lib/ai/retry-policy.ts';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.log(`✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}
console.log('[check:retry]');

// 실제로 받은 응답 본문(오류 메시지는 `Gemini API 429: ${본문 앞 300자}`)
const wrap = (body) => `Gemini API 429: ${body.slice(0, 300)}`;
const capacity = wrap('{\n  "error": {\n    "code": 429,\n    "message": "Resource has been exhausted (e.g. check quota).",\n    "status": "RESOURCE_EXHAUSTED"\n  }\n}\n');
const quota = wrap('{\n  "error": {\n    "code": 429,\n    "message": "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",\n    "status": "RESOURCE_EXHAUSTED"\n  }\n}\n');
const metric = wrap('{"error":{"code":429,"message":"Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_paid_tier_input_token_count, limit: 1000000","status":"RESOURCE_EXHAUSTED"}}');
const credits = wrap('{"error":{"code":429,"message":"Your prepayment credits are depleted. Please go to AI Studio to manage your project and billing.","status":"RESOURCE_EXHAUSTED"}}');

check('일시적 용량 부족(할당량 정보 없음)은 재시도 대상', !isPermanentQuota429Message(capacity));
check('쿼터 초과 문구는 바로 실패', isPermanentQuota429Message(quota));
check('지표별 쿼터 초과는 바로 실패', isPermanentQuota429Message(metric));
check('선불 크레딧 소진은 바로 실패', isPermanentQuota429Message(credits));
check('문구 하나씩: 현재 쿼터 초과', isPermanentQuota429Message('You exceeded your current quota.'));
check('문구 하나씩: 선불 크레딧 소진', isPermanentQuota429Message('Your prepayment credits are depleted.') && isPermanentQuota429Message('credits depleted'));
check('대소문자 무관', isPermanentQuota429Message('BILLING ACCOUNT DISABLED') && isPermanentQuota429Message('Insufficient balance'));
check('상태값만으로는 소진으로 보지 않음', !isPermanentQuota429Message('RESOURCE_EXHAUSTED') && !PERMANENT_429_MARKERS.includes('resource_exhausted'));
check('빈 값', !isPermanentQuota429Message('') && !isPermanentQuota429Message(undefined));

// 소스 대조
const client = readFileSync(new URL('../lib/ai/client.ts', import.meta.url), 'utf8');
const body = client.slice(client.indexOf('export function isNonRetryableQuotaError'), client.indexOf('function isRetryableError'));
check('client: 429 소진 판정은 retry-policy 문구 판정 하나', /return isPermanentQuota429Message\(/.test(body) && !/resource_exhausted/i.test(body));
check('client: 소진이 아닌 429 는 재시도', /if \(status === 429 && isNonRetryableQuotaError\(error\)\) return false;\s*return status === 429 \|\| status >= 500;/.test(client));
const gemini = readFileSync(new URL('../lib/ai/gemini.ts', import.meta.url), 'utf8');
check('gemini: 429 는 status·재시도 대기(RetryInfo 없으면 20초)를 붙임', /err\.status = res\.status;/.test(gemini) && /err\.retryAfterMs = parseGeminiRetryDelayMs\(text\) \?\? 20_000;/.test(gemini));
const pg = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
const san = pg.slice(pg.indexOf('function sanitizeErrorMessage'), pg.indexOf('function sanitizeErrorMessage') + 1600);
check('PG: 재시도까지 실패한 일시적 용량 부족은 "혼잡"으로 알림(크레딧 소진 아님)', /if \(lower\.includes\('resource has been exhausted'\) && !isPermanentQuota429Message\(m\)\) \{\s*return 'AI 서버가 일시적으로 혼잡해/.test(san) && san.indexOf('resource has been exhausted') < san.indexOf("lower.includes('credit')"));

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
