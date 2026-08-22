/**
 * 문항 생성 반복 안정성 측정 (성능지표 가이드 §4.2 · 분담표 A3)
 *
 * 프로덕션과 **같은 시스템 프롬프트·툴 스키마**로 같은 자료를 N회 생성해 변동을 잰다.
 * (lib/ai/prompts/private-generation.ts 를 그대로 import 한다 — 하니스용 사본을 두면
 *  프롬프트가 바뀔 때 측정 대상과 실물이 갈라진다.)
 *
 *   npm run check:gen-repeat -- --selftest          # 산식만 (API 키 불필요, CI 에서 돈다)
 *   ANTHROPIC_API_KEY=... npm run check:gen-repeat -- --runs 10 --fixture <id>
 *   npm run check:gen-repeat -- --list              # 등록된 고정 입력 목록
 *
 * 고정 입력은 datasets/generation-fixed-inputs/ 에 둔다. 이건 **테스트셋**이다 —
 * 결과를 보고 프롬프트를 고친 뒤 같은 입력으로 다시 재면 그 수치는 개발셋 성능이지
 * 테스트셋 성능이 아니다(가이드 §10.2).
 */
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  summarizeGenerationRuns,
  contractVerdicts,
  SAME_QUESTION_SIMILARITY,
} from '../lib/ai/generation-repeatability.ts';

const FIXTURE_DIR = 'datasets/generation-fixed-inputs';
const DEFAULT_RUNS = 10;

// ───────── CLI ─────────
const argv = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const has = (name) => argv.includes(`--${name}`);

function listFixtures() {
  if (!existsSync(FIXTURE_DIR)) return [];
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(FIXTURE_DIR, f), 'utf8')));
}

// ───────── selftest: 산식만 (모델 호출 없음) ─────────

function makeQuestion(seed, overrides = {}) {
  return {
    stem: `${seed}세 남자가 3일 전부터 이어진 발열로 병원에 왔다. 시행할 검사는?`,
    choices: [`선지${seed}a`, `선지${seed}b`, `선지${seed}c`, `선지${seed}d`, `선지${seed}e`],
    answer_index: 2,
    explanation: `${seed}번 문항의 해설이다.`,
    difficulty: 2,
    sub_topic_code: `T${seed % 3}`,
    concepts: [`개념${seed % 4}`],
    ...overrides,
  };
}

