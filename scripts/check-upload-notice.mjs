#!/usr/bin/env node
/**
 * 사용자 알림 조립 검사 — P8.
 *
 * 실행: npm run check:notice   (네트워크 불필요)
 *
 * 왜 있는가 (2026-08-18 감사 · 2026-08-19 실측)
 *  - 생성기의 경고 49건이 전부 진단 JSON 에만 남아 사용자는 아무것도 몰랐다.
 *    실측에서 10문항 요청이 8문항으로 끝났는데(누출 폐기 2 + 보충 2회 429) 화면에는
 *    이유가 없었다.
 *  - 알림은 "사용자에게 보이는 문장"이라 조용히 늘거나 사라지면 안 된다. 어떤 사실이
 *    어떤 코드로 나오는지, **무엇이 나오지 않는지**를 코드로 고정한다.
 *
 * 검사
 *  1. 정상 생성(요청=저장, 문제 없음)이면 알림이 하나도 없다.
 *  2. 부족 생성이면 shortfall + 사유(429 / API 오류 / 필터링)를 구분한다.
 *  3. 이미지형인데 이미지 0장이면 no_image, 이미지형이 아니면 안 나온다.
 *  4. 절삭·참고자료 무시가 각각의 코드로 나온다.
 *  5. 요청 수를 채웠어도 배치 실패가 있었으면 transient_error 로 알린다.
 *  6. **의학 검증 플래그는 어떤 경우에도 알림이 되지 않는다**(warn 모드 오탐 때문 —
 *     사람 검토로 오탐률을 낮춘 뒤 재검토하기로 한 결정).
 */
import { buildUploadNotices } from '../lib/ai/upload-notice.ts';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const base = {
  desiredCount: 10,
  savedCount: 10,
  wantsImages: false,
  featuredImageCount: 0,
  truncatedChars: 0,
  referenceSkipped: 0,
  batchFailureReasons: [],
  leakageDiscarded: 0,
  verifyRejected: 0,
};
const codes = (input) => buildUploadNotices({ ...base, ...input }).map((n) => n.code);
const find = (input, code) => buildUploadNotices({ ...base, ...input }).find((n) => n.code === code);

console.log('정상 생성');
check('알릴 것이 없으면 빈 배열', buildUploadNotices(base).length === 0);
check(
  '이미지형이라도 이미지를 확보했으면 조용하다',
  codes({ wantsImages: true, featuredImageCount: 8 }).length === 0,
);

console.log('\n부족 생성(shortfall)과 사유 구분');
check('부족하면 shortfall 이 나온다', codes({ savedCount: 8 }).includes('shortfall'));
check('부족분 개수를 담는다', find({ savedCount: 8 }, 'shortfall')?.count === 2);
{
  const rl = find(
    { savedCount: 8, batchFailureReasons: ['Gemini API 429: You exceeded your current quota'] },
    'shortfall',
  );
  check('429 는 "요청이 한꺼번에 몰려"로 설명한다', /한꺼번에 몰려/.test(rl?.detail ?? ''));
  check('429 사유에 원문(quota·429)을 노출하지 않는다', !/429|quota/i.test(rl?.detail ?? ''));
}
{
  const api = find({ savedCount: 9, batchFailureReasons: ['tool_use 블록이 없습니다'] }, 'shortfall');
  check('그 밖의 실패는 "일시적인 오류"로 뭉뚱그린다', /일시적인 오류/.test(api?.detail ?? ''));
  check('내부 메시지를 그대로 노출하지 않는다', !/tool_use/.test(api?.detail ?? ''));
}
{
  const filt = find({ savedCount: 8, leakageDiscarded: 2 }, 'shortfall');
  check('걸러내서 줄었으면 그 사유를 말한다', /걸러내면서/.test(filt?.detail ?? ''));
}

console.log('\n이미지·절삭·참고자료');
check(
  '이미지형인데 0장이면 no_image',
  codes({ wantsImages: true, featuredImageCount: 0 }).includes('no_image'),
);
check(
  '이미지형이 아니면 no_image 를 내지 않는다',
  !codes({ wantsImages: false, featuredImageCount: 0 }).includes('no_image'),
);
check('절삭이 있으면 text_truncated', codes({ truncatedChars: 12000 }).includes('text_truncated'));
check('절삭 글자 수를 담는다', find({ truncatedChars: 12000 }, 'text_truncated')?.count === 12000);
check(
  '참고자료를 못 읽었으면 reference_ignored',
  codes({ referenceSkipped: 2 }).includes('reference_ignored'),
);

console.log('\n수는 채웠지만 실패가 있었던 경우');
check(
  'transient_error 로 알린다',
  codes({ savedCount: 10, batchFailureReasons: ['Gemini API 429'] }).includes('transient_error'),
);
check(
  '부족 생성일 때는 shortfall 로만 말하고 중복해서 알리지 않는다',
  !codes({ savedCount: 8, batchFailureReasons: ['Gemini API 429'] }).includes('transient_error'),
);

console.log('\n의학 검증 플래그는 알림이 아니다 (결정 사항)');
{
  // warn 모드에서는 verifyRejected 가 0 이고 플래그만 쌓인다 — 어느 경우든 알림 코드가 없어야 한다.
  const all = buildUploadNotices({ ...base, savedCount: 8, verifyRejected: 2 });
  check('verify 전용 코드가 없다', !all.some((n) => /verify|검증/i.test(n.code)));
  check(
    '문구에도 "검토가 필요한 문항"을 쓰지 않는다',
    !all.some((n) => /검토가 필요한 문항/.test(n.detail ?? '')),
  );
}

console.log('\n노출 문구 안전성');
{
  const every = buildUploadNotices({
    ...base,
    savedCount: 6,
    wantsImages: true,
    featuredImageCount: 0,
    truncatedChars: 5000,
    referenceSkipped: 1,
    batchFailureReasons: ['Gemini API 429'],
    leakageDiscarded: 1,
  });
  check('여러 사실이 동시에 나오면 각각 한 줄씩', every.length === 4, every.map((n) => n.code).join(','));
  check(
    '어떤 문구에도 스택·키·URL 이 없다',
    every.every((n) => !/https?:\/\/|apikey|Bearer|at .*\.ts:/i.test(n.detail ?? '')),
  );
  check('모든 항목에 code 가 있다', every.every((n) => typeof n.code === 'string' && n.code));
}

if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log('\n전부 통과');
