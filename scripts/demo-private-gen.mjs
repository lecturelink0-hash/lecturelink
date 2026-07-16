// @ts-check
/**
 * 데모: PDF·이미지 → Claude → 예상문제 12개 생성
 *
 * Supabase·인증·UI 다 우회하고 AI 생성 파이프라인만 검증.
 *
 * 사용:
 *   $env:ANTHROPIC_API_KEY="sk-ant-..."
 *   node scripts/demo-private-gen.mjs <파일경로> [--count 12] [--style professor]
 *
 * 지원 파일: PDF, PNG, JPG/JPEG, WebP
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';

// Anthropic SDK 를 우회하고 fetch 로 직접 호출.
// (SDK 가 한글 경로 + OneDrive 환경에서 native crash 발생하기 때문)

// ───────── CLI 파싱 ─────────
const args = process.argv.slice(2);
const filePath = args[0];
const countIdx = args.indexOf('--count');
const styleIdx = args.indexOf('--style');
const desiredCount = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) : 12;
const style =
  styleIdx >= 0 ? args[styleIdx + 1] : 'professor'; // 'kmle' | 'professor' | 'internal'

if (!filePath) {
  console.error('사용: node scripts/demo-private-gen.mjs <파일경로> [--count N] [--style kmle|professor|internal]');
  process.exit(1);
}
if (!existsSync(filePath)) {
  console.error(`파일 없음: ${filePath}`);
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('환경변수 ANTHROPIC_API_KEY 가 설정되지 않았습니다.');
  console.error('  PowerShell: $env:ANTHROPIC_API_KEY="sk-ant-..."');
  console.error('  Bash:       export ANTHROPIC_API_KEY=sk-ant-...');
  process.exit(1);
}

// ───────── MIME 매핑 ─────────
const ext = extname(filePath).toLowerCase();
/** @type {'application/pdf'|'image/png'|'image/jpeg'|'image/webp'|null} */
let mime = null;
if (ext === '.pdf') mime = 'application/pdf';
else if (ext === '.png') mime = 'image/png';
else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
else if (ext === '.webp') mime = 'image/webp';
if (!mime) {
  console.error(`지원하지 않는 확장자: ${ext}. PDF·PNG·JPG·WebP만 됨.`);
  process.exit(1);
}

const fileBuf = readFileSync(resolve(filePath));
const base64 = fileBuf.toString('base64');
const sizeMB = (fileBuf.length / 1_000_000).toFixed(2);

console.log(`\n📄 ${basename(filePath)} (${sizeMB} MB, ${mime})`);
console.log(`🎯 생성 문항 ${desiredCount}개 · 스타일: ${style}\n`);

// ───────── Sub-topic 카탈로그 (00003_master_seed.sql 인라인) ─────────
const CATALOG = [
  // 호흡기학
  { code: 'respiratory_physiology', name: '호흡 생리', subject_name: '호흡기학' },
  { code: 'copd_asthma', name: '폐쇄성 폐질환 (COPD·천식)', subject_name: '호흡기학' },
  { code: 'restrictive_lung', name: '제한성 폐질환', subject_name: '호흡기학' },
  { code: 'pneumothorax', name: '기흉', subject_name: '호흡기학' },
  { code: 'pleural_effusion', name: '흉수', subject_name: '호흡기학' },
  { code: 'pulmonary_embolism', name: '폐색전', subject_name: '호흡기학' },
  { code: 'lung_cancer', name: '폐암', subject_name: '호흡기학' },
  { code: 'lung_pathology', name: '폐 병리학', subject_name: '호흡기학' },
  { code: 'lung_anatomy', name: '폐 해부·조직학', subject_name: '호흡기학' },
  { code: 'mediastinal', name: '종격동 질환', subject_name: '호흡기학' },
  { code: 'chest_xray', name: '흉부 X-ray 판독', subject_name: '호흡기학' },
  // 순환기학
  { code: 'ecg', name: 'ECG 판독', subject_name: '순환기학' },
  { code: 'arrhythmia', name: '부정맥', subject_name: '순환기학' },
  { code: 'heart_failure', name: '심부전', subject_name: '순환기학' },
  { code: 'cad', name: '관상동맥질환', subject_name: '순환기학' },
  { code: 'valvular', name: '판막질환', subject_name: '순환기학' },
  { code: 'hypertension', name: '고혈압', subject_name: '순환기학' },
  { code: 'cardiomyopathy', name: '심근병증', subject_name: '순환기학' },
  { code: 'pericardial', name: '심막질환', subject_name: '순환기학' },
  { code: 'congenital_heart', name: '선천성 심질환', subject_name: '순환기학' },
];

