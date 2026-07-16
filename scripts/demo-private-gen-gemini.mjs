// @ts-check
/**
 * 데모 (Gemini 무료 API 버전): PDF·이미지 → Gemini → 예상문제 생성
 *
 * Anthropic 키가 없을 때 무료로 빠르게 테스트하는 용도.
 * 프로덕션 코드는 Anthropic Claude 를 쓰지만, 출력 품질의 방향성을 보는 데에는
 * Gemini 2.5 Flash 도 충분히 가늠됨.
 *
 * API 키 발급 (무료, 신용카드 없음):
 *   https://aistudio.google.com/apikey
 *
 * 사용:
 *   $env:GEMINI_API_KEY="AIza..."
 *   node scripts/demo-private-gen-gemini.mjs <파일경로> [--count 12] [--style professor]
 *
 * 지원 파일: PDF, PNG, JPG/JPEG, WebP (인라인 20MB 이하)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname, basename } from 'node:path';

// ───────── CLI ─────────
const args = process.argv.slice(2);
const filePath = args[0];
const countIdx = args.indexOf('--count');
const styleIdx = args.indexOf('--style');
const desiredCount = countIdx >= 0 ? parseInt(args[countIdx + 1], 10) : 12;
const style = styleIdx >= 0 ? args[styleIdx + 1] : 'professor';

if (!filePath) {
  console.error('사용: node scripts/demo-private-gen-gemini.mjs <파일경로> [--count N] [--style kmle|professor|internal]');
  process.exit(1);
}
if (!existsSync(filePath)) {
  console.error(`파일 없음: ${filePath}`);
  process.exit(1);
}
if (!process.env.GEMINI_API_KEY) {
  console.error('환경변수 GEMINI_API_KEY 가 설정되지 않았습니다.');
  console.error('  발급:       https://aistudio.google.com/apikey (Google 계정 로그인 후 Create API key)');
  console.error('  PowerShell: $env:GEMINI_API_KEY="AIza..."');
  console.error('  Bash:       export GEMINI_API_KEY=AIza...');
  process.exit(1);
}

// ───────── MIME ─────────
const ext = extname(filePath).toLowerCase();
let mime = null;
if (ext === '.pdf') mime = 'application/pdf';
else if (ext === '.png') mime = 'image/png';
else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
else if (ext === '.webp') mime = 'image/webp';
if (!mime) {
  console.error(`지원하지 않는 확장자: ${ext}. PDF·PNG·JPG·WebP만.`);
  process.exit(1);
}

const fileBuf = readFileSync(resolve(filePath));
if (fileBuf.length > 20 * 1024 * 1024) {
  console.error(`파일이 20MB 초과 (${(fileBuf.length / 1_000_000).toFixed(1)}MB). 인라인 업로드 한도 초과.`);
  console.error('Gemini Files API 가 필요하지만 데모 스크립트는 인라인만 지원함.');
  process.exit(1);
}
const base64 = fileBuf.toString('base64');
const sizeMB = (fileBuf.length / 1_000_000).toFixed(2);

console.log(`\n📄 ${basename(filePath)} (${sizeMB} MB, ${mime})`);
console.log(`🎯 생성 문항 ${desiredCount}개 · 스타일: ${style}\n`);

// ───────── 카탈로그 ─────────
const CATALOG = [
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

const ALLOWED_CODES = CATALOG.map((c) => c.code);

// ───────── 프롬프트 ─────────
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
각 문항을 다음 sub_topic 카탈로그 중 하나의 \`code\` 로 분류 (자료가 다루는 영역에 맞춰):
${catalogText}

문항이 카탈로그의 어디에도 속하지 않으면 \`sub_topic_code\` 를 빈 문자열 "" 로 설정.

## KMLE 포맷
- Long clinical vignette + 5지선다 + "가장 적절한 X 는?" 형식
- 함정 선지 포함, 정답 노출 단서 없게
- 한국어, 의학 용어는 한국어 + 영문 병기
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

## 요구사항
- 자료에서 다루는 핵심 개념 위주로 평가
- 자료 전체에서 다양한 챕터·섹션 커버 (한 영역에 집중 X)
- 각 문항을 카탈로그의 sub_topic_code 로 분류 (매칭 안 되면 빈 문자열 "")
- 자료에 명시되지 않은 정보를 추측해서 추가 금지
- choices 는 정확히 5개

## 이미지 참조 (중요)
- 문항이 자료의 **그림·표·차트·X-ray·ECG·병리사진·다이어그램** 등 시각자료를 활용해야 학습 효과가 큰 경우, 해당 페이지를 명시:
  - \`source_page\`: 자료에서 그 시각자료가 있는 **1-base 페이지 번호** (정수)
  - \`image_description\`: 어떤 시각자료인지 한 줄 설명 (예: "12-lead ECG", "흉부 PA 영상", "기관지 해부도")
- 문항이 순수 텍스트 기반(개념 설명·정의·치료원칙 등)이면 \`source_page\` = 0, \`image_description\` = "" 로 설정
- 시각자료를 참조하는 문항이 전체의 30~50% 정도 되도록 균형 유지

JSON 으로 반환.
`.trim();

// Gemini responseSchema — JSON Schema subset
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    content_summary: {
      type: 'string',
      description: '자료가 다루는 주요 영역의 한 줄 요약',
    },
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          stem: { type: 'string' },
          choices: {
            type: 'array',
            items: { type: 'string' },
          },
          answer_index: { type: 'integer' },
          explanation: { type: 'string' },
          concepts: { type: 'array', items: { type: 'string' } },
          difficulty: { type: 'integer' },
          sub_topic_code: {
            type: 'string',
            description: '카탈로그 code. 매칭 안 되면 빈 문자열.',
          },
          source_page: {
            type: 'integer',
            description: '시각자료가 있는 1-base 페이지 번호. 순수 텍스트 문항이면 0.',
          },
          image_description: {
            type: 'string',
            description: '참조 시각자료 한 줄 설명. 없으면 빈 문자열.',
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
          'source_page',
          'image_description',
        ],
        propertyOrdering: [
          'stem',
          'choices',
          'answer_index',
          'explanation',
          'concepts',
          'difficulty',
          'sub_topic_code',
          'source_page',
          'image_description',
        ],
      },
    },
  },
  required: ['content_summary', 'questions'],
  propertyOrdering: ['content_summary', 'questions'],
};

// ───────── 호출 ─────────
const model = process.env.GEMINI_MODEL ?? 'gemini-2.5-flash';
const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY}`;

console.log(`⏳ ${model} 호출 중... (Gemini 무료 등급)\n`);
const startMs = Date.now();

const requestBody = {
  systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
  contents: [
    {
      parts: [
        { inlineData: { mimeType: mime, data: base64 } },
        { text: USER_MESSAGE },
      ],
    },
  ],
  generationConfig: {
    responseMimeType: 'application/json',
    responseSchema: RESPONSE_SCHEMA,
    maxOutputTokens: 16000,
    temperature: 0.6,
  },
};

let response;
try {
  const httpRes = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody),
  });
  if (!httpRes.ok) {
    const errText = await httpRes.text();
    console.error(`❌ Gemini HTTP ${httpRes.status}: ${errText}`);
    process.exit(1);
  }
  response = await httpRes.json();
} catch (err) {
  console.error('❌ Gemini 호출 실패');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const durationMs = Date.now() - startMs;

// ───────── 응답 파싱 ─────────
const candidate = response.candidates?.[0];
const textPart = candidate?.content?.parts?.[0]?.text;
if (!textPart) {
  console.error('❌ Gemini 응답에 text part 가 없음');
  console.error(JSON.stringify(response, null, 2).slice(0, 2000));
  process.exit(1);
}

let parsed;
try {
  parsed = JSON.parse(textPart);
} catch (e) {
  console.error('❌ JSON 파싱 실패');
  console.error(textPart.slice(0, 1500));
  process.exit(1);
}

if (!Array.isArray(parsed.questions)) {
  console.error('❌ questions 필드 누락');
  console.error(JSON.stringify(parsed, null, 2).slice(0, 1500));
  process.exit(1);
}

// ───────── 페이지 이미지 추출 ─────────
// 자동 추출은 npm 패키지(pdfjs-dist+canvas) 필요한데,
// OneDrive + 한글 경로 환경에서 node_modules 로딩이 access violation 크래시.
// 대안: AI 가 알려준 page number 를 출력에 명시 → 사용자가 PDF 를 직접 그 페이지로.
// (장기 해결책: 프로젝트를 ASCII 경로로 이동, 또는 OneDrive 외부로)
const pageImagePaths = new Map(); // 항상 빈 맵

// ───────── 출력 ─────────
const usage = response.usageMetadata ?? {};
const inputTokens = usage.promptTokenCount ?? 0;
const outputTokens = usage.candidatesTokenCount ?? 0;

const unmatched = parsed.questions.filter(
  (q) => !q.sub_topic_code || !ALLOWED_CODES.includes(q.sub_topic_code),
).length;
const valid = parsed.questions.length - unmatched;
const withImage = parsed.questions.filter((q) => q.source_page > 0).length;

console.log('═══════════════════════════════════════════════════════════');
console.log('📊 결과 요약');
console.log('───────────────────────────────────────────────────────────');
console.log(`  생성 문항      : ${parsed.questions.length}개`);
console.log(`  이미지 참조    : ${withImage}개 (${Math.round((withImage / parsed.questions.length) * 100)}%)`);
console.log(`  미분류/오분류  : ${unmatched}개`);
console.log(`  유효 분류      : ${valid}개`);
console.log(`  소요 시간      : ${(durationMs / 1000).toFixed(1)}초`);
console.log(`  토큰 (입/출)   : ${inputTokens} / ${outputTokens}`);
console.log('  비용           : Free tier (Gemini 2.5 Flash 무료 등급)');
console.log('═══════════════════════════════════════════════════════════\n');

console.log(`📝 자료 요약: ${parsed.content_summary}\n`);

parsed.questions.forEach((q, i) => {
  const sub = CATALOG.find((c) => c.code === q.sub_topic_code);
  const subjLabel = sub ? `[${sub.subject_name} > ${sub.name}]` : '[미분류]';
  console.log(`───────────────────────── 문항 ${i + 1} / ${parsed.questions.length} ─────────────────────────`);
  console.log(`${subjLabel}  난이도: ${'★'.repeat(Math.min(3, Math.max(1, q.difficulty || 1)))}  개념: ${(q.concepts || []).join(', ')}`);
  if (q.source_page > 0) {
    console.log(`🖼️  이미지 참조: PDF p.${q.source_page} · ${q.image_description}`);
    console.log(`    ↳ (PDF 를 직접 열어서 ${q.source_page}페이지를 보면 이 문항이 참조하는 시각자료가 있음)`);
  }
  console.log('');
  console.log(q.stem);
  console.log('');
  (q.choices || []).forEach((c, idx) => {
    const marker = idx === q.answer_index ? '✓' : ' ';
    console.log(`  ${marker} ${idx + 1}. ${c}`);
  });
  console.log('');
  console.log(`해설: ${q.explanation}`);
  console.log('');
});

console.log('═══════════════════════════════════════════════════════════');
console.log('✅ 완료. 생성 문항이 적절한지 검토해주세요.');
console.log('');
console.log('  ※ 프로덕션 서비스는 Anthropic Claude Sonnet 4.6 사용 예정.');
console.log('     Gemini 결과는 방향성 검증용이며 실제 품질은 더 높을 것으로 예상.');
console.log('═══════════════════════════════════════════════════════════\n');
