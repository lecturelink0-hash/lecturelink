/**
 * 업로드당 원가 계측 회귀 검사 (RAG 실행계획 v1.1 · Phase 0-a) — 네트워크·DB 없이 돈다.
 *
 * 무엇을 지키는가
 *  1) 비용 귀속 컨텍스트가 **비동기 경계를 넘어** 유지되는가. await 뒤, setTimeout,
 *     병렬 Promise, 진입 함수가 끝난 뒤 도착하는 늦은 기록(헤지)까지 같은 uploadId 여야 한다.
 *     여기가 끊기면 OCR·Vision 비용이 다시 업로드당 원가에서 빠진다.
 *  2) 동시에 도는 두 업로드의 비용이 **섞이지 않는가**.
 *  3) 호출자가 직접 넣은 uploadId 를 덮어쓰지 않는가.
 *  4) 집계 산식이 실행계획 8장 정의와 같은가 — 헤지 패자 포함, 문항 0개 업로드는
 *     문항당 원가에서 제외, 진단 totalCost 와의 차이는 헤지 패자를 빼고 비교.
 *  5) 계측 지점이 코드에서 빠지지 않았는가(소스 대조).
 *
 *   npm run check:upload-cost
 */
import { readFileSync } from 'node:fs';
import {
  attachUploadId,
  attributedCostSnapshot,
  currentCostAttribution,
  runWithCostAttribution,
  tallyAttributedCost,
} from '../lib/metrics/cost-attribution.ts';
import {
  median,
  percentile,
  summarizeUploadCosts,
  toUsd,
} from '../lib/metrics/upload-cost.ts';

let pass = 0;
let fail = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  OK   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n[귀속 컨텍스트] 컨텍스트 밖');
{
  check('컨텍스트 밖이면 null', currentCostAttribution() === null);
  check('컨텍스트 밖이면 metadata 그대로', JSON.stringify(attachUploadId({ a: 1 }, null)) === '{"a":1}');
  check('컨텍스트 밖·metadata 없음 → null', attachUploadId(undefined, null) === null);
  tallyAttributedCost({ endpoint: 'x', costUsd: 1, inputTokens: 1, outputTokens: 1, metadata: null });
  check('컨텍스트 밖 집계는 no-op', attributedCostSnapshot() === null);
}

console.log('\n[귀속 컨텍스트] 비동기 경계 유지');
{
  const seen = await runWithCostAttribution({ uploadId: 'u-1', userId: 'user-1' }, async () => {
    const out = [];
    out.push(currentCostAttribution()?.uploadId);
    await sleep(5);
    out.push(currentCostAttribution()?.uploadId);
    out.push(await new Promise((r) => setTimeout(() => r(currentCostAttribution()?.uploadId), 5)));
    const parallel = await Promise.all(
      [1, 2, 3].map(async (i) => {
        await sleep(i);
        return currentCostAttribution()?.uploadId;
      }),
    );
    out.push(...parallel);
    return out;
  });
  check('await·setTimeout·Promise.all 모두 같은 uploadId', seen.every((v) => v === 'u-1'), JSON.stringify(seen));
  check('컨텍스트가 끝나면 다시 null', currentCostAttribution() === null);
}

console.log('\n[귀속 컨텍스트] 동시 업로드 격리');
{
  const run = (id, n) =>
    runWithCostAttribution({ uploadId: id, userId: null }, async () => {
      for (let i = 0; i < n; i++) {
        await sleep(1);
        tallyAttributedCost({ endpoint: 'ocr.claude', costUsd: 0.001, inputTokens: 10, outputTokens: 2, metadata: attachUploadId(null, currentCostAttribution()) });
      }
      return attributedCostSnapshot();
    });
  const [a, b] = await Promise.all([run('u-A', 3), run('u-B', 5)]);
  check('A 는 A 것만 3건', a.uploadId === 'u-A' && a.byEndpoint['ocr.claude'].calls === 3, JSON.stringify(a));
  check('B 는 B 것만 5건', b.uploadId === 'u-B' && b.byEndpoint['ocr.claude'].calls === 5, JSON.stringify(b));
  check('합계 금액이 건수와 일치', near(a.totalUsd, 0.003) && near(b.totalUsd, 0.005));
}

console.log('\n[귀속 컨텍스트] metadata 병합 규칙');
{
  const attr = { uploadId: 'u-ctx', userId: 'x' };
  const original = { batch: 2 };
  const merged = attachUploadId(original, attr);
  check('uploadId 없으면 붙인다', merged.uploadId === 'u-ctx' && merged.batch === 2);
  check('입력 객체를 바꾸지 않는다', original.uploadId === undefined);
  check('호출자가 준 uploadId 는 존중', attachUploadId({ uploadId: 'u-own' }, attr).uploadId === 'u-own');
  check('metadata 가 없어도 uploadId 는 붙는다', attachUploadId(undefined, attr).uploadId === 'u-ctx');
}