const catalogText = CATALOG.map(
  (c) => `  - ${c.subject_name} > ${c.name} (code: \`${c.code}\`)`,
).join('\n');

// ───────── 프롬프트 (prompts/private-generation.ts 인라인) ─────────
const SYSTEM_PROMPT = `
You are a Korean medical education content specialist generating personalized practice questions from a student's lecture materials.

## 역할

학생이 업로드한 강의자료(PDF, 슬라이드, 이미지 등)를 분석하여 학생 본인의 학습용 KMLE 스타일 문항을 생성한다.

## 절대 원칙

1. **자료 기반**: 업로드된 자료의 *실제 내용*에 근거한 문항만 생성. 자료에 없는 내용 추가 금지.
2. **교수 강조점 반영**: 자료에서 굵게 표시·반복 강조·표·다이어그램으로 강조된 내용을 우선.
3. **의학적 정확성**: 자료의 의학적 사실을 검증된 수준에서 변형. 잘못된 사실을 만들지 않음.
4. **개인용**: 본인만 보는 콘텐츠이므로 정직하게 작성. 자료가 모호하면 그 모호함을 인정.

## 분류

각 문항을 다음 sub_topic 카탈로그 중 하나로 분류 (자료가 다루는 영역에 맞춰):

${catalogText}

문항이 카탈로그의 어디에도 속하지 않으면 \`sub_topic_code\` 를 null 로 설정.

## KMLE 포맷

- Long clinical vignette + 5지선다 + "가장 적절한 X 는?" 형식
- 함정 선지 포함, 정답 노출 단서 없게
- 한국어, 의학 용어는 한국어 + 영문 병기

## 출력

generate_private_questions 도구로 응답. 한 번에 10~15 문항.
`.trim();

const styleDesc =
  style === 'kmle'
    ? 'KMLE(국가고시) 스타일 — 표준 임상 vignette'
    : style === 'professor'
      ? '교수 강의 스타일 — 강의 내용 심화'
      : '내신 시험 스타일 — 학교 정기시험 수준';

const USER_MESSAGE = `
업로드된 자료를 기반으로 ${desiredCount}개의 의학 문항을 생성하세요.

## 스타일
${styleDesc}

## 분류 카탈로그
${catalogText}

## 요구사항
- 자료에서 다루는 핵심 개념 위주로 평가
- 자료 전체에서 다양한 챕터·섹션 커버 (한 영역에 집중 X)
- 각 문항을 카탈로그의 sub_topic_code 로 분류
- 자료에 명시되지 않은 정보를 추측해서 추가 금지

generate_private_questions 도구로 응답하세요.
`.trim();

const TOOL_SCHEMA = {
  name: 'generate_private_questions',
  description: '사용자 자료 기반 개인 문항을 생성하여 반환합니다.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            stem: { type: 'string' },
            choices: {
              type: 'array',
              items: { type: 'string' },
              minItems: 5,
              maxItems: 5,
            },
            answer_index: { type: 'integer', minimum: 0, maximum: 4 },
            explanation: { type: 'string' },
            concepts: {
              type: 'array',
              items: { type: 'string' },
            },
            difficulty: { type: 'integer', minimum: 1, maximum: 3 },
            sub_topic_code: {
              type: ['string', 'null'],
              description: '카탈로그의 sub_topic code. 매칭 안 되면 null.',
            },
          },
          required: [
            'stem',
            'choices',
            'answer_index',
            'explanation',
            'concepts',
            'difficulty',
            'sub_topic_code',
          ],
        },
      },
      content_summary: {
        type: 'string',
        description: '자료가 다루는 주요 영역의 한 줄 요약',
      },
    },
    required: ['questions', 'content_summary'],
  },
};

// ───────── 비용 계산 ─────────
const PRICING = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cache_read: 0.3, cache_write: 3.75 },
};

function calcCost(model, inT, outT, cacheRead = 0, cacheWrite = 0) {
  const p = PRICING[model] ?? PRICING['claude-sonnet-4-6'];
  return (
    (inT * p.input + outT * p.output + cacheRead * p.cache_read + cacheWrite * p.cache_write) /
    1_000_000
  );
}