function selftest() {
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

  console.log('\n[계약 층] 전부 정상인 10회');
  {
    const runs = Array.from({ length: 10 }, (_, r) => ({
      ok: true,
      elapsedMs: 30000 + r,
      questions: Array.from({ length: 5 }, (_, i) => makeQuestion(r * 10 + i)),
    }));
    const s = summarizeGenerationRuns(runs, { requestedCount: 5 });
    check('완주율 1.0', s.completionRate === 1);
    check('스키마 준수율 1.0', s.contract.schemaValidRate === 1, String(s.contract.schemaValidRate));
    check('문항 수 정확 1.0', s.contract.countExactRate === 1);
    check('실행 안 중복 0', s.contract.withinRunDuplicateRate === 0);
    check('총 문항 50', s.contract.questionsTotal === 50);
    check('계약 판정 전부 통과', contractVerdicts(s).every((v) => v.pass),
      JSON.stringify(contractVerdicts(s).filter((v) => !v.pass)));
  }

  console.log('\n[층 분리] 형식 위반은 계약을 깨지 않는다');
  {
    // F01 금지 발문("가장 적절한")은 품질 문제지 자료구조 계약 위반이 아니다.
    const runs = [{
      ok: true,
      elapsedMs: 1000,
      questions: [makeQuestion(1, { stem: '55세 남자가 흉통으로 왔다. 가장 적절한 검사는?' })],
    }];
    const s = summarizeGenerationRuns(runs, { requestedCount: 1 });
    check('계약 준수율은 1.0 유지', s.contract.schemaValidRate === 1, String(s.contract.schemaValidRate));
    check('형식 위반은 분포 층에 기록', s.distribution.formatIssues === 1, String(s.distribution.formatIssues));
    check('형식 위반율', s.distribution.formatIssueRate === 1);
    check('형식 코드 집계', Object.keys(s.distribution.formatCodes).some((c) => c.startsWith('format:')),
      JSON.stringify(s.distribution.formatCodes));
    check('계약 판정은 통과', contractVerdicts(s).every((v) => v.pass));
  }

  console.log('\n[계약 층] 위반을 실제로 잡는가');
  {
    const runs = [
      // 선지 4개 = 계약 위반
      { ok: true, elapsedMs: 1000, questions: [makeQuestion(1, { choices: ['a', 'b', 'c', 'd'] })] },
      // 요청은 1개인데 2개 반환
      { ok: true, elapsedMs: 1000, questions: [makeQuestion(2), makeQuestion(3)] },
      // 실행 실패
      { ok: false, error: 'overloaded_error', elapsedMs: 500, questions: [] },
    ];
    const s = summarizeGenerationRuns(runs, { requestedCount: 1 });
    check('완주율 2/3', Math.abs(s.completionRate - 0.6667) < 1e-4, String(s.completionRate));
    check('오류 분포 기록', s.errors.overloaded_error === 1);
    check('스키마 위반 실행 탐지', s.contract.schemaValidRate === 0.5, String(s.contract.schemaValidRate));
    check('위반 코드 집계', s.contract.violationCodes['range:choices'] === 1,
      JSON.stringify(s.contract.violationCodes));
    check('문항 수 불일치 탐지', s.contract.countExactRate === 0.5, String(s.contract.countExactRate));
    check('실패 실행은 지연 분포에서 제외', s.elapsedMs.count === 2);
    const failed = contractVerdicts(s).filter((v) => !v.pass).map((v) => v.metric);
    check('계약 판정 3건 미달', failed.length === 3, JSON.stringify(failed));
  }

  console.log('\n[계약 층] 실행 안 중복');
  {
    const dup = makeQuestion(7);
    const runs = [{ ok: true, elapsedMs: 1000, questions: [dup, { ...dup }, makeQuestion(8)] }];
    const s = summarizeGenerationRuns(runs, { requestedCount: 3 });
    check('같은 문항 2개 중 1개를 중복으로 센다', s.contract.withinRunDuplicates === 1,
      String(s.contract.withinRunDuplicates));
    check('중복률 = 1/3', Math.abs(s.contract.withinRunDuplicateRate - 0.3333) < 1e-4);
  }

  console.log('\n[분포 층] 겹침과 개념 안정성');
  {
    // 두 실행이 완전히 같은 문항 → 겹침 1.0, 개념 Jaccard 1.0
    const same = [makeQuestion(1), makeQuestion(2)];
    const identical = summarizeGenerationRuns(
      [
        { ok: true, elapsedMs: 1, questions: same },
        { ok: true, elapsedMs: 1, questions: same.map((q) => ({ ...q })) },
      ],
      { requestedCount: 2 },
    );
    check('동일 산출 → 겹침 1.0', identical.distribution.crossRunOverlapMean === 1,
      String(identical.distribution.crossRunOverlapMean));
    check('동일 산출 → 개념 Jaccard 1.0', identical.distribution.conceptJaccardMean === 1);

    // 전혀 다른 문항 → 겹침 0
    const different = summarizeGenerationRuns(
      [
        { ok: true, elapsedMs: 1, questions: [makeQuestion(1)] },
        {
          ok: true,
          elapsedMs: 1,
          questions: [
            makeQuestion(2, {
              stem: '무릎 관절이 붓고 아픈 30세 여자에서 관절액 검사 소견으로 알맞은 것은?',
              concepts: ['전혀다른개념'],
              sub_topic_code: 'ZZZ',
            }),
          ],
        },
      ],
      { requestedCount: 1 },
    );
    check('다른 산출 → 겹침 0', different.distribution.crossRunOverlapMean === 0,
      String(different.distribution.crossRunOverlapMean));
    check('다른 산출 → 개념 Jaccard 0', different.distribution.conceptJaccardMean === 0);

    // 난이도 분포
    const mixed = summarizeGenerationRuns(
      [
        {
          ok: true,
          elapsedMs: 1,
          questions: [makeQuestion(1, { difficulty: 1 }), makeQuestion(2, { difficulty: 3 })],
        },
      ],
      { requestedCount: 2 },
    );
    check('난이도 평균 2', mixed.distribution.difficultyMean === 2);
    check('난이도 히스토그램', mixed.distribution.difficultyHistogram['1'] === 1
      && mixed.distribution.difficultyHistogram['3'] === 1);
  }

  console.log('\n[고정 입력]');
  {
    const fixtures = listFixtures();
    check(`${FIXTURE_DIR} 로드 (${fixtures.length}건)`, Array.isArray(fixtures));
    for (const f of fixtures) {
      check(`  ${f.id}: 필수 필드`,
        typeof f.id === 'string' && typeof f.sourceText === 'string' && f.sourceText.length > 200
          && typeof f.desiredCount === 'number',
        JSON.stringify(Object.keys(f)));
    }
    // 고정 입력이 아직 없어도 통과한다 — 구축 중에도 산식은 지켜져야 한다.
  }

  console.log(`\n통과 ${pass} · 실패 ${fail}`);
  if (fail > 0) process.exit(1);
  console.log(`문항 생성 반복 안정성 산식 selftest 통과 (같은 문항 판정 임계 ${SAME_QUESTION_SIMILARITY}).`);
}

