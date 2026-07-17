#!/usr/bin/env node

const baseUrl = String(process.env.CPX_BACKEND_URL || '').replace(/\/$/, '');
const proxySecret = process.env.CPX_PROXY_SHARED_SECRET || '';
const userId = process.env.CPX_SMOKE_USER_ID || 'lecturelink-deployment-smoke';
const expectedCases = Number(process.env.CPX_EXPECT_CASES || 197);
const expectedReleaseReadyOnly = String(process.env.CPX_EXPECT_RELEASE_READY_ONLY || 'false') === 'true';

function fail(message) {
  throw new Error(message);
}

if (!baseUrl) fail('CPX_BACKEND_URL이 필요합니다.');
if (!proxySecret) fail('CPX_PROXY_SHARED_SECRET이 필요합니다.');

const parsedUrl = new URL(baseUrl);
const localHost = ['127.0.0.1', 'localhost', '::1'].includes(parsedUrl.hostname);
if (!localHost && parsedUrl.protocol !== 'https:') {
  fail('외부 CPX_BACKEND_URL은 HTTPS여야 합니다.');
}

async function jsonResponse(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    signal: AbortSignal.timeout(15_000),
    ...options,
  });
  const body = await response.json().catch(() => ({}));
  return { response, body };
}

const health = await jsonResponse('/api/health');
if (!health.response.ok || health.body.ok !== true) {
  fail(`health 실패 (${health.response.status})`);
}
if (health.body.hasApiKey !== true) fail('배포된 CPX 서비스에 GEMINI_API_KEY가 없습니다.');

const unauthenticated = await jsonResponse('/api/cases');
if (unauthenticated.response.status !== 401) {
  fail(`인증 없는 증례 요청은 401이어야 합니다 (실제 ${unauthenticated.response.status}).`);
}

const catalog = await jsonResponse('/api/cases', {
  headers: {
    'x-cpx-proxy-secret': proxySecret,
    'x-lecturelink-user-id': userId,
  },
});
if (!catalog.response.ok) fail(`인증된 증례 요청 실패 (${catalog.response.status})`);
if (!Array.isArray(catalog.body.cases)) fail('증례 응답에 cases 배열이 없습니다.');
if (catalog.body.cases.length !== expectedCases) {
  fail(`증례 수 불일치: 기대 ${expectedCases}, 실제 ${catalog.body.cases.length}`);
}
if (catalog.body.releaseReadyOnly !== expectedReleaseReadyOnly) {
  fail(`releaseReadyOnly 불일치: 기대 ${expectedReleaseReadyOnly}, 실제 ${catalog.body.releaseReadyOnly}`);
}

console.log('CPX deployment smoke passed');
console.log(`- backend: ${parsedUrl.origin}`);
console.log(`- model: ${health.body.model}`);
console.log(`- unauthenticated boundary: ${unauthenticated.response.status}`);
console.log(`- authenticated cases: ${catalog.body.cases.length}`);
console.log(`- releaseReadyOnly: ${catalog.body.releaseReadyOnly}`);
