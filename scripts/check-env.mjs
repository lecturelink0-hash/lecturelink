// @ts-check
/**
 * Pre-flight 환경변수 검증.
 *
 * 외부 호출 없이 환경변수가 (a) 비어 있지 않은지, (b) 명백한 placeholder 가
 * 그대로 남아 있지 않은지, (c) 의도된 형식인지 정적으로 검사한다.
 *
 * 사용:
 *   1) 로컬:        node scripts/check-env.mjs
 *      → .env.local 을 읽음 (파일 없으면 process.env 사용).
 *   2) Vercel 등 배포 env:
 *      vercel env pull .env.production.local
 *      node scripts/check-env.mjs --file .env.production.local --prod
 *
 * 옵션:
 *   --file <path>   대상 .env 파일 (기본: .env.local)
 *   --prod          production 모드. ALLOW_UNSIGNED_* 가 켜져 있으면 FAIL.
 *
 * 종료 코드:
 *   0 = 모든 필수 변수 OK
 *   1 = 누락 또는 placeholder 잔존 (배포 차단)
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');

// ───── 인자 파싱
const argv = process.argv.slice(2);
const fileIdx = argv.indexOf('--file');
const envFile = fileIdx >= 0 ? argv[fileIdx + 1] : '.env.local';
const isProd = argv.includes('--prod');

// ───── .env 파일 로드 (가벼운 파서, dotenv 의존 없음)
function loadEnvFile(path) {
  const abs = resolve(ROOT, path);
  if (!existsSync(abs)) return {};
  const txt = readFileSync(abs, 'utf8');
  const out = {};
  for (const raw of txt.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // 양 끝 따옴표 제거
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

const fromFile = loadEnvFile(envFile);
// 우선순위: 파일 > process.env (파일이 있는 경우 파일이 진실)
const env = existsSync(resolve(ROOT, envFile))
  ? { ...process.env, ...fromFile }
  : { ...process.env };

// ───── 검증 규칙 정의
/**
 * @typedef {Object} Rule
 * @property {string} name
 * @property {'required' | 'optional' | 'forbidden-in-prod'} kind
 * @property {RegExp=} pattern         값이 매칭돼야 하는 형식 (예: 시작 prefix)
 * @property {string[]=} placeholders  값에 들어 있으면 미입력으로 판정할 부분 문자열
 * @property {string} purpose          누락 시 영향 한 줄
 */