// ───────── 실측 (모델 호출) ─────────

async function measure(fixture, runs) {
  const [{ default: Anthropic }, prompts] = await Promise.all([
    import('@anthropic-ai/sdk'),
    import('../lib/ai/prompts/private-generation.ts'),
  ]);
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const model = process.env.ANTHROPIC_GEN_MODEL ?? 'claude-sonnet-4-6';

  const catalog = fixture.subTopicCatalog ?? [
    { code: 'GEN01', name: '일반', subject_name: '공통' },
  ];
  const catalogText = catalog
    .map((c) => `  - ${c.subject_name} > ${c.name} (code: \`${c.code}\`)`)
    .join('\n');
  const systemPrompt = prompts.PRIVATE_GENERATION_SYSTEM_PROMPT.replace(
    '{SUB_TOPIC_CATALOG}',
    catalogText,
  );
  const userMessage = prompts.buildPrivateGenerationUserMessage({
    subTopicCatalog: catalog,
    desiredCount: fixture.desiredCount,
    style: fixture.style ?? 'kmle',
    topic: fixture.topic,
    keywords: fixture.keywords,
  });
  const userText =
    '다음은 필수 업로드 자료에서 추출한 출제 근거입니다.\n\n' +
    `${fixture.sourceText}\n\n${userMessage}`;

  const results = [];
  for (let i = 0; i < runs; i += 1) {
    const started = Date.now();
    try {
      const response = await client.messages.create({
        model,
        max_tokens: Math.min(16000, Math.max(6000, fixture.desiredCount * 1800)),
        system: [{ type: 'text', text: systemPrompt }],
        tools: [prompts.PRIVATE_GENERATION_TOOL_SCHEMA],
        tool_choice: { type: 'tool', name: 'generate_private_questions' },
        messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
      });
      const block = response.content.find((c) => c.type === 'tool_use');
      const questions = block?.input?.questions ?? [];
      results.push({ ok: true, error: null, elapsedMs: Date.now() - started, questions });
      console.log(`  [${i + 1}/${runs}] OK  ${Date.now() - started}ms · ${questions.length}문항`);
    } catch (error) {
      const message = `${error?.constructor?.name ?? 'Error'}: ${String(error?.message ?? error).slice(0, 120)}`;
      results.push({ ok: false, error: message, elapsedMs: Date.now() - started, questions: [] });
      console.log(`  [${i + 1}/${runs}] ERR ${message}`);
    }
  }
  return { model, results };
}