console.log('\n[귀속 컨텍스트] 헤지 패자·다른 업로드 행·늦은 기록');
{
  let late;
  const snap = await runWithCostAttribution({ uploadId: 'u-H', userId: null }, async () => {
    tallyAttributedCost({ endpoint: 'private.generate', costUsd: 0.01, inputTokens: 100, outputTokens: 50, metadata: { uploadId: 'u-H' } });
    tallyAttributedCost({ endpoint: 'private.generate', costUsd: 0.004, inputTokens: 100, outputTokens: 50, metadata: { uploadId: 'u-H', hedgeLoser: true } });
    tallyAttributedCost({ endpoint: 'private.generate', costUsd: 9, inputTokens: 1, outputTokens: 1, metadata: { uploadId: 'u-other' } });
    // 진입 함수가 끝난 뒤에 도착하는 기록(헤지 패자처럼 void 로 던져 둔 promise)
    late = (async () => {
      await sleep(10);
      tallyAttributedCost({ endpoint: 'ocr.claude', costUsd: 0.002, inputTokens: 1, outputTokens: 1, metadata: attachUploadId(null, currentCostAttribution()) });
      return attributedCostSnapshot();
    })();
    return attributedCostSnapshot();
  });
  check('다른 업로드 행은 세지 않는다', near(snap.totalUsd, 0.014), String(snap.totalUsd));
  check('헤지 패자 몫을 따로 센다', near(snap.hedgeLoserUsd, 0.004));
  const after = await late;
  check('끝난 뒤 도착한 기록도 같은 업로드로 귀속', after?.uploadId === 'u-H' && near(after.totalUsd, 0.016), JSON.stringify(after));
}

console.log('\n[집계] 기본 통계');
{
  check('median 홀수', median([3, 1, 2]) === 2);
  check('median 짝수', median([4, 1, 3, 2]) === 2.5);
  check('median 빈 배열 null', median([]) === null);
  check('p95 최근접 순위', percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 95) === 100);
  check('p50 최근접 순위', percentile([1, 2, 3, 4], 50) === 2);
  check('percentile 빈 배열 null', percentile([], 95) === null);
  check('numeric 문자열 → 숫자', toUsd('0.012345') === 0.012345 && toUsd(null) === 0 && toUsd('x') === 0);
}