/** @type {Rule[]} */
const RULES = [
  // Supabase
  {
    name: 'NEXT_PUBLIC_SUPABASE_URL',
    kind: 'required',
    pattern: /^https:\/\/.+\.supabase\.co\/?$/,
    placeholders: ['your-project-ref'],
    purpose: 'Supabase 서버 주소. 누락 시 모든 DB 호출 실패.',
  },
  {
    name: 'NEXT_PUBLIC_SUPABASE_ANON_KEY',
    kind: 'required',
    pattern: /^eyJ/,
    placeholders: ['eyJxxxx'],
    purpose: '브라우저용 anon key. 누락 시 로그인 화면이 안 뜸.',
  },
  {
    name: 'SUPABASE_SERVICE_ROLE_KEY',
    kind: 'required',
    pattern: /^eyJ/,
    placeholders: ['eyJxxxx'],
    purpose: '서버 전용 admin key. 누락 시 API 라우트 전부 깨짐.',
  },

  // AI 제공자 — 기본 모델은 gemini-2.5-flash
  {
    name: 'AI_PROVIDER',
    kind: 'optional',
    purpose: "미설정 시 'gemini' — 생성·검증·Vision·OCR 이 모두 gemini-2.5-flash 로 돈다.",
  },
  {
    name: 'GEMINI_API_KEY',
    kind: 'optional',
    purpose: '기본 제공자(gemini)의 API key. 누락 시 문항 생성/검증/OCR 실패.',
  },
  {
    name: 'GEMINI_GEN_MODEL',
    kind: 'optional',
    purpose: '미설정 시 gemini-2.5-flash 사용(기본 모델).',
  },

  // Anthropic — AI_PROVIDER=anthropic 일 때만 쓰이는 대체 경로
  {
    name: 'ANTHROPIC_API_KEY',
    kind: 'required',
    pattern: /^sk-ant-/,
    placeholders: ['sk-ant-xxxx'],
    purpose: 'Claude API key. AI_PROVIDER=anthropic 경로와 SDK 래퍼 초기화에 쓰인다.',
  },
  {
    name: 'ANTHROPIC_GEN_MODEL',
    kind: 'optional',
    purpose: 'AI_PROVIDER=anthropic 일 때만 유효. 미설정 시 claude-sonnet-4-6 사용.',
  },
  {
    name: 'ANTHROPIC_TIMEOUT_MS',
    kind: 'optional',
    pattern: /^\d+$/,
    purpose: '미설정 시 60000 (60s).',
  },

  // Voyage
  {
    name: 'VOYAGE_API_KEY',
    kind: 'required',
    pattern: /^pa-/,
    placeholders: ['pa-xxxx'],
    purpose: '임베딩 API key. 누락 시 추천/유사문항 검색 실패.',
  },
  {
    name: 'VOYAGE_EMBED_DIM',
    kind: 'optional',
    pattern: /^1024$/,
    purpose: 'DB schema 가 1024 차원으로 고정. 다른 값이면 RPC 실패.',
  },

  // Toss
  {
    name: 'TOSSPAYMENTS_CLIENT_KEY',
    kind: 'required',
    placeholders: ['test_ck_xxxx'],
    purpose: '결제 위젯 client key. 누락 시 결제 화면 안 뜸.',
  },
  {
    name: 'TOSSPAYMENTS_SECRET_KEY',
    kind: 'required',
    placeholders: ['test_sk_xxxx'],
    purpose: '결제 승인 secret. 누락 시 결제 confirm 실패.',
  },
  {
    name: 'TOSSPAYMENTS_WEBHOOK_SECRET',
    kind: 'required',
    placeholders: ['whsec_xxxx'],
    purpose: 'Webhook 서명 검증. 누락 시 결제 webhook 침묵 무시 + ops_alerts critical.',
  },

  // QStash
  {
    name: 'QSTASH_TOKEN',
    kind: 'required',
    placeholders: ['qstash_xxxx'],
    purpose: '큐 발행 token. 누락 시 업로드가 inline 모드로 fallback (큰 파일 timeout).',
  },
  {
    name: 'QSTASH_TARGET_URL',
    kind: 'required',
    pattern: /^https:\/\/.+\/api\/queue\/process-upload$/,
    placeholders: ['your-host.example.com'],
    purpose: '큐 target URL. 누락 시 inline 모드로 fallback.',
  },
  {
    name: 'QSTASH_CURRENT_SIGNING_KEY',
    kind: 'required',
    placeholders: ['sig_xxxx'],
    purpose: 'QStash 서명 검증. 누락 시 큐 라우트 401.',
  },
  {
    name: 'QSTASH_NEXT_SIGNING_KEY',
    kind: 'required',
    placeholders: ['sig_xxxx'],
    purpose: 'QStash 다음 키 (로테이션용). 누락 시 키 교체 시 다운타임.',
  },

  // 앱 설정
  {
    name: 'NEXT_PUBLIC_APP_URL',
    kind: 'required',
    pattern: /^https?:\/\/.+/,
    purpose: 'OAuth 콜백 / 메일 링크에 사용. 누락 시 로그인 redirect 깨짐.',
  },
  {
    name: 'MAX_DAILY_AI_COST_USD',
    kind: 'optional',
    pattern: /^\d+(\.\d+)?$/,
    purpose: '미설정 시 100 USD 캡 적용.',
  },

  // 운영자·개인정보 국외이전 고지는 실제 운영값이 없으면 공개할 수 없다.
  ...[
    ['LEGAL_BUSINESS_NAME', '서비스 운영 주체명'],
    ['LEGAL_REPRESENTATIVE', '대표자명'],
    ['LEGAL_BUSINESS_ADDRESS', '사업장 주소'],
    ['LEGAL_SUPPORT_EMAIL', '이용자·개인정보 문의 이메일'],
    ['LEGAL_PRIVACY_OFFICER', '개인정보 보호책임자'],
    ['LEGAL_SUPABASE_REGION', 'Supabase 개인정보 처리 국가'],
    ['LEGAL_VERCEL_REGION', 'Vercel 개인정보 처리 국가'],
    ['LEGAL_GOOGLE_REGION', 'Google AI 개인정보 처리 국가'],
    ['LEGAL_ANTHROPIC_REGION', 'Anthropic 개인정보 처리 국가'],
    ['LEGAL_VOYAGE_REGION', 'Voyage AI 개인정보 처리 국가'],
    ['LEGAL_UPSTASH_REGION', 'Upstash 개인정보 처리 국가'],
    ['LEGAL_CPX_REGION', 'CPX 서비스 개인정보 처리 국가'],
  ].map(([name, purpose]) => ({
    name,
    kind: isProd ? 'required' : 'optional',
    placeholders: ['등록 전', '정보 등록 전'],
    purpose: `${purpose}. 운영 고지에 실제 값 필요.`,
  })),
  ...[
    ['LEGAL_BUSINESS_REGISTRATION_NUMBER', '사업자등록번호'],
    ['LEGAL_MAIL_ORDER_NUMBER', '통신판매업 신고번호'],
    ['LEGAL_SUPPORT_PHONE', '고객지원 전화번호'],
  ].map(([name, purpose]) => ({
    name,
    kind: isProd && env.PAID_SALES_ENABLED === 'true' ? 'required' : 'optional',
    purpose: `${purpose}. 유료 판매 개시 전에 필요.`,
  })),

  // 개발 모드 우회 — production 에서 켜져 있으면 보안 사고
  {
    name: 'ALLOW_UNSIGNED_TOSS_WEBHOOK',
    kind: 'forbidden-in-prod',
    purpose: '로컬 개발 우회 플래그. production 에 1 로 설정되면 webhook 서명 검증 우회.',
  },
  {
    name: 'ALLOW_UNSIGNED_QSTASH',
    kind: 'forbidden-in-prod',
    purpose: '로컬 개발 우회 플래그. production 에 1 로 설정되면 QStash 서명 검증 우회.',
  },
];

