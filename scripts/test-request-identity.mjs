#!/usr/bin/env node
/**
 * lib/auth/request-identity.ts 회귀 테스트
 *
 * 미들웨어가 서명해 넘긴 신원 헤더를 RSC/라우트 핸들러가 그대로 믿는 구조라,
 * "위조가 통과하는" 회귀는 곧바로 인증 우회가 된다. 서명·만료·키 부재 폴백을
 * 여기서 못 박아 둔다.
 *
 *   node scripts/test-request-identity.mjs
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const outDir = mkdtempSync(join(tmpdir(), 'll-request-identity-'));
const outFile = join(outDir, 'request-identity.mjs');

try {
  execFileSync(
    'npx',
    [
      'esbuild',
      'lib/auth/request-identity.ts',
      '--format=esm',
      '--platform=node',
      `--outfile=${outFile}`,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );

  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key-abcdefghijklmnop';
  const { encodeIdentity, decodeIdentity, IDENTITY_HEADER } = await import(
    pathToFileURL(outFile).href
  );

  const now = 1_700_000_000_000;
  const uid = '8f14e45f-ea2b-4c1a-9d3e-000000000001';

  // 1. 정상 왕복
  const token = await encodeIdentity(uid, 'a+b@example.com', now);
  assert.ok(token, '토큰이 발급돼야 한다');
  assert.deepEqual(await decodeIdentity(token, now), {
    userId: uid,
    email: 'a+b@example.com',
  });

  // 2. 점이 들어간 이메일·비ASCII 이메일도 손실 없이 복원 (구분자 충돌 회귀 방지)
  const nonAscii = await encodeIdentity(uid, '한글@example.co.kr', now);
  assert.equal((await decodeIdentity(nonAscii, now)).email, '한글@example.co.kr');

  // 3. 서명 변조 거부
  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.equal(await decodeIdentity(tampered, now), null, '변조된 서명은 거부');

  // 4. 사용자 id 바꿔치기 거부
  const parts = token.split('.');
  const swapped = [
    Buffer.from('00000000-0000-0000-0000-000000000999').toString('base64url'),
    parts[1],
    parts[2],
    parts[3],
  ].join('.');
  assert.equal(await decodeIdentity(swapped, now), null, 'id 바꿔치기는 거부');

  // 5. 만료 거부
  assert.equal(
    await decodeIdentity(token, now + 10 * 60 * 1000),
    null,
    '만료된 토큰은 거부',
  );

  // 6. 형식 불량 거부
  for (const bad of [null, undefined, '', 'garbage', 'a.b.c']) {
    assert.equal(await decodeIdentity(bad, now), null, `형식 불량 거부: ${bad}`);
  }

  // 7. 서명 키가 없으면 발급도 신뢰도 하지 않는다 → getUser() 폴백
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  assert.equal(await encodeIdentity(uid, 'x@y.z', now), null, '키 없으면 발급 안 함');
  assert.equal(await decodeIdentity(token, now), null, '키 없으면 신뢰 안 함');

  // 8. 다른 키로 서명된 토큰 거부
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'a-different-service-role-key-000000';
  assert.equal(await decodeIdentity(token, now), null, '다른 키 서명은 거부');

  assert.equal(IDENTITY_HEADER, 'x-ll-identity');
  console.log('request-identity: 8종 검증 통과');
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