console.log('\n[집계] 실행계획 8장 산식');
{
  const rows = [
    // 업로드 A: 생성 0.05 + 헤지 패자 0.01 + OCR 0.004 + Vision 0.006 (문자열 numeric)
    { endpoint: 'private.generate', cost_usd: 0.05, metadata: { uploadId: 'A', batch: 0 } },
    { endpoint: 'private.generate', cost_usd: 0.01, metadata: { uploadId: 'A', hedgeLoser: true } },
    { endpoint: 'ocr.claude', cost_usd: '0.004', metadata: { uploadId: 'A' } },
    { endpoint: 'extract.detect-regions', cost_usd: '0.006', metadata: { uploadId: 'A' } },
    // A 의 진단 두 건 — 늦은 것이 이긴다. pipelineUsd = 0.06(헤지 패자 제외)
    { endpoint: 'private.diagnostics', cost_usd: 0, created_at: '2026-09-28T00:00:00Z', metadata: { uploadId: 'A', timings: { totalMs: 1000 }, cost: { pipelineUsd: 0.5 } } },
    { endpoint: 'private.diagnostics', cost_usd: 0, created_at: '2026-09-28T00:05:00Z', metadata: { uploadId: 'A', timings: { totalMs: 90000 }, cost: { pipelineUsd: 0.06 } } },
    // 업로드 B: 0.02, 진단 없음(0-a 이전 실행)
    { endpoint: 'private.generate', cost_usd: 0.02, metadata: { uploadId: 'B' } },
    // 업로드 C: 비용은 있는데 문항 0개(실패)
    { endpoint: 'private.generate', cost_usd: 0.03, metadata: { uploadId: 'C' } },
    // 귀속 없는 행·사전 분석(uploadIds 목록)은 무시
    { endpoint: 'uploads.analyze', cost_usd: 0.9, metadata: { uploads: 2, uploadIds: ['A', 'B'] } },
    { endpoint: 'ocr.claude', cost_usd: 0.9, metadata: null },
  ];
  const { uploads, aggregate } = summarizeUploadCosts({ rows, questionCounts: { A: 10, B: 4 } });
  const a = uploads.find((u) => u.uploadId === 'A');
  const b = uploads.find((u) => u.uploadId === 'B');
  const c = uploads.find((u) => u.uploadId === 'C');
  check('A 합계는 헤지 패자 포함 0.07', near(a.totalUsd, 0.07), String(a.totalUsd));
  check('A 헤지 패자 0.01', near(a.hedgeLoserUsd, 0.01));
  check('A 문항당 0.007', near(a.perQuestionUsd, 0.007));
  check('A 엔드포인트별 합', a.byEndpoint['private.generate'].calls === 2 && near(a.byEndpoint['ocr.claude'].costUsd, 0.004));
  check('A 는 가장 늦은 진단을 쓴다', a.pipelineUsd === 0.06 && a.totalMs === 90000);
  check('A 교차 검증 차이 0 (헤지 패자 빼고 비교)', near(a.gapRatio, 0), String(a.gapRatio));
  check('B 진단 없으면 차이 null', b.pipelineUsd === null && b.gapRatio === null);
  check('C 문항 0개면 문항당 null', c.perQuestionUsd === null);
  check('귀속 없는 행·사전 분석은 업로드로 잡히지 않는다', uploads.length === 3, uploads.map((u) => u.uploadId).join(','));
  check('중앙값은 문항 있는 업로드만(0.007, 0.005)', near(aggregate.medianPerQuestionUsd, 0.006), String(aggregate.medianPerQuestionUsd));
  check('가중 평균 = 0.09 / 14', near(aggregate.pooledPerQuestionUsd, 0.09 / 14));
  check('전체 비용에는 실패 업로드도 포함', near(aggregate.totalUsd, 0.12));
  check('교차 검증 1건 중 1건 통과', aggregate.gapChecked === 1 && aggregate.gapWithinTolerance === 1);
  check('p95 처리 시간', aggregate.p95TotalMs === 90000);
}

console.log('\n[집계] 차이 감지·업로드 목록 지정');
{
  const rows = [
    { endpoint: 'private.generate', cost_usd: 0.05, metadata: { uploadId: 'D' } },
    { endpoint: 'ocr.claude', cost_usd: 0.05, metadata: { uploadId: 'D' } },
    // 파이프라인은 생성만 셌다 → ai_cost_log 쪽이 100% 많다
    { endpoint: 'private.diagnostics', cost_usd: 0, metadata: { uploadId: 'D', cost: { pipelineUsd: 0.05 } } },
  ];
  const { uploads, aggregate } = summarizeUploadCosts({
    rows,
    questionCounts: { D: 5 },
    uploadIds: ['D', 'E'],
  });
  const d = uploads.find((u) => u.uploadId === 'D');
  check('누락이 있으면 차이로 드러난다(+100%)', near(d.gapRatio, 1), String(d.gapRatio));
  check('허용 범위 밖으로 집계', aggregate.gapChecked === 1 && aggregate.gapWithinTolerance === 0);
  const e = uploads.find((u) => u.uploadId === 'E');
  check('지정했는데 행이 없는 업로드도 0 원으로 포함', e && e.totalUsd === 0 && e.questions === 0);
}

console.log('\n[소스 대조] 계측 지점');
{
  const costCap = readFileSync(new URL('../lib/ai/cost-cap.ts', import.meta.url), 'utf8');
  const pg = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
  const versions = readFileSync(new URL('../lib/ai/versions.ts', import.meta.url), 'utf8');
  check('recordAiCost 가 uploadId 를 붙인다', /attachUploadId\(input\.metadata, attribution\)/.test(costCap));
  check('recordAiCost 가 컨텍스트 합계에 더한다', /tallyAttributedCost\(/.test(costCap));
  check('생성 진입점이 귀속 컨텍스트를 연다', /runWithCostAttribution\(\s*\{\s*uploadId: input\.uploadId/.test(pg));
  check('참고자료 프로파일이 0 원으로 기록되지 않는다', !/endpoint: 'private\.reference-profile',\s*model,\s*costUsd: 0,/.test(pg));
  check('진단에 원가·설정 스냅샷이 실린다', /attributed: attributedCostSnapshot\(\)/.test(pg) && /config: configSnapshot\(\)/.test(pg));
  check('임베딩 모델 기본값이 실제 호출과 같다', /VOYAGE_EMBED_MODEL \?\? 'voyage-3'/.test(versions) && !/'text-embedding-3-small';/.test(versions));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