// ───── 검사 실행
const findings = []; // { level, name, message }
function add(level, name, message) {
  findings.push({ level, name, message });
}

for (const rule of RULES) {
  const raw = env[rule.name];
  const value = (raw ?? '').trim();
  const isEmpty = value === '';

  // 1) forbidden-in-prod: production 에 켜져 있으면 FAIL
  if (rule.kind === 'forbidden-in-prod') {
    if (isProd && value === '1') {
      add('error', rule.name, `production 에 1 로 설정됨 — ${rule.purpose}`);
    }
    continue;
  }

  // 2) required 누락
  if (rule.kind === 'required' && isEmpty) {
    add('error', rule.name, `누락 — ${rule.purpose}`);
    continue;
  }

  // 3) optional 누락은 무시 (기본값 안내만)
  if (rule.kind === 'optional' && isEmpty) continue;

  // 4) placeholder 검사 (.env.example 의 dummy 값이 그대로 들어간 경우)
  if (rule.placeholders) {
    for (const ph of rule.placeholders) {
      if (value.includes(ph)) {
        add(
          'error',
          rule.name,
          `placeholder 값(${ph}) 이 그대로 남음 — ${rule.purpose}`,
        );
        break;
      }
    }
  }

  // 5) pattern 검사
  if (rule.pattern && !rule.pattern.test(value)) {
    const lvl = rule.kind === 'optional' ? 'warn' : 'error';
    add(
      lvl,
      rule.name,
      `형식 불일치 (기대: ${rule.pattern}) — 값 시작: '${value.slice(0, 12)}…'`,
    );
  }
}

// ───── 출력
const errors = findings.filter((f) => f.level === 'error');
const warns = findings.filter((f) => f.level === 'warn');

const checked = RULES.length;
const ok = checked - errors.length - warns.length;

console.log(`\n환경변수 검증 결과 (${isProd ? 'production' : 'dev'} 모드)`);
console.log(`대상 파일: ${envFile} (${existsSync(resolve(ROOT, envFile)) ? '발견' : '없음, process.env 사용'})\n`);

if (errors.length === 0 && warns.length === 0) {
  console.log(`✓ 검사 항목 ${checked}/${checked} 모두 OK\n`);
  process.exit(0);
}

for (const f of errors) {
  console.log(`✗ ERROR  ${f.name}`);
  console.log(`         ${f.message}`);
}
for (const f of warns) {
  console.log(`⚠ WARN   ${f.name}`);
  console.log(`         ${f.message}`);
}

console.log('\n──────────────────────────────────');
console.log(`  통과 ${ok}  /  경고 ${warns.length}  /  오류 ${errors.length}  (총 ${checked})`);
console.log('──────────────────────────────────\n');

process.exit(errors.length === 0 ? 0 : 1);