// ───────── Anthropic 호출 (fetch 직접) ─────────
const model = process.env.ANTHROPIC_GEN_MODEL ?? 'claude-sonnet-4-6';

console.log(`⏳ ${model} 호출 중...\n`);
const startMs = Date.now();

const userContent =
  mime === 'application/pdf'
    ? [
        {
          type: 'document',
          source: { type: 'base64', media_type: mime, data: base64 },
        },
        { type: 'text', text: USER_MESSAGE },
      ]
    : [
        {
          type: 'image',
          source: { type: 'base64', media_type: mime, data: base64 },
        },
        { type: 'text', text: USER_MESSAGE },
      ];

const requestBody = {
  model,
  max_tokens: 16000,
  system: [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ],
  tools: [TOOL_SCHEMA],
  tool_choice: { type: 'tool', name: 'generate_private_questions' },
  messages: [{ role: 'user', content: userContent }],
};

let response;
try {
  const httpRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(requestBody),
  });
  if (!httpRes.ok) {
    const errText = await httpRes.text();
    console.error(`❌ Anthropic HTTP ${httpRes.status}: ${errText}`);
    process.exit(1);
  }
  response = await httpRes.json();
} catch (err) {
  console.error('❌ Anthropic 호출 실패');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const durationMs = Date.now() - startMs;

// ───────── 결과 파싱 ─────────
const toolBlock = response.content.find((b) => b.type === 'tool_use');
if (!toolBlock) {
  console.error('❌ tool_use 응답 블록을 찾지 못함');
  console.error(JSON.stringify(response.content, null, 2));
  process.exit(1);
}

/**
 * @type {{
 *   questions: Array<{
 *     stem: string, choices: string[], answer_index: number,
 *     explanation: string, concepts: string[],
 *     difficulty: 1|2|3, sub_topic_code: string|null,
 *   }>,
 *   content_summary: string,
 * }}
 */
const parsed = toolBlock.input;

// ───────── 출력 ─────────
const cost = calcCost(
  model,
  response.usage.input_tokens,
  response.usage.output_tokens,
  response.usage.cache_read_input_tokens ?? 0,
  response.usage.cache_creation_input_tokens ?? 0,
);

const unmatched = parsed.questions.filter((q) => !q.sub_topic_code).length;
const valid = parsed.questions.filter((q) =>
  q.sub_topic_code ? CATALOG.some((c) => c.code === q.sub_topic_code) : true,
).length;

console.log('═══════════════════════════════════════════════════════════');
console.log(`📊 결과 요약`);
console.log('───────────────────────────────────────────────────────────');
console.log(`  생성 문항      : ${parsed.questions.length}개`);
console.log(`  미분류         : ${unmatched}개 (카탈로그에 없는 영역)`);
console.log(`  유효 분류      : ${valid}개`);
console.log(`  소요 시간      : ${(durationMs / 1000).toFixed(1)}초`);
console.log(`  토큰 (입/출)   : ${response.usage.input_tokens} / ${response.usage.output_tokens}`);
console.log(`  비용 (USD)     : $${cost.toFixed(4)} (≈ ₩${Math.round(cost * 1370)})`);
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`📝 자료 요약: ${parsed.content_summary}\n`);

parsed.questions.forEach((q, i) => {
  const sub = CATALOG.find((c) => c.code === q.sub_topic_code);
  const subjLabel = sub ? `[${sub.subject_name} > ${sub.name}]` : '[미분류]';
  console.log(`───────────────────────── 문항 ${i + 1} / ${parsed.questions.length} ─────────────────────────`);
  console.log(`${subjLabel}  난이도: ${'★'.repeat(q.difficulty)}  개념: ${q.concepts.join(', ')}`);
  console.log('');
  console.log(q.stem);
  console.log('');
  q.choices.forEach((c, idx) => {
    const marker = idx === q.answer_index ? '✓' : ' ';
    console.log(`  ${marker} ${idx + 1}. ${c}`);
  });
  console.log('');
  console.log(`해설: ${q.explanation}`);
  console.log('');
});

console.log('═══════════════════════════════════════════════════════════');
console.log('✅ 완료. 위 문항들이 적절한지 검토해주세요.');
console.log('═══════════════════════════════════════════════════════════\n');