function printReport(fixture, model, stability) {
  const { contract: c, distribution: d } = stability;
  console.log('\n문항 생성 반복 안정성 (성능지표 가이드 §4.2)');
  console.log(`  고정 입력 : ${fixture.id} (요청 ${fixture.desiredCount}문항, style=${fixture.style ?? 'kmle'})`);
  console.log(`  모델      : ${model}`);
  console.log(`  실행      : ${stability.completed}/${stability.runs} 성공`
    + (Object.keys(stability.errors).length ? ` (${JSON.stringify(stability.errors)})` : ''));
  console.log('\n  ── 계약 (지켜져야 하는 것) ──');
  console.log(`  스키마 준수율      : ${c.schemaValidRate}  (문항 위반율 ${c.violationRate})`);
  if (Object.keys(c.violationCodes).length) console.log(`    위반 코드        : ${JSON.stringify(c.violationCodes)}`);
  console.log(`  요청 수 일치율     : ${c.countExactRate}  (${c.countMin}~${c.countMax}문항)`);
  console.log(`  실행 안 중복률     : ${c.withinRunDuplicateRate}  (${c.withinRunDuplicates}건)`);
  console.log('\n  ── 분포 (재기만 하는 것) ──');
  console.log(`  실행 간 문항 겹침  : ${d.crossRunOverlapMean}   (1에 가까울수록 재생성이 새 문항을 못 만든다)`);
  console.log(`  개념 Jaccard       : ${d.conceptJaccardMean}   (관측 개념 ${d.conceptsSeen}종)`);
  console.log(`  난이도             : 평균 ${d.difficultyMean} · 표준편차 ${d.difficultySd} · ${JSON.stringify(d.difficultyHistogram)}`);
  console.log(`  실행시간(ms)       : p50 ${stability.elapsedMs.p50} · p95 ${stability.elapsedMs.p95}`);
  console.log('\n  판정 (계약 층만):');
  for (const v of contractVerdicts(stability)) {
    console.log(`    [${v.pass ? '통과' : '미달'}] ${v.metric} = ${v.value} (기준 ${v.threshold})`);
    if (!v.pass) console.log(`           ${v.note}`);
  }
}

async function main() {
  if (has('list')) {
    const fixtures = listFixtures();
    if (fixtures.length === 0) {
      console.log(`${FIXTURE_DIR} 에 고정 입력이 없습니다. README 를 참고해 등록하세요.`);
      return;
    }
    for (const f of fixtures) {
      console.log(`  ${f.id.padEnd(28)} ${f.desiredCount}문항  ${f.subject ?? ''} — ${f.description ?? ''}`);
    }
    return;
  }
  if (has('selftest') || argv.length === 0) {
    selftest();
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY 가 필요합니다. 산식만 확인하려면 --selftest 를 쓰세요.');
    process.exit(2);
  }
  const fixtures = listFixtures();
  const id = flag('fixture');
  const fixture = id ? fixtures.find((f) => f.id === id) : fixtures[0];
  if (!fixture) {
    console.error(`고정 입력을 찾지 못했습니다${id ? ` (--fixture ${id})` : ''}. --list 로 확인하세요.`);
    process.exit(2);
  }
  const runs = Number(flag('runs', DEFAULT_RUNS));
  if (runs < 10) console.error(`경고: 가이드 §4.2 는 최소 10회를 요구합니다 (지금 ${runs}회).`);

  const { model, results } = await measure(fixture, runs);
  const stability = summarizeGenerationRuns(results, { requestedCount: fixture.desiredCount });
  printReport(fixture, model, stability);

  const out = flag('out');
  if (out) {
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify({ fixtureId: fixture.id, model, stability, results }, null, 2)}\n`);
    console.log(`\n결과 저장: ${out}`);
  }
  process.exit(contractVerdicts(stability).every((v) => v.pass) ? 0 : 1);
}

main();
