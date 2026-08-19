/**
 * Track A — 업로드 자료 기반 Private 문항 생성 파이프라인 (v2)
 *
 * 흐름:
 *   1. user_uploads 행 조회 → storage_path 확보
 *   2. Supabase Storage 에서 파일 다운로드
 *   3. file_type 별 분기:
 *      - application/pdf                   → renderPdfPages → page-by-page
 *      - PPTX (application/vnd.openxmlformats-officedocument.presentationml.presentation)
 *        → parsePptx 로 ppt/media 이미지 우선 수집 + 슬라이드 텍스트
 *        (LibreOffice 가 있으면 전체 슬라이드도 렌더 — 본 함수는 미디어만 사용)
 *      - image/*                          → 단일 이미지로
 *   4. 각 페이지/슬라이드에 대해:
 *      4a. 의료 이미지 영역 검출 (Vision)
 *      4b. crop → 전처리 → OCR
 *   5. 슬라이드 텍스트 + crop+OCR 결과를 Claude 에 한꺼번에 전달해 문항 생성
 *   6. private_questions 일괄 저장 + 상태 업데이트
 *
 * 비용 추적: 모든 호출이 recordAiCost 로 ai_cost_log 에 기록됨.
 */

import { createHash } from 'node:crypto';
import type { PrivateQuestionKind } from '@/lib/types/database';
import type Anthropic from '@anthropic-ai/sdk';
import { createAdminClient } from '@/lib/db/admin';
import {
  getAnthropic,
  MODELS,
  calculateCost,
  withRetry,
  createMessage,
  type UsageRecord,
} from './client';
import { recordAiCost } from './cost-cap';
import { lintChoiceLeakage, shuffleChoices } from './kmle-format';
import { buildUploadNotices } from './upload-notice';
import {
  REFERENCE_PROFILE_SYSTEM_PROMPT,
  REFERENCE_PROFILE_TOOL,
  buildReferenceProfileUserMessage,
  buildReferenceProfileSection,
  isUsableProfile,
  type ReferenceFormatProfile,
} from './reference-profile';
import {
  PRIVATE_GENERATION_SYSTEM_PROMPT,
  PRIVATE_GENERATION_TOOL_SCHEMA,
  buildPrivateGenerationUserMessage,
} from './prompts/private-generation';
import {
  STORAGE_BUCKET,
  questionImagePath,
  questionImageIndex,
} from '@/lib/storage/paths';
import { parsePptx } from '@/lib/extract/pptx';
import {
  renderPdfPages,
  convertPptxToPdf,
  isLibreOfficeAvailable,
} from '@/lib/extract/render-slides';
import {
  detectMedicalRegions,
  cropRegions,
  type CroppedImage,
} from '@/lib/extract/crop-medical-images';
import {
  extractEmbeddedPdfImages,
  type ExtractEmbeddedDiagnostic,
} from '@/lib/extract/pdf-embedded-images';
import { extractPdfImageObjects } from '@/lib/extract/pdf-image-objects';
import {
  selectExamImages,
  type SelectExamImagesDiag,
} from '@/lib/extract/select-exam-images';
import { inpaintRemoveText } from '@/lib/extract/inpaint-text';
import { maskTextRegions, isShortFigureLabel } from '@/lib/extract/mask-text';
import {
  annotateMarkers,
  selectMarkerSources,
  buildMarkerLegend,
  stemReferencesMarker,
  type PlacedMarker,
} from '@/lib/extract/annotate-markers';
import {
  KNOWLEDGE_RULES,
  KNOWLEDGE_ASK_KINDS,
  ALL_ASK_KINDS,
  buildKnowledgeQuotaDirective,
} from '@/lib/ai/prompts/knowledge-rules';
import {
  CLINICAL_VIGNETTE_RULES,
  buildClinicalQuotaDirective,
} from '@/lib/ai/prompts/clinical-vignette';
import {
  isClinicalVignette,
  measureClinicalYield,
  hasForbiddenAsk,
  hasPatientIntro,
} from '@/lib/ai/clinical-shape';
import { verifyQuestion } from './verify';
import { isPrivateVerifyFailure, PRIVATE_VERIFY_REJECT_SCORE } from './verify-policy';
import { blindSolveOnce } from './blind-solve';
import { BLIND_ATTEMPTS, isBlindSolvable } from './blind-policy';
import {
  extractFocusTopics,
  assignFocus,
  buildFocusDirective,
  buildPriorStemsDirective,
  PRIOR_STEM_LIMIT,
} from './material-outline';
import {
  normalizeExplanation,
  countDistractorsMentioned,
  EXPLANATION_TARGET_CHARS,
  EXPLANATION_SOFT_LIMIT_CHARS,
  MIN_DISTRACTORS_MENTIONED,
} from './explanation-format';
import { preprocessForOcr, normalizeToPng } from '@/lib/extract/preprocess';
import { runOcr } from '@/lib/ocr/engine';

// ─────── 비용/메모리 보호용 상한 ───────
// 본문 텍스트는 pdf-parse 가 "전체 페이지"에서 추출(최대 15만자)하므로, 아래 페이지 상한은
// "의료 이미지 검출을 위한 페이지 렌더" 수만 제한한다. 텍스트 위주 강의자료/시험자료는
// 이 값을 낮춰도 내용 손실이 없고, 페이지별 vision(검출+OCR) 호출이 줄어 생성 속도가 크게 빨라진다.
// (25→10 으로 하향: 28p 대용량 PDF 도 수 분→~2분 수준으로 단축. 이미지가 많은 자료는 앞 10p 위주.)
// 스캔/이미지 위주(텍스트 레이어가 부족한) 자료는 "전 페이지"를 이미지 분석 대상으로 삼아
// 놓치는 페이지가 없게 한다. 페이지별 Vision/OCR 은 순차가 아니라 병렬(아래 VISION_CONCURRENCY)
// 로 처리해 대용량 스캔도 현실적인 시간 안에 완료한다.
// (텍스트 위주 자료는 앞서 text-only 경로로 빠지므로 여기 상한과 무관.)
const MAX_PDF_PAGES = 100;         // 이미지 검출용 페이지 렌더 상한
const PDF_RENDER_EDGE_PX = 1280;   // PDF 페이지 렌더 해상도 — 메모리·토큰 절감 (기본 1600 대비 하향)
// detectMedicalRegions 대상 슬라이드 수. 스캔 PDF(비전 검출 경로)는 페이지당 검출 콜이
// 붙는 유일한 원가 꼬리(업로드당 +5~15원)라, 이미지 문항 정책 확정(2026-08-14)에 따라
// 100 → 40 으로 하향. 40페이지면 강의록 대부분을 커버하고 초과분은 검출을 생략한다.
const MAX_VISION_SLIDES = 40;
// 문항에 투입하는 이미지 상한의 절대 천장. 실제 상한은 요청 문항 수에 연동해 정한다
// (featuredBudget). 종전 고정 8은 "주석 텍스트가 정답 단서로 새는 것"을 막으려 15에서
// 내린 값인데, 그 뒤 좌표 마스킹·재OCR 검증·텍스트 캡처 검열이 들어가 원래 이유가 해소됐다.
// 상한만 남아 공급을 조르고 있었다 — 실측: 후보 26장 전부 useful 판정인데 면적 상위 8장만
// 생존, 버려진 18장 중 9장이 진짜 임상영상(CT 5·심초음파 2·X-ray 2).
const MAX_FEATURED_IMAGES_CAP = 20;
// 이미지가 필요 없는 요청(이미지형 미선택)에서 쓰는 하한 — 종전 동작 유지용.
const MIN_FEATURED_IMAGES = 8;
/**
 * "그 컬럼이 없다"를 나타내는 오류 코드 — 계층에 따라 다르다(2026-08-16 프로덕션 실측).
 *   SELECT 에 없는 컬럼       → Postgres 판정    → 42703
 *   INSERT/UPDATE 본문의 컬럼 → PostgREST 선차단 → PGRST204
 * 내신 품질 계측 컬럼(00040)은 `db push` 금지 정책 때문에 SQL Editor 로 수동 적용한다.
 * 그래서 **코드 배포가 마이그레이션보다 먼저 도착할 수 있다** — 그때 문항 저장 자체가
 * 실패하면 생성 기능이 통째로 죽는다. 아래 코드는 그 경우 계측 필드만 빼고 진행한다.
 */
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204']);

function isMissingColumnError(error: { code?: string | null } | null): boolean {
  return !!error?.code && MISSING_COLUMN_CODES.has(error.code);
}

/**
 * 검증 1패스(P1) 운용 모드.
 *
 *   'off'      — 검증하지 않는다(사고 시 즉시 끌 수 있는 스위치).
 *   'warn'     — 기준 미달을 경고·진단·점수로만 남기고 **저장한다**. (기본)
 *   'discard'  — 기준 미달 문항을 버리고 보충 생성이 그 자리를 채운다.
 *
 * 왜 기본이 warn 인가: Flash 로 만든 문항의 오류를 Flash 검증이 실제로 얼마나 잡는지는
 * 실측 전에는 모른다. 처음부터 discard 로 켜면 오탐이 멀쩡한 문항을 버리고 보충 생성으로
 * 시간·비용만 늘어난다. 첫 주는 warn 으로 돌려 폐기 후보를 사람이 검토한 뒤 올린다.
 */
const VERIFY_MODE = ((): 'off' | 'warn' | 'discard' => {
  const raw = (process.env.PRIVATE_VERIFY_MODE ?? 'warn').toLowerCase();
  return raw === 'off' || raw === 'discard' ? raw : 'warn';
})();
/** 검증 한 건의 상한. 넘으면 판정 없이 통과시킨다(가용성 우선). */
const VERIFY_TIMEOUT_MS = 8_000;
/**
 * 배치 하나 안에서 동시에 돌리는 검증 수.
 * 배치들도 서로 병렬이라 무제한으로 열면 배치 수 × 배치 크기만큼 한꺼번에 나가 429 를
 * 자초한다. 429 는 통과 처리로 흘러가 검증이 조용히 사라지므로 애초에 안 만드는 게 낫다.
 */
const VERIFY_CONCURRENCY = 6;

/**
 * 블라인드 풀이 검사(P9) 동작 모드. `PRIVATE_BLIND_MODE` = off | warn | discard.
 *
 * 왜 기본이 discard 인가 — 검증(P1)이 warn 으로 시작한 것과 반대다. P1 은 모델이
 * "의학적으로 틀렸다"고 **주장**하는 것이라 그 주장 자체가 틀릴 수 있어(실제로 오탐이
 * 확인됐다) 사람 검토를 앞에 뒀다. P9 가 세는 것은 주장이 아니라 **사건**이다 —
 * 그림을 빼고 실제로 풀었더니 연속으로 맞혔다. 우연 정답률 4 %는 계산으로 고정돼 있고,
 * 통과시키는 쪽의 대가(그림이 장식인 이미지형이 그대로 학생에게 나감)가 폐기하는 쪽의
 * 대가(문항 1개를 다시 만듦)보다 크다.
 */
const BLIND_MODE = ((): 'off' | 'warn' | 'discard' => {
  const raw = (process.env.PRIVATE_BLIND_MODE ?? 'discard').toLowerCase();
  return raw === 'off' || raw === 'warn' ? raw : 'discard';
})();
/**
 * 한 문항의 블라인드 시도 전체(BLIND_ATTEMPTS 회 병렬)에 주는 상한.
 * 검증(8초)보다 조금 길다 — 두 번을 함께 기다리기 때문이다. 넘으면 판정 없이 통과.
 */
const BLIND_TIMEOUT_MS = 12_000;
/**
 * 동시에 블라인드 검사하는 문항 수. 문항 하나가 BLIND_ATTEMPTS 회를 열므로
 * 실제 동시 호출은 이 값 × BLIND_ATTEMPTS 다 — VERIFY_CONCURRENCY 보다 낮게 잡는다.
 */
const BLIND_CONCURRENCY = 3;

/**
 * 이전 발문 조회(P11 세션 간)를 배치가 기다리는 상한.
 * 중복 방지는 있으면 좋은 것이지 필수가 아니다 — 조회가 늦으면 없는 셈 치고 출발한다.
 */
const PRIOR_STEMS_TIMEOUT_MS = 2_500;

/**
 * 00040 미적용이 한 번 확인되면 이후 배치는 처음부터 계측 컬럼 없이 저장한다
 * (배치마다 실패-재시도를 반복하지 않게 하는 프로세스 수명 캐시).
 */
let questionMetricColumnsSupported = true;

/** 같은 이유의 프로세스 수명 캐시 — user_uploads.notice(P8) 컬럼 유무. */
let uploadNoticeColumnSupported = true;

/** 00040 이 추가한 private_questions 계측 컬럼(kind·ask_kind·verify_score)만 뺀 행. */
function withoutMetricColumns<
  T extends { kind?: unknown; ask_kind?: unknown; verify_score?: unknown },
>(row: T): Omit<T, 'kind' | 'ask_kind' | 'verify_score'> {
  const { kind: _kind, ask_kind: _askKind, verify_score: _verifyScore, ...rest } = row;
  return rest;
}

/**
 * 이번 요청에서 확보할 문항 이미지 수. 장당 MAX_QUESTIONS_PER_IMAGE 문항까지 쓰므로
 * desiredCount 장이면 이론상 요청의 2배를 덮어 배치마다 이미지가 돌아가고 다양성도 남는다.
 */
function featuredBudget(desiredCount: number): number {
  return Math.min(MAX_FEATURED_IMAGES_CAP, Math.max(MIN_FEATURED_IMAGES, desiredCount));
}
// 생성 호출에 첨부하는 크롭의 긴 변 상한(px). 크롭 원본을 그대로 base64 첨부하면 이미지형
// 입력 토큰의 대부분을 차지한다(선별 단계만 320px 축소, 생성 단계는 원본이었음 — 이미지 문항
// 정책 확정 2026-08-14). 문항 저장·표시용 원본은 그대로 두고 모델 입력만 줄인다.
const GEN_IMAGE_EDGE_PX = 1024;

async function toGenerationImageBase64(png: Uint8Array): Promise<string> {
  try {
    const { loadImage, createCanvas } = await import('canvas');
    const img = await loadImage(Buffer.from(png));
    const scale = Math.min(1, GEN_IMAGE_EDGE_PX / Math.max(img.width, img.height));
    if (scale >= 1) return Buffer.from(png).toString('base64');
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = createCanvas(w, h);
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    return canvas.toBuffer('image/png').toString('base64');
  } catch {
    // 다운스케일 실패는 원가 최적화 실패일 뿐이므로 원본 첨부로 계속한다.
    return Buffer.from(png).toString('base64');
  }
}
// 동일 이미지 1장을 문항에 연결할 수 있는 상한. 저장 후 정리(초과 연결 제거)뿐 아니라
// 이미지 배치 예약 수·배치별 최소 이미지 문항 수·보충 배치의 이미지 재투입 판단이 공유한다.
const MAX_QUESTIONS_PER_IMAGE = 2;
// 생성에 투입하는 텍스트 상한(자). 유료 티어(대컨텍스트)이므로 상향해 대용량(30~50p) 강의록의
// 뒷부분 내용이 잘리지 않게 한다. (기존 40,000자 → 30페이지 뒷부분 누락 원인)
const MAX_GEN_TEXT_CHARS = 150_000;
const MAX_EMBEDDED_CANDIDATES = 40; // AI 선별에 넣을 후보(추출) 상한
// 임베드 추출 성공 개수가 이 값 미만이면(이미지형 요청 한정) 페이지 렌더+Vision 검출을
// 병행해 후보를 보충한다. 슬라이드에 벡터로 그려진 다이어그램·차트는 임베드 래스터
// 객체가 아니라서 임베드 경로에 안 잡히는데, 종전에는 임베드가 1장이라도 성공하면
// Vision 을 통째로 생략해 그 자료의 이미지 후보가 그대로 바닥났다.
const EMBED_SUPPLEMENT_MIN = 4;
// 임베드 이미지 최소 변(px). 기본 300 은 강의 슬라이드의 중간 크기(200~300px) 임상
// 사진까지 아이콘으로 오인해 버렸다 — 크기 컷을 낮추고 저품질 여부는 AI 선별에 맡긴다.
const EMBED_MIN_EDGE_PX = 200;
const VISION_CONCURRENCY = 6;      // 페이지 vision/OCR 동시 처리 수 — 순차 대비 대용량 대폭 가속
const PDF_SCAN_EDGE_PX = 320;      // 전체 페이지 로컬 후보 선별용 저해상도
// crop 단위 OCR 동시 처리 수. OCR 은 슬라이드가 아니라 crop 이미지 1장당 1회 호출이므로
// crop 을 평탄화해 전역 동시성으로 돌린다. (슬라이드 단위 병렬로는 임베드 이미지 경로처럼
// 한 슬라이드에 crop 이 몰린 경우 사실상 순차가 되어 수십 초를 잃는다.)
// 8 → 14: OCR 은 CPU 가 아니라 네트워크 대기가 지배하는 호출이라 동시성을 올리면
// 그만큼 줄어든다(실측: 이미지가 많은 20문항 실행에서 OCR 구간 12.4초). 재시도·백오프는
// 그대로라 레이트리밋에 걸려도 안전하게 물러난다.
const OCR_CONCURRENCY = 14;
// 생성 배치당 최대 문항 수. 생성 시간은 배치당 "출력 토큰 수"가 지배하므로 배치를 잘게
// 쪼개 병렬로 돌리면 체감 시간이 배치 1개 수준으로 줄어든다. 문항당 출력이 1천 토큰대라
// 4문항 배치는 디코딩만 1분+ 걸림 → 2문항으로 줄여 배치 1개를 ~30초대로.
// (배치 수만큼 입력 컨텍스트가 반복 과금되므로 무한정 쪼개지는 않는다.)
const GEN_BATCH_MAX_QUESTIONS = 2;
// 생성 배치 동시 실행 상한. 20문항(10배치) 요청 시 대형 입력의 동시 요청 폭주로
// 429(rate limit) 백오프가 걸리면 오히려 벽시계 시간이 늘어나므로 과도한 동시성만 제한.
const GEN_CONCURRENCY = 8;
// 배치가 이 시간을 넘기면 같은 슬롯으로 복제 요청을 한 번 더 띄운다(hedged request).
// 배치는 병렬이라 전체 소요를 "가장 느린 배치 하나"가 지배하는데, 실측에서 다른 배치가
// 8~14초일 때 한 배치만 29초가 걸린 실행이 있었다(429 백오프로 추정) — 그 한 건이 전체를
// 10초 이상 늘렸다. 정상 배치(8~14초)에는 발동하지 않도록 그보다 넉넉히 잡는다.
const GEN_HEDGE_AFTER_MS = 18_000;
// 요청 수를 못 채웠을 때 빈 슬롯을 다시 채우는 최대 라운드 수.
// (모델이 요청보다 적게 반환하거나, 이미지 문항이 정제 실패로 삭제되면 부족분이 생긴다.)
const GEN_BACKFILL_ROUNDS = 2;
// 보충 배치에 싣는 출제 근거 텍스트 상한(자). 본 배치(최대 15만 자)와 달리 보충은
// "빈 칸 몇 개만 빠르게" 채우는 호출이라 입력을 줄여 429·대기 시간을 피한다.
// 실측에서 보충 1문항이 27.6초를 써 총 시간을 지배해 30k → 12k 로 더 조였다.
const GEN_BACKFILL_CONTEXT_CHARS = 12_000;
// 배치별 구간 분할: 이 길이 미만의 자료는 나눠도 이득이 없어 전체를 그대로 준다.
const GEN_SEGMENT_ENABLE_MIN_CHARS = 20_000;
// 구간 하나의 최소 길이. 구간이 이보다 얇아지면 구간 수를 줄여(여러 배치가 같은 구간 공유)
// 출제 근거가 부족해지는 것을 막는다.
const GEN_SEGMENT_MIN_CHARS = 6_000;
// 구간 경계 겹침 비율 — 경계에 걸친 내용이 어느 배치에도 안 잡히는 일을 방지.
const GEN_SEGMENT_OVERLAP_RATIO = 0.1;
// 이미지 1장 정제(인페인팅+검증)에 허용하는 최대 시간. 초과하면 그 이미지는 제외한다.
// 느린 이미지 편집 호출 한 건이 전체 생성을 붙잡는 꼬리를 차단한다.
const IMAGE_REFINE_TIMEOUT_MS = 20_000;
// 전처리(추출) 완료를 기다리는 상한. 초과하면 그때까지 확보한 본문 텍스트만으로 생성을 마친다.
//
// 왜 필요한가: 종전에는 `await extractPromise` 에 상한이 없어, 전처리가 어떤 이유로든
// 끝나지 않으면 실행 전체가 그 자리에서 영구 정지했다. 예외가 아니라 "정지"라서
// 실패 처리도 진단 기록도 돌지 않고, user_uploads 행이 status=processing 인 채로 남아
// 화면은 진행률이 멈춘 채 영원히 로딩됐다(실측: 강의록 PDF 2건이 66 %에서 정지).
// 개별 원인(pdfjs 전역 이미지 객체)은 고쳤지만, 처음 보는 강의록 형식이 또 다른 방식으로
// 전처리를 붙잡을 수 있으므로 "실행은 어떤 경우에도 끝난다"를 여기서 보장한다.
const EXTRACT_WAIT_TIMEOUT_MS = 90_000;
// 크롭 OCR 전체 완료를 기다리는 상한. 위와 같은 취지의 최후 방어선이다.
const OCR_WAIT_TIMEOUT_MS = 60_000;

/**
 * 약속이 상한 안에 끝나지 않으면 `fallback` 으로 진행한다(거부하지 않는다).
 * 원 약속은 그대로 흘러가되 결과만 버린다 — 부분 결과라도 이미 반영된 것은 유지된다.
 */
async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout?: () => void,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<T>((resolve) => {
    timer = setTimeout(() => {
      onTimeout?.();
      resolve(fallback);
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function selectLikelyImagePages(
  pages: Array<{ pageIndex: number; png: Uint8Array }>,
  opts: { minSelected?: number } = {},
): Promise<number[]> {
  const { createCanvas, loadImage } = await import('canvas');
  const selected: number[] = [];
  // 임계 미달 페이지의 점수(최소 보장 채움용).
  const belowThreshold: Array<{ pageIndex: number; score: number }> = [];
  for (const page of pages) {
    try {
      const image = await loadImage(Buffer.from(page.png));
      const width = 48;
      const height = Math.max(24, Math.round((image.height / image.width) * width));
      const canvas = createCanvas(width, height);
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0, width, height);
      const pixels = context.getImageData(0, 0, width, height).data;
      let dark = 0;
      let colored = 0;
      let midtone = 0;
      const total = width * height;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        const r = pixels[offset];
        const g = pixels[offset + 1];
        const b = pixels[offset + 2];
        const average = (r + g + b) / 3;
        if (average < 90) dark += 1;
        if (Math.max(r, g, b) - Math.min(r, g, b) > 28 && average < 245) colored += 1;
        if (average >= 90 && average < 220) midtone += 1;
      }
      // Text glyphs mostly disappear at 48px width. Medical photos, radiology,
      // charts, and shaded diagrams retain contiguous dark/color/midtone mass.
      // score > 1 ⇔ 종전 임계(dark 2.5% / colored 3.5% / midtone 11%) 중 하나 초과.
      const score = Math.max(
        dark / total / 0.025,
        colored / total / 0.035,
        midtone / total / 0.11,
      );
      if (score > 1) selected.push(page.pageIndex);
      else belowThreshold.push({ pageIndex: page.pageIndex, score });
    } catch {
      // A page that cannot be scored is kept so local selection never becomes
      // a silent content-loss mechanism.
      selected.push(page.pageIndex);
    }
  }
  // 최소 보장: 임계 미달이어도 점수 상위 페이지를 minSelected 까지 채운다.
  // 흰 배경의 회색조 X-ray·얇은 선 다이어그램은 48px 다운샘플에서 잉크 질량이 임계에
  // 못 미쳐 통째로 탈락하곤 했다 — 그 자료는 이미지 문항이 0이 된다. 최종 판정은
  // 어차피 페이지별 Vision 검출이 하므로, 여기서는 후보를 조금 후하게 넘긴다.
  const minSelected = Math.min(opts.minSelected ?? 0, pages.length);
  if (selected.length < minSelected) {
    belowThreshold.sort((a, b) => b.score - a.score);
    for (const s of belowThreshold) {
      if (selected.length >= minSelected) break;
      selected.push(s.pageIndex);
    }
  }
  return selected;
}

/**
 * items 를 최대 `limit` 개씩 동시에 처리하고, 입력 순서를 보존한 결과 배열을 반환한다.
 * 페이지별 Vision/OCR 호출을 병렬로 돌려 다중 페이지(스캔) 자료의 처리 시간을 단축한다.
 * 개별 작업의 예외는 fn 내부에서 처리(여기선 rethrow 안 함) — 한 페이지 실패가 전체를 막지 않게.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onProgress?: (completed: number, total: number) => Promise<void> | void,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  let completed = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = cursor;
      cursor += 1;
      if (i >= items.length) break;
      results[i] = await fn(items[i], i);
      completed += 1;
      await onProgress?.(completed, items.length);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * DB / UI 에 저장될 error_message 를 짧고 안전한 형태로 정리.
 * - 내부 stack trace, supabase 내부 디테일 노출 방지
 * - 200자 제한
 */
function sanitizeErrorMessage(raw: unknown): string {
  let m = raw instanceof Error ? raw.message : String(raw ?? '');
  m = m.replace(/\s+/g, ' ').trim();
  if (!m) return '알 수 없는 처리 오류';
  // AI 크레딧·쿼터 소진은 사용자가 "다시 시도"해도 소용없다. 원인을 그대로 알려
  // 조치(충전/한도 상향)로 이어지게 한다. 실측에서 이 경우 화면에는
  // "잠시 후 다시 시도해주세요"만 떠서 원인을 알 수 없었다.
  const lower = m.toLowerCase();
  if (
    lower.includes('credit') ||
    lower.includes('billing') ||
    lower.includes('quota') ||
    lower.includes('resource_exhausted')
  ) {
    return 'AI 사용량 크레딧이 소진되어 생성을 완료하지 못했습니다. 결제·한도를 확인한 뒤 다시 시도해주세요.';
  }
  if (m.length > 200) m = m.slice(0, 197) + '...';
  return m;
}

/**
 * 발문이 "제시된 그림을 봐야만 풀리는" 문항인지 판정.
 *
 * 이미지가 정제(텍스트 제거) 실패나 재사용 상한으로 빠지면, 그림을 가리키는 발문은
 * 풀 수 없으므로 문항을 삭제해야 한다. 반대로 모델이 이미지를 곁들이기만 하고 발문은
 * 텍스트만으로 완결된 경우(흔함)까지 삭제하면 요청 수가 모자라 보충 생성이 돌고,
 * 그 보충 호출이 전체 시간을 수십 초 늘린다. 그래서 발문 표현으로 구분한다.
 * (판정이 애매하면 삭제 쪽으로 — 못 푸는 문항을 남기는 것이 더 나쁘다.)
 */
const IMAGE_DEIXIS =
  '다음|아래|위의|위에|제시된|해당|보이는|첨부된|주어진';
// 모식도·도해 같은 "그림" 표현을 빠뜨려 실제 사고가 났다(발문은 "…모식도이다"인데 이미지 없음).
const IMAGE_NOUNS =
  '그림|사진|이미지|영상|심전도|ECG|EKG|방사선|엑스레이|X-?ray|CT|MRI|초음파|병리|현미경|소견|' +
  '모식도|도해|도식|개념도|삽화|도표';
// 그림을 "선언"하는 발문에 쓰이는 명사(표·그래프처럼 본문에 글로 넣을 수 있는 것은 제외).
const FIGURE_NOUNS =
  '그림|사진|이미지|영상|모식도|도해|도식|개념도|삽화|심전도|ECG|EKG|X-?ray|엑스레이|방사선\\s*사진|CT|MRI|초음파|현미경\\s*사진|병리\\s*소견';
// 그림 명사와 서술어 사이에 흔히 끼는 명사("초음파 소견이다", "CT 영상이다").
// 실측 사고: "다음은 복부 초음파 소견이다" 가 이 틈 때문에 '그림 선언'으로 안 잡혀,
// 이미지가 붙지 않은 채로 학생에게 나갔다.
// 주의: 조사 목록에 '은/는' 을 넣지 않아 "심전도 소견은 정상이었다"(본문 서술)는 계속 제외된다.
const FIGURE_TAIL_NOUN = '(?:\\s*(?:소견|사진|영상|결과|이미지))?';

const IMAGE_DEPENDENT_STEM_RE = new RegExp(
  // 지시어와 명사 사이에 수식어가 끼어드는 형태까지 잡는다("아래 흉부 X-ray 를 보고").
  `(?:${IMAGE_DEIXIS})\\s*(?:[가-힣A-Za-z0-9]{1,6}\\s*){0,2}(?:${IMAGE_NOUNS})|` +
    `(?:${IMAGE_NOUNS})\\s*(?:에서|에는|을|를|의|상)\\s*(?:관찰|보이|나타|판독|해석)|` +
    // "다음은 대동맥 박리의 발생 기전에 대한 모식도이다" 처럼 지시어와 그림 명사 사이에
    // 설명이 길게 끼는 선언형. 명사 뒤 조사로 "그림을 가리키는 문장"임을 확인해
    // "심전도 소견은 정상이었다"(본문에 소견을 서술한 경우)와 구분한다.
    `(?:다음|아래|위)(?:은|는)?\\s*[^.?!\\n]{0,40}?(?:${FIGURE_NOUNS})${FIGURE_TAIL_NOUN}\\s*(?:이다|입니다|이며|이고|에서|에는|을|를)|` +
    `판독(?:하|해)|사진\\s*판독`,
  'i',
);

function stemDependsOnImage(stem: string): boolean {
  const s = String(stem ?? '');
  // 표식 문항("A로 표시된 …")에는 그림 명사가 하나도 없어 위 정규식이 못 잡는다.
  return IMAGE_DEPENDENT_STEM_RE.test(s) || stemReferencesMarker(s);
}

/**
 * "제시된 그림을 가리키는" 발문인지 더 엄격하게 판정한다.
 *
 * 용도 차이:
 *  - stemDependsOnImage: 모델이 image_indices 를 채웠는데 이미지가 정제 실패로 빠진 경우에 쓴다.
 *    이미 그림을 의도한 문항이므로 느슨해도 된다.
 *  - stemDeclaresFigure: 이미지가 애초에 하나도 연결되지 않은 문항을 지울지 판단한다.
 *    오탐이면 멀쩡한 문항을 지우게 되므로, 그림 명사 뒤 조사까지 확인해
 *    "다음 환자의 심전도 소견은 정상이었다"(본문 서술)와 "…모식도이다"(그림 지칭)를 구분한다.
 */
const FIGURE_DECLARATION_RE = new RegExp(
  `(?:다음|아래|위|제시된|첨부된|주어진)(?:은|는)?\\s*[^.?!\\n]{0,40}?(?:${FIGURE_NOUNS})${FIGURE_TAIL_NOUN}` +
    `\\s*(?:이다|입니다|이며|이고|에서|에는|으로|로|를\\s*보고|을\\s*보고|를\\s*판독|을\\s*판독)`,
  'i',
);

/** 테스트 전용 재노출 — 런타임 동작에는 영향이 없다. */
export const stemDeclaresFigureForTest = (stem: string): boolean => stemDeclaresFigure(stem);

function stemDeclaresFigure(stem: string): boolean {
  const s = String(stem ?? '');
  // 표식을 가리키는 문항은 이미지가 없으면 풀 수 없다 — 그림 선언과 같이 취급한다.
  return FIGURE_DECLARATION_RE.test(s) || stemReferencesMarker(s);
}

/** 문항 선지 수 — 국시형 고정값. 저장 전에 반드시 이 값으로 맞춘다. */
const REQUIRED_CHOICE_COUNT = 5;

/**
 * 선지를 정확히 5개로 정규화한다.
 *
 * 툴 스키마의 minItems/maxItems 는 모델에 대한 "힌트"일 뿐 강제되지 않아 실제로 선지
 * 6개가 저장된 사례가 있었다. 프롬프트만 강화하는 건 확률적 방어라 저장 직전에
 * 결정론적으로 고정한다.
 *  - 공백/중복 선지 제거
 *  - 5개 초과: 정답을 반드시 살린 채 원래 순서대로 5개로 줄이고 answer_index 재계산
 *  - 5개 미만이거나 정답 위치를 알 수 없으면 null → 호출자가 문항을 폐기(보충 단계가 채움)
 */
function normalizeChoiceSet(
  choices: unknown,
  answerIndex: unknown,
): { choices: string[]; answerIndex: number } | null {
  const raw = Array.isArray(choices) ? choices : [];
  const answerRaw = typeof answerIndex === 'number' ? raw[answerIndex] : undefined;
  const answerText = typeof answerRaw === 'string' ? answerRaw.trim() : '';
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const c of raw) {
    const s = String(c ?? '').trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    cleaned.push(s);
  }
  // 정답을 특정할 수 없으면 채점이 불가능한 문항이므로 폐기한다.
  if (!answerText || !cleaned.includes(answerText)) return null;
  // 선지가 부족한 경우 임의로 만들어 넣을 수 없다(의학적 오답을 발명하게 됨) → 폐기.
  if (cleaned.length < REQUIRED_CHOICE_COUNT) return null;
  if (cleaned.length === REQUIRED_CHOICE_COUNT) {
    return { choices: cleaned, answerIndex: cleaned.indexOf(answerText) };
  }
  // 초과분 절삭: 정답은 유지하고 오답은 원래 순서대로 4개만 남긴다.
  const distractors: string[] = [];
  for (const c of cleaned) {
    if (c === answerText) continue;
    if (distractors.length >= REQUIRED_CHOICE_COUNT - 1) break;
    distractors.push(c);
  }
  // 정답 번호가 한쪽으로 쏠리지 않게 원래 위치에 가장 가까운 자리에 넣는다.
  const insertAt = Math.min(cleaned.indexOf(answerText), REQUIRED_CHOICE_COUNT - 1);
  distractors.splice(insertAt, 0, answerText);
  return { choices: distractors.slice(0, REQUIRED_CHOICE_COUNT), answerIndex: insertAt };
}

/**
 * 모델이 신고한 발문 유형(ask_kind)을 카탈로그 값으로 정규화한다(P3).
 *
 * 카탈로그 밖 값(오탈자·한국어·창작)은 null 로 버린다 — 측정용 라벨이므로 정확하지 않으면
 * 없는 것만 못하다. 대소문자·공백·하이픈만 관대하게 받는다.
 */
function normalizeAskKind(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return (ALL_ASK_KINDS as readonly string[]).includes(v) ? v : null;
}

/**
 * 문두 종결어미를 국시체로 정규화(결정론적 후처리).
 * 프롬프트가 대부분 "~것은?"으로 유도하지만, 병렬 배치에서 간혹 구어체가 새어나오므로
 * 여기서 확실히 격식체로 변환한다. (문법이 깨지지 않는 안전한 변환만 수행.)
 */
function normalizeStemEnding(stem: string): string {
  let s = String(stem ?? '').replace(/\s+$/, '');
  // "...은/는 무엇인가요?/무엇입니까?/무엇인가?" → "...은/는?" (KMLE 표준 종결)
  s = s.replace(/([은는])\s*무엇(?:인가요|입니까|인가)\s*\?$/u, '$1?');
  // "...가요?"(정중 구어 의문) → "...가?"(격식 의문). 예: 인가요→인가, 하는가요→하는가
  s = s.replace(/가요\s*\?$/u, '가?');
  return s;
}

/** 판독 대상이 되는 실제 임상 검사 유형. 발문-이미지 정합성 판단의 기준. */
const CLINICAL_IMAGE_KINDS = new Set([
  'xray', 'ct', 'mri', 'ecg', 'pathology', 'microscope', 'ultrasound',
]);

/**
 * 발문에서 내부 인덱스·메타 문구를 결정론적으로 제거한다.
 *
 * 시스템 프롬프트가 "[이미지 N] 같은 내부 번호를 발문에 쓰지 말라"고 명시하는데도
 * 실측에서 반복적으로 새어나왔다("다음 초음파 영상(이미지 2)에서 …"). 내부 번호는
 * 0-based 인데 학생 화면 라벨은 1-based 라 그대로 두면 가리키는 그림이 어긋난다.
 * 또 이미지 문항을 요구받은 모델이 "(이미지 없음)" 같은 자기 메모를 발문에 남기는
 * 사례도 관찰됐다. 프롬프트로 두 번 실패했으므로 저장 직전에 확정적으로 지운다.
 */
export function sanitizeStemArtifacts(stem: string): string {
  let s = String(stem ?? '');
  // "(이미지 없음)", "[사진 없음]", "(그림 없음)" 같은 메타 메모 — 괄호째 제거.
  s = s.replace(/[([{]\s*(?:이미지|사진|그림|영상)\s*(?:없음|미제공|없습니다)\s*[)\]}]/g, '');
  // "(이미지 2)", "[이미지 0]" — 괄호로 감싼 내부 번호는 괄호째 제거.
  s = s.replace(/[([{]\s*(?:이미지|그림|사진|영상)\s*\d+\s*[)\]}]/g, '');
  // 괄호 없이 쓰인 "이미지 1" — 번호만 떼어 "이미지"라는 지시어는 살린다
  // ("이미지 1에서 보이는" → "이미지에서 보이는").
  s = s.replace(/(이미지|그림|사진|영상)\s*\d+/g, '$1');
  // 제거 후 남는 공백·구두점 정리.
  s = s.replace(/\s{2,}/g, ' ').replace(/\s+([,.?!)\]}])/g, '$1').replace(/([([{])\s+/g, '$1');
  // 괄호를 들어낸 자리에 조사가 떨어져 나간 경우를 붙인다("흉부 CT (이미지 2)에서" →
  // "흉부 CT 에서" → "흉부 CT에서"). 조사가 독립 토큰일 때만 붙여 "5 cm 이상" 같은
  // 정상 띄어쓰기를 건드리지 않는다.
  s = s.replace(
    /([A-Za-z0-9)\]])\s+(에서|에는|에도|에|으로|로|을|를|은|는|이|가|의|와|과)(?=[\s,.?!)]|$)/g,
    '$1$2',
  );
  return s.trim();
}

/** 발문이 명시한 검사 유형들. 여러 개를 언급할 수 있으므로 전부 모은다. */
const STEM_MODALITY_PATTERNS: Array<[string, RegExp]> = [
  ['xray', /X-?ray|엑스레이|단순\s*방사선|흉부\s*방사선|흉부\s*단순촬영/i],
  ['ct', /\bCT\b|전산화\s*단층/i],
  ['mri', /\bMRI\b|자기공명/i],
  ['ultrasound', /초음파|심초음파|\becho(?:cardiograph)?/i],
  ['ecg', /심전도|\bECG\b|\bEKG\b/i],
  ['pathology', /병리\s*소견|병리\s*사진|생검\s*소견/i],
  ['microscope', /현미경\s*(?:소견|사진)/i],
];

/**
 * 발문이 말하는 검사와 실제로 붙은 이미지가 어긋나는지.
 *
 * 실측 사고: 발문은 "흉부 X-ray 에서 종격동 확장이 관찰된다"인데 붙은 이미지는
 * 심초음파였다 — 학생이 볼 때 발문과 그림이 따로 놀아 풀 수 없다.
 * 발문이 검사를 특정하지 않았거나(예: "다음 사진에서"), 이미지가 도해·기타 유형이면
 * 판단 근거가 없으므로 통과시킨다(과도한 연결 해제 방지).
 */
export function stemModalityConflict(stem: string, kind: string): boolean {
  if (!CLINICAL_IMAGE_KINDS.has(kind)) return false;
  const mentioned = STEM_MODALITY_PATTERNS.filter(([, re]) => re.test(stem)).map(([k]) => k);
  if (mentioned.length === 0) return false;
  return !mentioned.includes(kind);
}

/**
 * 느린 호출에 복제 요청을 띄워 꼬리를 자른다(hedged request).
 *
 * 모델 호출은 편차가 크다 — 실측에서 다른 배치가 8~14초일 때 한 배치만 29초가 걸렸다
 * (429 백오프로 추정). 배치는 병렬이라 그 한 건이 전체 소요를 지배한다.
 * afterMs 를 넘기면 같은 호출을 한 번 더 띄우고 **먼저 끝난 쪽**을 채택한다.
 * afterMs 전에 실패하면 기다리지 않고 즉시 다시 시도하고, 모든 시도가 실패해야 거부한다.
 *
 * 주의: 감싸는 대상은 "모델 호출"이어야 한다. 배치 전체(이미지 준비 대기 포함)를 감싸면
 * 대기 시간까지 임계에 포함돼 정상 배치가 복제를 유발한다(실측: 이미지 게이팅 도입 후
 * 배치 총시간이 19~24초가 되면서 헤지가 4회 헛발동).
 */
function hedgedCall<T>(
  run: () => Promise<T>,
  opts: {
    afterMs: number;
    onHedge?: () => void;
    onRetry?: () => void;
    /** 승자 채택 후 늦게 도착한 응답 — 결과는 버리지만 토큰은 청구되므로 비용 기록용. */
    onLoser?: (value: T) => void;
  },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    let launched = 0;
    let failed = 0;
    let firstError: unknown;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const launch = (): void => {
      launched += 1;
      run().then(
        (v) => {
          if (done) {
            opts.onLoser?.(v);
            return;
          }
          done = true;
          if (timer) clearTimeout(timer);
          resolve(v); // 먼저 끝난 쪽을 채택. 늦게 끝난 쪽 결과는 버린다.
        },
        (e) => {
          failed += 1;
          firstError ??= e;
          if (done) return; // 이미 다른 시도가 성공했다면 실패는 무시한다.
          if (failed < launched) return; // 아직 대기 중인 시도가 남아 있다.
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
            opts.onRetry?.();
            launch();
            return;
          }
          reject(firstError); // 모든 시도가 실패.
        },
      );
    };

    timer = setTimeout(() => {
      timer = undefined;
      if (done) return;
      opts.onHedge?.();
      launch();
    }, opts.afterMs);
    launch();
  });
}

export interface PrivateGenerationInput {
  uploadId: string;
  userId: string;
  desiredCount?: number;
  style?: 'kmle' | 'professor' | 'internal';
  /** 사용자 지정 난이도(하/중/상) — 생성 프롬프트에 반영. */
  difficulty?: '하' | '중' | '상';
  /** 사용자 지정 문항 유형 — 생성 프롬프트에 반영. */
  questionTypes?: Array<'지식형' | '임상형' | '이미지형'>;
  /** 사용자 지정 문제집 이름 — 세트 표시명으로 저장. */
  title?: string;
  /** 사용자 지정 출제 초점(P5) — 화면의 '단원/주제'. */
  topic?: string;
  /** 사용자 지정 핵심 키워드(P5). */
  keywords?: string[];
  /** 기출 형식 참고 자료. 문항 구조만 참고하고 내용 근거로 사용하지 않는다. */
  referenceUploadIds?: string[];
}

export interface PrivateGenerationResult {
  generatedCount: number;
  privateQuestionIds: string[];
  contentSummary: string;
  unmatched: number;
  usage: UsageRecord;
  extractStats: {
    pages: number;
    croppedImages: number;
    ocrChars: number;
  };
}

const PPTX_MIME =
  'application/vnd.openxmlformats-officedocument.presentationml.presentation';
const PPT_MIME = 'application/vnd.ms-powerpoint';
const DOCX_MIME =
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

interface ExtractedSlide {
  pageIndex: number;
  text: string;
  croppedImages: CroppedImage[];
}

/**
 * 파이프라인 진단 기록.
 *
 * 전처리에서 시간이 어디로 가는지, 임베드 이미지 경로가 왜 결과를 못 내는지를
 * 배포 환경에서 확인할 수 없어 추측에 의존해야 했다. 실행마다 아래 값을 모아
 * Storage 에 JSON 으로 남기고 GET /api/uploads/[id]/diagnostics 로 조회한다.
 * (스키마 변경 없이 즉시 사용 가능. 강의 내용은 담지 않고 수치·경고만 담는다.)
 */
export interface GenerationDiagnostics {
  uploadId: string;
  fileType: string;
  fileSizeBytes: number | null;
  wantsImages: boolean;
  desiredCount: number;
  /**
   * 요청 조건 — DB 컬럼이 생기기 전까지 "요청 vs 결과"를 진단에서 셀 수 있게 남긴다
   * (2026-08-18 감사: 요청 유형·난이도가 어디에도 저장되지 않아 임상형 수확률조차 못 쟀다).
   */
  requestedDifficulty?: '하' | '중' | '상' | null;
  requestedTypes?: string[];
  referenceImages?: number;
  /** 단계별 소요(ms). */
  timings: Record<string, number>;
  /** 추출 세부 수치(페이지 수·후보 수·생략 여부 등). */
  extract: Record<string, unknown>;
  /** 임베드 이미지 경로 진단 — mutool 실행 가능 여부가 여기서 드러난다. */
  embedded: ExtractEmbeddedDiagnostic & {
    selectMs?: number;
    chosen?: number | null;
    /** 상한 절삭 전 판정 결과 — chosen(절삭 후)만으론 원인 규명이 안 됐던 문제 대응. */
    select?: SelectExamImagesDiag & { max?: number };
  };
  generation: Record<string, unknown>;
  /** 이미지별 정제(인페인팅+검증) 계측 — 어느 이미지가 왜 제외됐고 얼마나 걸렸는지. */
  inpaint: unknown[];
  /** 배치별 계측 — 생성 호출/이미지 처리 소요를 나눠 기록. */
  batches: unknown[];
  warnings: string[];
  finishedAt: string;
}

const MAX_REFERENCE_IMAGES = 6;
/** 참고 자료 1건에서 형식 분석에 쓸 텍스트 상한(자). 형식만 보므로 앞부분이면 충분하다. */
const MAX_REFERENCE_TEXT_CHARS = 20_000;
/** 참고 PDF 텍스트 추출 페이지 상한. 형식 파악에 필요한 만큼만 읽어 지연을 막는다. */
const REFERENCE_PDF_MAX_PAGES = 30;

async function loadReferenceImages(input: {
  uploadIds: string[];
  userId: string;
}): Promise<{ images: Uint8Array[]; texts: string[]; skipped: number }> {
  if (input.uploadIds.length === 0) return { images: [], texts: [], skipped: 0 };

  const admin = createAdminClient();
  const { data: uploads, error } = await admin
    .from('user_uploads')
    .select('id, user_id, file_type, storage_path')
    .in('id', input.uploadIds)
    .eq('user_id', input.userId);
  if (error) throw new Error(`Reference upload lookup failed: ${error.message}`);

  const byId = new Map((uploads ?? []).map((upload) => [upload.id, upload]));
  const images: Uint8Array[] = [];
  const texts: string[] = [];
  // 형식을 못 읽어 반영하지 못한 참고 자료 수 — P8 로 사용자에게 알린다.
  let skipped = 0;

  /** 텍스트가 이만큼도 안 나오면 스캔본으로 보고 이미지 경로로 넘어간다. */
  const MIN_REFERENCE_TEXT = 300;

  for (const id of input.uploadIds) {
    const upload = byId.get(id);
    if (!upload) continue;
    const { data: blob, error: downloadError } = await admin.storage
      .from(STORAGE_BUCKET)
      .download(upload.storage_path);
    if (downloadError || !blob) {
      skipped += 1;
      continue;
    }
    const buffer = await blob.arrayBuffer();

    // 사진으로 찍은 족보 — 텍스트가 없으므로 이미지로만 쓸 수 있다.
    if (upload.file_type.startsWith('image/')) {
      if (images.length >= MAX_REFERENCE_IMAGES) continue;
      const png = await normalizeToPng(new Uint8Array(buffer));
      if (png) images.push(png);
      else skipped += 1;
      continue;
    }

    // ── 텍스트 우선(P7). 종전에는 PDF 를 앞 3쪽 그림으로만 봤고 PPTX·DOCX 는 통째로 무시했다.
    let text = '';
    try {
      if (upload.file_type === 'application/pdf') {
        const { default: pdfParse } = await import('pdf-parse');
        const parsed = await pdfParse(Buffer.from(buffer), { max: REFERENCE_PDF_MAX_PAGES });
        text = (parsed.text ?? '').replace(/\s+/g, ' ').trim();
      } else if (upload.file_type === PPTX_MIME) {
        text = parsePptx(buffer)
          .slides.map((slide) => slide.text)
          .join('\n')
          .replace(/\s+/g, ' ')
          .trim();
      } else if (upload.file_type === DOCX_MIME) {
        // DOCX 는 직접 파서가 없다 — 기존 Office→PDF 변환 경로를 재사용한다.
        const converted = await convertOfficeToPdfBuffer(buffer, 'docx');
        if (converted) {
          const { default: pdfParse } = await import('pdf-parse');
          const parsed = await pdfParse(Buffer.from(converted), { max: REFERENCE_PDF_MAX_PAGES });
          text = (parsed.text ?? '').replace(/\s+/g, ' ').trim();
        }
      }
    } catch (error) {
      console.warn(
        '[private-generation] reference text extract failed:',
        error instanceof Error ? error.message : String(error),
      );
    }

    if (text.length >= MIN_REFERENCE_TEXT) {
      texts.push(text.slice(0, MAX_REFERENCE_TEXT_CHARS));
      continue;
    }

    // 텍스트가 없으면(스캔본) 종전처럼 앞쪽 페이지를 그림으로 넘긴다.
    if (upload.file_type === 'application/pdf') {
      if (images.length >= MAX_REFERENCE_IMAGES) {
        skipped += 1;
        continue;
      }
      try {
        const pages = await renderPdfPages(buffer, {
          maxPages: Math.min(3, MAX_REFERENCE_IMAGES - images.length),
          maxEdgePx: PDF_RENDER_EDGE_PX,
        });
        if (pages.length === 0) skipped += 1;
        images.push(...pages.map((page) => page.png));
      } catch (error) {
        skipped += 1;
        console.warn(
          '[private-generation] reference PDF render skipped:',
          error instanceof Error ? error.message : String(error),
        );
      }
      continue;
    }

    // PPTX·DOCX 인데 텍스트가 없거나(빈 슬라이드) 변환이 실패한 경우, 그 밖의 형식.
    skipped += 1;
  }
  return { images: images.slice(0, MAX_REFERENCE_IMAGES), texts, skipped };
}

/**
 * 참고 자료 텍스트에서 **형식 프로파일**을 1회 호출로 뽑는다 (P7).
 *
 * 왜 1회인가: 프로파일은 시스템 프롬프트에 붙고 시스템은 캐시 대상이라, 배치가 5개든
 * 10개든 한 번만 만들면 된다. 종전처럼 이미지 6장을 배치마다 재전송하던 것과 정반대다.
 *
 * 실패는 조용히 null — 프로파일이 없으면 종전대로 기본 규격으로 만들면 되고, 참고 자료
 * 하나 때문에 생성이 멈추면 안 된다.
 */
async function summarizeReferenceFormat(input: {
  texts: string[];
  userId: string;
  onCost: (usd: number) => void;
}): Promise<ReferenceFormatProfile | null> {
  if (input.texts.length === 0) return null;
  const joined = input.texts.join('\n\n---\n\n');
  const model = MODELS.verification();
  try {
    const client = getAnthropic();
    const response = await withRetry(
      () =>
        createMessage(client, {
          model,
          max_tokens: 1024,
          system: REFERENCE_PROFILE_SYSTEM_PROMPT,
          tools: [REFERENCE_PROFILE_TOOL as unknown as Anthropic.Tool],
          tool_choice: { type: 'tool', name: REFERENCE_PROFILE_TOOL.name },
          messages: [{ role: 'user', content: buildReferenceProfileUserMessage(joined) }],
        }),
      { maxAttempts: 2, backoffMs: 500, maxDelayMs: 4_000 },
    );
    input.onCost(
      calculateCost(
        model,
        response.usage.input_tokens,
        response.usage.output_tokens,
        response.usage.cache_read_input_tokens ?? 0,
        response.usage.cache_creation_input_tokens ?? 0,
      ),
    );
    await recordAiCost({
      userId: input.userId,
      endpoint: 'private.reference-profile',
      model,
      costUsd: 0,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      metadata: { references: input.texts.length },
    }).catch(() => undefined);
    const block = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!block) return null;
    const raw = block.input as Partial<ReferenceFormatProfile>;
    return {
      ask_endings: Array.isArray(raw.ask_endings) ? raw.ask_endings.slice(0, 3).map(String) : [],
      choice_style:
        raw.choice_style === '명사구' || raw.choice_style === '문장' ? raw.choice_style : '혼합',
      avg_stem_chars: Number.isFinite(raw.avg_stem_chars) ? Number(raw.avg_stem_chars) : 0,
      negative_ratio: Number.isFinite(raw.negative_ratio) ? Number(raw.negative_ratio) : 0,
      combo_used: Boolean(raw.combo_used),
      vignette_ratio: Number.isFinite(raw.vignette_ratio) ? Number(raw.vignette_ratio) : 0,
      sample_ask_shapes: Array.isArray(raw.sample_ask_shapes)
        ? raw.sample_ask_shapes.slice(0, 3).map(String)
        : [],
      observed_questions: Number.isFinite(raw.observed_questions)
        ? Number(raw.observed_questions)
        : 0,
    };
  } catch (error) {
    console.warn(
      '[private-generation] reference profile failed:',
      error instanceof Error ? error.message : String(error),
    );
    return null;
  }
}

/**
 * PPTX 를 LibreOffice 로 PDF 변환 후 페이지별 PNG 렌더.
 * 환경에 LibreOffice 가 없으면 null 반환 — 호출자는 media-only fallback 사용.
 */
async function tryRenderPptxViaLibreOffice(
  buffer: ArrayBuffer,
  ext: 'pptx' | 'ppt' = 'pptx',
): Promise<Array<{ pageIndex: number; png: Uint8Array }> | null> {
  if (!(await isLibreOfficeAvailable())) return null;

  const os = await import('node:os');
  const path = await import('node:path');
  const fsp = await import('node:fs/promises');

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'medai-pptx-'));
  const inputPath = path.join(tmpRoot, `input.${ext}`);
  try {
    await fsp.writeFile(inputPath, new Uint8Array(buffer));
    const pdfPath = await convertPptxToPdf(inputPath, tmpRoot);
    const pdfBuf = await fsp.readFile(pdfPath);
    const pages = await renderPdfPages(
      pdfBuf.buffer.slice(
        pdfBuf.byteOffset,
        pdfBuf.byteOffset + pdfBuf.byteLength,
      ) as ArrayBuffer,
      { maxPages: MAX_PDF_PAGES },
    );
    return pages.map((p) => ({ pageIndex: p.pageIndex, png: p.png }));
  } finally {
    // 임시 디렉토리 정리. 실패 무시.
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Office 문서(buffer)를 LibreOffice 로 PDF 변환 후 PDF 버퍼를 반환.
 * DOCX 등 텍스트 중심 문서용 — 호출자는 결과 PDF 를 기존 PDF 파이프라인
 * (pdf-parse 텍스트 + renderPdfPages 이미지)에 그대로 태운다.
 * LibreOffice 가 없으면 null.
 */
async function convertOfficeToPdfBuffer(
  buffer: ArrayBuffer,
  ext: 'docx',
): Promise<ArrayBuffer | null> {
  if (!(await isLibreOfficeAvailable())) return null;

  const os = await import('node:os');
  const path = await import('node:path');
  const fsp = await import('node:fs/promises');

  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'medai-doc-'));
  const inputPath = path.join(tmpRoot, `input.${ext}`);
  try {
    await fsp.writeFile(inputPath, new Uint8Array(buffer));
    const pdfPath = await convertPptxToPdf(inputPath, tmpRoot);
    const pdfBuf = await fsp.readFile(pdfPath);
    return pdfBuf.buffer.slice(
      pdfBuf.byteOffset,
      pdfBuf.byteOffset + pdfBuf.byteLength,
    ) as ArrayBuffer;
  } finally {
    await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractFromBuffer(input: {
  buffer: ArrayBuffer;
  fileType: string;
  userIdForLog: string;
  /**
   * 이 요청이 이미지 문항을 원하는지('이미지형' 선택 여부).
   * false 면 크롭은 문항에 쓰이지 않으므로, 본문 텍스트가 충분한 자료에서는
   * 임베드 이미지 추출·페이지 렌더·Vision 검출·크롭을 통째로 건너뛴다(전처리 시간 절감).
   * 텍스트가 부족한 스캔 자료는 OCR 이 유일한 내용원이므로 예외로 계속 수행한다.
   */
  wantsImages: boolean;
  /** 이번 요청에서 확보할 문항 이미지 수(요청 문항 수 연동, featuredBudget). */
  maxFeatured: number;
  /** 경고 수집 배열(호출자와 공유) — 텍스트 조기 반환 이후에도 계속 쌓을 수 있게 주입받는다. */
  warnings: string[];
  /** 본문 텍스트가 확보된 즉시 1회 호출. 호출자는 이 시점에 텍스트 배치를 먼저 출발시킨다. */
  onEarlyText?: (text: string) => void;
  /**
   * 크롭이 만들어진 즉시 그 크롭의 OCR 을 시작시키는 훅(스트리밍).
   * 종전에는 "전체 추출(모든 페이지 Vision) 완료 → 전체 크롭 OCR" 직렬이라 Vision 파도와
   * OCR 파도가 순서대로 쌓였다. 크롭 확보 즉시 OCR 을 출발시키면 남은 페이지의 Vision 과
   * 겹쳐 돌아, OCR 완료(=이미지 정제·이미지 배치 출발의 선행 조건)가 앞당겨진다.
   * 중복 시작은 호출자가 크롭 객체 단위로 막는다.
   */
  startOcr?: (slideText: string, pageIndex: number, crop: CroppedImage) => void;
  /** 진단 수집기(선택). 단계별 소요와 세부 수치를 채워 넣는다. */
  diag?: {
    timings: Record<string, number>;
    extract: Record<string, unknown>;
    embedded: ExtractEmbeddedDiagnostic & {
    selectMs?: number;
    chosen?: number | null;
    /** 상한 절삭 전 판정 결과 — chosen(절삭 후)만으론 원인 규명이 안 됐던 문제 대응. */
    select?: SelectExamImagesDiag & { max?: number };
  };
  };
  onVisionProgress?: (completed: number, total: number) => Promise<void> | void;
}): Promise<{ slides: ExtractedSlide[] }> {
  const { buffer, fileType, userIdForLog, wantsImages, warnings, maxFeatured } = input;
  // 이미지 분석(렌더+Vision+크롭) 생략 여부 — 텍스트 확보 후 확정한다.
  let skipImageAnalysis = false;
  let earlyTextSent = false;
  const sendEarlyText = (text: string) => {
    if (earlyTextSent) return;
    earlyTextSent = true;
    input.onEarlyText?.(text);
  };

  // PDF 임베드 이미지(object dedup) — 있으면 Vision 검출/crop 대신 이걸 우선 사용.
  let pdfEmbeddedCrops: CroppedImage[] | null = null;
  // 임베드가 소수만 나온 경우(이미지형 요청) 페이지 렌더+Vision 을 병행하는 보충 모드.
  let supplementVision = false;
  // 임베드 이미지가 나온 페이지(1-based) — 보충 Vision 에서 같은 그림이 임베드와
  // 페이지 크롭으로 중복 등재되지 않게 제외한다.
  const embeddedPagesUsed = new Set<number>();
  let allowWholePageOcrFallback = fileType.startsWith('image/');

  // ── 슬라이드 / 페이지 텍스트 + PNG 산출
  let slidesData: Array<{ pageIndex: number; text: string; png: Uint8Array }> = [];

  if (fileType === 'application/pdf' || fileType === DOCX_MIME) {
    // 옵션 2 (text + image): worker(Render) 환경에서 실행 — Vercel 의 60초/SIGSEGV 제약 없음.
    //  (1) 본문 텍스트는 pdf-parse 로 안정적으로 추출.
    //  (2) 페이지 이미지는 renderPdfPages(@napi-rs/canvas)로 렌더 → 의료 이미지 검출/crop.
    // 메모리(512MB) 보호: MAX_PDF_PAGES / PDF_RENDER_EDGE_PX 로 페이지 수·해상도 제한.
    // OCR 은 OCR_BACKEND=claude 로 고정해 tesseract wasm 을 메모리에 올리지 않는다.
    //
    // DOCX 는 LibreOffice 로 PDF 변환 후 동일 파이프라인을 재사용한다.
    let pdfBuffer = buffer;
    if (fileType === DOCX_MIME) {
      const converted = await convertOfficeToPdfBuffer(buffer, 'docx');
      if (!converted) {
        throw new Error(
          'DOCX 를 변환하지 못했습니다 (LibreOffice 필요). PDF 로 저장 후 업로드해 주세요.',
        );
      }
      pdfBuffer = converted;
    }

    // (1) 본문 텍스트 + (1-b) 임베드 이미지 추출/선별 — 서로 독립이므로 병렬 수행.
    //     (임베드 선별은 Vision AI 호출이라 네트워크 대기가 길다. pdf-parse 와 겹쳐
    //      초기 추출 단계 시간을 줄인다.)
    const [parsedFullText, embeddedCropsResult] = await Promise.all([
      // (1) 본문 텍스트 — 실패(null)해도 이미지 경로는 계속 진행.
      (async (): Promise<string | null> => {
        const t0 = Date.now();
        try {
          const { default: pdfParse } = await import('pdf-parse');
          const result = await pdfParse(Buffer.from(pdfBuffer));
          if (input.diag) {
            input.diag.timings.pdfParseMs = Date.now() - t0;
            input.diag.extract.pdfPages = result.numpages ?? null;
            input.diag.extract.textChars = (result.text ?? '').trim().length;
          }
          const parsed = (result.text ?? '').trim();
          // ★ 본문 텍스트가 나온 "즉시" 호출자에게 넘긴다.
          //   종전에는 아래 Promise.all 이 끝난 뒤(= 임베드 추출 + AI 선별까지 마친 뒤)
          //   전달해서, 텍스트가 5.5초에 준비되는데도 11~14초까지 붙들려 있었다.
          //   그래서 "텍스트 배치를 먼저 출발시켜 전처리를 숨긴다"는 최적화가 사실상
          //   작동하지 않았다(실측: 텍스트준비 = 첫배치시작 = 11.3~14.0초, 매번 임베드
          //   분기 소요와 일치). 여기서 넘기면 텍스트 배치가 6~8초 일찍 출발한다.
          sendEarlyText(parsed.slice(0, MAX_GEN_TEXT_CHARS));
          return parsed;
        } catch (e) {
          warnings.push(
            `PDF 본문 텍스트 추출 실패 — 페이지 이미지만 사용. ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
          return null;
        }
      })(),
      // (1-b) PDF 에 박힌 이미지 전부 직접 추출(object dedup) → AI 로 "시험용 의료 이미지"만 선별.
      //       텍스트 양과 무관하게 항상 수행 → 텍스트 위주 강의 PDF 에서도 X-ray/ECG 판독 문항 생성.
      (async (): Promise<CroppedImage[] | null> => {
        // '이미지형'을 선택하지 않은 요청에서는 크롭이 문항에 쓰이지 않는다.
        // mutool 실행 + AI 선별(Vision 호출)을 아예 하지 않아 추출 시간을 줄인다.
        if (!wantsImages) {
          if (input.diag) input.diag.embedded.mutoolRan = undefined; // 시도 자체를 생략
          return null;
        }
        const tEmbed = Date.now();
        try {
          // 1순위: pdfjs 로 PDF 안의 이미지 객체를 직접 추출한다.
          //   외부 바이너리(mutool)가 프로덕션(Vercel)에 없어 종전 경로는 항상 실패했고
          //   (ENOENT), 그 때문에 모든 이미지 PDF 가 비싼 폴백(전체 렌더 8.5초 + 페이지별
          //   Vision 19.1초)으로 떨어졌다. pdfjs 는 이미 렌더링에 쓰고 있어 추가 의존성이 없다.
          //   실측: 25페이지에서 이미지 17개를 2.0초에 추출.
          //   부수 효과 — 슬라이드에 겹쳐 그린 손글씨 주석은 이미지 객체에 포함되지 않아
          //   원본 그림만 깨끗하게 얻는다.
          const objDiag: Record<string, unknown> = {};
          let candidates: {
            png: Uint8Array;
            widthPx: number;
            heightPx: number;
            /** 1-based 출처 페이지(pdfjs 경로만 보유). 보충 Vision 의 중복 페이지 제외용. */
            pageIndex?: number;
          }[] = await extractPdfImageObjects(pdfBuffer, {
            maxImages: MAX_EMBEDDED_CANDIDATES,
            maxOutEdgePx: 1024,
            minEdgePx: EMBED_MIN_EDGE_PX,
            diag: objDiag,
          });
          if (input.diag) {
            input.diag.extract.pdfImageObjects = objDiag;
            input.diag.timings.imageObjectsMs = Date.now() - tEmbed;
          }
          // 2순위: mutool 기반 추출(로컬·Docker 환경에서만 동작). 실패해도 무해.
          if (candidates.length === 0) {
            candidates = await extractEmbeddedPdfImages(Buffer.from(pdfBuffer), {
              maxImages: MAX_EMBEDDED_CANDIDATES,
              maxOutEdgePx: 1024,
              diag: input.diag?.embedded,
            });
          }
          if (input.diag) input.diag.timings.embeddedExtractMs = Date.now() - tEmbed;
          if (candidates.length === 0) return null;
          // AI 선별: 로고·장식·표지·순수 도표 제외, 판독 가치 있는 의료 이미지만(개수는 내용에 따라 가변).
          const tSelect = Date.now();
          const selectDiag: SelectExamImagesDiag = {};
          const selected = await selectExamImages(candidates, {
            max: maxFeatured,
            diag: selectDiag,
            userIdForLog,
          });
          if (input.diag) {
            input.diag.embedded.selectMs = Date.now() - tSelect;
            // chosen 은 "절삭 후" 수치라 이것만으론 AI 가 몇 장을 통과시켰는지 알 수 없었다
            // (조사에서 실제로 오진을 유발했다). 절삭 전 판정 수·버려진 수를 함께 남긴다.
            input.diag.embedded.chosen = selected ? selected.length : null;
            input.diag.embedded.select = { ...selectDiag, max: maxFeatured };
          }
          const chosen =
            selected ??
            // 선별 실패(모델 오류/429) 시 면적 큰 순 폴백.
            candidates
              .slice(0, maxFeatured)
              .map((im) => ({ image: im, kind: 'other' as const }));
          warnings.push(
            `임베드 이미지 ${candidates.length}개 추출 → 선별 ${chosen.length}개 사용${selected ? '' : '(선별 실패·폴백)'}.`,
          );
          if (chosen.length === 0) return null;
          // 보충 Vision 의 중복 방지용 출처 페이지 기록. 프로덕션 경로(pdfjs 추출)만
          // pageIndex 를 보유한다 — mutool 폴백(로컬 전용)은 페이지 미상이라 기록 없음.
          for (const { image } of chosen) {
            if (typeof image.pageIndex === 'number') embeddedPagesUsed.add(image.pageIndex);
          }
          return chosen.map(({ image, kind }) => ({
            region: { kind, x: 0, y: 0, width: 1, height: 1, confidence: 1 },
            png: image.png,
            widthPx: image.widthPx,
            heightPx: image.heightPx,
          }));
        } catch (e) {
          warnings.push(
            `임베드 이미지 추출/선별 실패 — Vision 경로로 폴백. ${e instanceof Error ? e.message : String(e)}`,
          );
          return null;
        }
      })(),
    ]);
    const fullText = parsedFullText ?? '';
    if (parsedFullText !== null) {
      allowWholePageOcrFallback = fullText.length < 1500;
    }
    if (fullText.length > MAX_GEN_TEXT_CHARS) {
      // 종전에는 경고 없이 잘라 뒤쪽 내용이 출제 근거에서 조용히 빠졌다.
      warnings.push(
        `본문 텍스트 ${fullText.length.toLocaleString()}자 중 앞 ${MAX_GEN_TEXT_CHARS.toLocaleString()}자만 출제 근거로 사용(뒷부분 절삭).`,
      );
      if (input.diag) input.diag.extract.textTruncated = fullText.length - MAX_GEN_TEXT_CHARS;
    }
    pdfEmbeddedCrops = embeddedCropsResult;
    // 임베드가 소수만 나오면 벡터로 그려진 다이어그램·차트(래스터 객체 아님)가 못 잡힌
    // 자료일 가능성이 높다 — 이미지형 요청에 한해 페이지 렌더+Vision 검출을 병행해
    // 후보를 보충한다(임베드가 나온 페이지는 제외해 중복 등재 방지).
    supplementVision =
      wantsImages &&
      pdfEmbeddedCrops !== null &&
      pdfEmbeddedCrops.length > 0 &&
      pdfEmbeddedCrops.length < EMBED_SUPPLEMENT_MIN;
    if (supplementVision) {
      warnings.push(
        `임베드 이미지 ${pdfEmbeddedCrops?.length}장뿐 — Vision 검출을 병행해 후보 보충.`,
      );
    }
    // ★ OCR 스트리밍: 임베드 크롭도 확보 즉시 OCR 출발(이후의 보충 렌더·Vision 과 겹친다).
    //   context 는 이 크롭들이 붙는 slides[0] 의 텍스트(본문 슬라이스)와 동일하게 준다.
    if (pdfEmbeddedCrops) {
      for (const crop of pdfEmbeddedCrops) {
        input.startOcr?.(fullText.slice(0, MAX_GEN_TEXT_CHARS), 1, crop);
      }
    }

    // ★ 텍스트 조기 전달 — 호출자가 이 시점에 텍스트 배치를 먼저 출발시켜
    //   아래 렌더·Vision·OCR 시간을 생성 시간 뒤로 숨긴다.
    sendEarlyText(fullText);

    // ★ 이미지 분석 생략 판정: 이미지 문항을 원하지 않고 본문 텍스트가 충분하면
    //   페이지 렌더 + Vision 검출 + 크롭을 건너뛴다(크롭이 없으므로 OCR 도 자동 생략).
    //   텍스트가 부족한 스캔 자료(allowWholePageOcrFallback)는 OCR 이 유일한 내용원이라 유지.
    skipImageAnalysis = !wantsImages && !allowWholePageOcrFallback;
    if (input.diag) {
      input.diag.extract.skipImageAnalysis = skipImageAnalysis;
      input.diag.extract.allowWholePageOcrFallback = allowWholePageOcrFallback;
      input.diag.extract.embeddedCropsUsed = pdfEmbeddedCrops !== null;
      input.diag.extract.embeddedSupplementVision = supplementVision;
    }
    if (skipImageAnalysis) {
      warnings.push(
        `이미지형 미선택 + 본문 텍스트 ${fullText.length}자 확보 → 페이지 렌더·Vision·OCR 생략(텍스트 전용 경로).`,
      );
    }

    // (2) 페이지 이미지 — 의료 이미지 검출/crop 용.
    //
    // ★ 속도 최적화: 본문 텍스트가 충분히 추출된(=텍스트 위주) 자료는 페이지 렌더 +
    //   페이지별 Vision(의료이미지 검출) + OCR 을 통째로 생략하고 텍스트만으로 생성한다.
    //   강의록·시험 복기 같은 텍스트 위주 PDF 는 페이지가 많아도 이 경로로 1회 생성 호출만
    //   하게 되어 대용량(수십 페이지)도 빠르게 완료된다. (Vision 호출이 페이지 수만큼
    //   순차 누적돼 수 분씩 걸리던 문제 해소.)
    //   텍스트가 부족한(스캔/이미지 위주) 자료만 기존 페이지 렌더 + Vision 경로를 탄다.
    let pages: Awaited<ReturnType<typeof renderPdfPages>> = [];
    try {
      if ((!pdfEmbeddedCrops || supplementVision) && !skipImageAnalysis) {
        if (allowWholePageOcrFallback) {
          const tAll = Date.now();
          pages = await renderPdfPages(pdfBuffer, {
            maxPages: MAX_PDF_PAGES,
            maxEdgePx: PDF_RENDER_EDGE_PX,
          });
          if (input.diag) {
            input.diag.timings.renderAllPagesMs = Date.now() - tAll;
            input.diag.extract.renderedPages = pages.length;
          }
        } else {
          const tScan = Date.now();
          const scanPages = await renderPdfPages(pdfBuffer, {
            maxPages: MAX_PDF_PAGES,
            maxEdgePx: PDF_SCAN_EDGE_PX,
          });
          const tScore = Date.now();
          let candidatePages = await selectLikelyImagePages(scanPages, {
            // 이미지형 요청은 임계 미달이어도 점수 상위 페이지를 채워 최소 후보를 보장
            // (흰 배경 회색조 영상·얇은 선 다이어그램의 휴리스틱 탈락 방지).
            minSelected: wantsImages ? Math.min(6, scanPages.length) : 0,
          });
          if (supplementVision) {
            candidatePages = candidatePages.filter((p) => !embeddedPagesUsed.has(p));
          }
          const tCand = Date.now();
          if (candidatePages.length > 0) {
            pages = await renderPdfPages(pdfBuffer, {
              pages: candidatePages,
              maxPages: MAX_PDF_PAGES,
              maxEdgePx: PDF_RENDER_EDGE_PX,
            });
          }
          if (input.diag) {
            input.diag.timings.renderScanMs = tScore - tScan;
            input.diag.timings.scoreMs = tCand - tScore;
            input.diag.timings.renderCandidatesMs = Date.now() - tCand;
            input.diag.extract.scanPages = scanPages.length;
            input.diag.extract.candidatePages = candidatePages.length;
          }
          warnings.push(
            `로컬 이미지 후보 선별: 전체 ${scanPages.length}페이지 중 ${candidatePages.length}페이지 Vision 대상.`,
          );
        }
      }
      } catch (e) {
        warnings.push(
          `PDF 페이지 렌더 실패 — 텍스트만 사용. ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
    }

    if (slidesData.length > 0) {
      // 텍스트 위주 경로에서 이미 slidesData 를 채웠으면 그대로 사용.
    } else if (pages.length > 0) {
      // 본문 텍스트는 페이지 단위 분리가 어려워 첫 페이지에 부여, 이미지는 페이지별.
      slidesData = pages.map((p, i) => ({
        pageIndex: p.pageIndex,
        text: i === 0 ? fullText.slice(0, MAX_GEN_TEXT_CHARS) : '',
        png: p.png,
      }));
    } else {
      // 렌더 실패 폴백: 텍스트만 (이미지 단계는 png.length === 0 으로 자동 skip).
      if (!fullText) {
        warnings.push(
          'PDF 에서 텍스트·이미지를 모두 추출하지 못했습니다. 스캔 품질/파일 상태를 확인하세요.',
        );
      }
      slidesData = [{ pageIndex: 1, text: fullText.slice(0, MAX_GEN_TEXT_CHARS), png: new Uint8Array() }];
    }
  } else if (fileType === PPTX_MIME) {
    const parsed = parsePptx(buffer);
    warnings.push(...parsed.warnings);

    // 1) 환경에 LibreOffice 가 있으면 슬라이드 전체 렌더 시도.
    //    실패하면 media-only fallback 으로 떨어짐.
    let renderedPages: Array<{ pageIndex: number; png: Uint8Array }> | null = null;
    try {
      renderedPages = await tryRenderPptxViaLibreOffice(buffer);
    } catch (e) {
      warnings.push(
        `LibreOffice 변환 실패 — media 임베드 이미지만 사용. ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      renderedPages = null;
    }

    if (renderedPages && renderedPages.length > 0) {
      // 슬라이드 텍스트는 parsed.slides 에서 가져와 매핑 (페이지 순서 동일 가정).
      slidesData = renderedPages.map((p) => {
        const slideText = parsed.slides[p.pageIndex - 1]?.text ?? '';
        return { pageIndex: p.pageIndex, text: slideText, png: p.png };
      });
    } else {
      // 2) Fallback: ppt/media 임베드 이미지만 사용.
      //    Vision/crop/OCR 파이프라인이 모두 PNG (`media_type: 'image/png'`) 가정으로 동작하므로
      //    JPEG/WebP/BMP 같은 비-PNG 임베드 이미지는 normalizeToPng 으로 재인코딩한다.
      //    normalize 실패(EMF/WMF/손상) 는 warning 후 skip — 슬라이드 텍스트는 보존.
      for (const slide of parsed.slides) {
        if (slide.imageRefs.length === 0) {
          slidesData.push({
            pageIndex: slide.index,
            text: slide.text,
            png: new Uint8Array(),
          });
          continue;
        }
        let kept = 0;
        for (const ref of slide.imageRefs) {
          const bin = parsed.media.get(ref);
          if (!bin) continue;
          const png = await normalizeToPng(bin);
          if (!png) {
            warnings.push(
              `slide ${slide.index}: 임베드 이미지 ${ref} 를 PNG 로 변환 실패 — skip`,
            );
            continue;
          }
          slidesData.push({
            pageIndex: slide.index,
            text: slide.text,
            png,
          });
          kept += 1;
        }
        // 모든 이미지가 변환 실패였다면 텍스트만 진행할 수 있도록 빈 페이지 한 줄 추가.
        if (kept === 0) {
          slidesData.push({
            pageIndex: slide.index,
            text: slide.text,
            png: new Uint8Array(),
          });
        }
      }
    }
  } else if (fileType === PPT_MIME) {
    // 레거시 .ppt (OLE 바이너리) — PPTX 처럼 XML 파싱이 불가하므로
    // LibreOffice 렌더에 전적으로 의존한다. 변환 실패 시 폴백 없음 → 명확히 throw.
    let renderedPages: Array<{ pageIndex: number; png: Uint8Array }> | null = null;
    try {
      renderedPages = await tryRenderPptxViaLibreOffice(buffer, 'ppt');
    } catch (e) {
      throw new Error(
        `레거시 .ppt 변환 실패 — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (!renderedPages || renderedPages.length === 0) {
      throw new Error(
        '레거시 .ppt 를 변환하지 못했습니다 (LibreOffice 필요). PDF 또는 .pptx 로 저장 후 업로드해 주세요.',
      );
    }
    slidesData = renderedPages.map((p) => ({
      pageIndex: p.pageIndex,
      text: '',
      png: p.png,
    }));
  } else if (
    fileType === 'image/png' ||
    fileType === 'image/jpeg' ||
    fileType === 'image/webp'
  ) {
    slidesData.push({
      pageIndex: 1,
      text: '',
      png: new Uint8Array(buffer),
    });
  } else {
    throw new Error(`Unsupported file_type: ${fileType}`);
  }

  // ── 각 슬라이드/페이지에서 의료 이미지 검출 + crop.
  //    png 가 있는(=이미지 분석 대상) 슬라이드 중 앞에서 MAX_VISION_SLIDES 개를 병렬 처리.
  //    입력 순서를 보존하기 위해 인덱스 기반으로 결과를 채운다.
  const slides: ExtractedSlide[] = new Array(slidesData.length);

  const visionIndices: number[] = [];
  for (let i = 0; i < slidesData.length; i++) {
    const s = slidesData[i];
    if (
      (!pdfEmbeddedCrops || supplementVision) &&
      !skipImageAnalysis &&
      s.png.length > 0 &&
      visionIndices.length < MAX_VISION_SLIDES
    ) {
      visionIndices.push(i);
    } else {
      // 텍스트만 슬라이드 또는 상한 초과 → 이미지 검출 skip(텍스트는 보존).
      slides[i] = { pageIndex: s.pageIndex, text: s.text, croppedImages: [] };
    }
  }

  // 선정된 페이지들의 검출+crop+전처리를 병렬로 수행 (순차 대비 대용량 스캔 대폭 가속).
  const tVision = Date.now();
  await mapWithConcurrency(
    visionIndices,
    VISION_CONCURRENCY,
    async (idx) => {
      const s = slidesData[idx];
      try {
        const det = await detectMedicalRegions({ slidePng: s.png, userIdForLog });
      // fallback: 의료 이미지 검출 0건인 페이지는 페이지 전체를 region 으로 잡아
      // OCR/Claude 가 슬라이드 텍스트·도표를 볼 수 있게 한다.
      // 단, 이 "페이지 전체" 크롭은 ocrOnly 로 표시해 문항 이미지로는 노출하지 않는다
      // (주석 텍스트·다중 그림·정답 단서 혼입 방지).
      const isWholePageFallback = det.regions.length === 0;
      const regionsToUse =
        det.regions.length > 0
          ? det.regions
          : allowWholePageOcrFallback
            ? [{ kind: 'other' as const, x: 0, y: 0, width: 1, height: 1, confidence: 1 }]
            : [];
      const cropped = await cropRegions(s.png, regionsToUse);
      const preprocessed: CroppedImage[] = [];
      for (const c of cropped) {
        try {
          // OCR 용 전처리(대비 정규화/흑백)는 별도 이미지(ocrPng)로 유지하고,
          // 표시·인페인팅에 쓰는 원본 색상 크롭(c.png)은 그대로 보존한다
          // (전처리본을 그대로 보여주면 컬러 다이어그램이 흑백/저채도로 표시되는 문제 방지).
          const ocrPng = await preprocessForOcr(c.png, {
            grayscale: c.region.kind === 'ecg' || c.region.kind === 'xray',
            normalizeContrast: true,
          });
          preprocessed.push({ ...c, ocrPng, ocrOnly: isWholePageFallback });
        } catch (e) {
          warnings.push(
            `slide ${s.pageIndex}: 전처리 실패 — ${e instanceof Error ? e.message : String(e)}`,
          );
          preprocessed.push({ ...c, ocrOnly: isWholePageFallback }); // 원본 그대로 진행
        }
      }
        // ★ OCR 스트리밍: 이 페이지의 크롭이 준비된 즉시 OCR 을 출발시켜
        //   아직 처리 중인 다른 페이지들의 Vision 검출과 겹친다.
        for (const crop of preprocessed) input.startOcr?.(s.text, s.pageIndex, crop);
        slides[idx] = { pageIndex: s.pageIndex, text: s.text, croppedImages: preprocessed };
      } catch (e) {
        warnings.push(
          `slide ${s.pageIndex}: 영역 검출 실패 — ${e instanceof Error ? e.message : String(e)}`,
        );
        slides[idx] = { pageIndex: s.pageIndex, text: s.text, croppedImages: [] };
      }
      return null;
    },
    input.onVisionProgress,
  );
  if (input.diag) {
    input.diag.timings.visionMs = Date.now() - tVision;
    input.diag.extract.visionPages = visionIndices.length;
  }

  const imagePages = slidesData.filter((s) => s.png.length > 0).length;
  if (imagePages > MAX_VISION_SLIDES) {
    warnings.push(
      `이미지 페이지 ${imagePages}장 중 ${MAX_VISION_SLIDES}장만 이미지 검출 수행 (상한).`,
    );
  }

  // PDF 임베드 추출이 있으면 그것을 featured 이미지로 우선 사용.
  //  - 보충 모드: 임베드(원본 화질·주석 없음)를 앞에 두고 Vision 크롭을 뒤에 유지한다.
  //    featured 선정이 슬라이드 순회 순서를 따르므로 임베드가 우선 사용되고, 임베드가
  //    나온 페이지는 후보에서 이미 제외돼 같은 그림이 중복 등재되지 않는다.
  //  - 단독 모드(종전): Vision crop 결과를 통째로 대체(중복 방지).
  if (pdfEmbeddedCrops && pdfEmbeddedCrops.length > 0 && slides.length > 0) {
    if (supplementVision) {
      slides[0].croppedImages = [...pdfEmbeddedCrops, ...slides[0].croppedImages];
    } else {
      slides[0].croppedImages = pdfEmbeddedCrops;
      for (let i = 1; i < slides.length; i++) {
        if (slides[i]) slides[i].croppedImages = [];
      }
    }
  }

  sendEarlyText(slides.map((s) => s.text).join('\n\n'));
  return { slides };
}

export async function generatePrivateQuestionsFromUpload(
  input: PrivateGenerationInput,
): Promise<PrivateGenerationResult> {
  const admin = createAdminClient();
  const desiredCount = input.desiredCount ?? 12;
  const style = input.style ?? 'kmle';

  const updateProgress = async (
    stage: string,
    current = 0,
    total = 0,
    extra: Record<string, unknown> = {},
  ) => {
    await admin
      .from('user_uploads')
      .update({
        processing_stage: stage,
        progress_current: current,
        progress_total: total,
        heartbeat_at: new Date().toISOString(),
        ...extra,
      })
      .eq('id', input.uploadId);
  };

  // 1) Upload 조회
  const { data: upload, error: uploadErr } = await admin
    .from('user_uploads')
    .select('id, user_id, file_name, file_type, storage_path, status')
    .eq('id', input.uploadId)
    .maybeSingle();

  if (uploadErr || !upload) {
    throw new Error(`Upload not found: ${input.uploadId}`);
  }
  if (upload.user_id !== input.userId) {
    throw new Error('Upload ownership mismatch');
  }
  // 아래 배치 생성 함수는 function 선언(호이스팅)이라 TS 가 upload 의 null 배제
  // 내로잉을 함수 본문에 전파하지 않는다 — non-null 로 확정된 별칭을 캡처시킨다.
  const uploadRow = upload;

  // 처리 시작 상태 + **이번 요청이 무엇을 요구했는지**(P2).
  // 요청 난이도·유형이 DB 에 없으면 "임상형을 요청했을 때 임상형이 몇 % 나왔나",
  // "'상'을 요청했을 때 난이도 3 이 몇 % 인가" 를 SQL 로 물을 수 없다 —
  // ② 이후의 프롬프트 수정이 개선인지 증명하는 기준선이 이 네 컬럼이다.
  const progressUpdate = {
    status: 'processing' as const,
    processing_stage: 'downloading',
    progress_current: 0,
    progress_total: 0,
    completed_question_count: 0,
    target_question_count: desiredCount,
    heartbeat_at: new Date().toISOString(),
    error_message: null,
  };
  const requestConditions = {
    requested_difficulty: input.difficulty ?? null,
    requested_types: input.questionTypes ?? [],
    generation_style: style,
    reference_count: (input.referenceUploadIds ?? []).length,
    // P5 — 무엇을 초점으로 요청했는지. "주제를 준 요청이 실제로 그 주제를 다뤘나"를
    // 나중에 재려면 요청값이 남아 있어야 한다(요청 유형·난이도를 남긴 것과 같은 이유).
    requested_topic: input.topic?.trim() || null,
    requested_keywords: (input.keywords ?? []).map((k) => k.trim()).filter(Boolean),
  };
  const { error: startErr } = await admin
    .from('user_uploads')
    .update({ ...progressUpdate, ...requestConditions })
    .eq('id', upload.id);
  if (startErr) {
    // 00040 미적용 환경 — 계측을 포기하고 처리 상태만 다시 기록한다(기능 정지가 더 나쁘다).
    if (isMissingColumnError(startErr)) {
      console.warn('[private-gen] 요청 조건 컬럼 없음(00040 미적용) — 계측 생략');
      await admin.from('user_uploads').update(progressUpdate).eq('id', upload.id);
    } else {
      // 그 밖의 실패는 종전과 같이 넘긴다. 상태가 안 박히면 고착 회복 크론이 정리한다.
      console.warn('[private-gen] 처리 시작 상태 기록 실패:', startErr.message);
    }
  }

  // 살아있는 동안 heartbeat 를 주기적으로 갱신한다. 큐의 고착 회복 로직이
  // "heartbeat 가 오래됨 = 워커가 죽음" 으로 판단하므로, 대용량 PDF 추출처럼 단계 갱신
  // 없이 수 분이 걸리는 구간에서도 살아있음을 알려야 멀쩡한 작업이 중복 실행되지 않는다.
  const heartbeatTimer = setInterval(() => {
    void admin
      .from('user_uploads')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', input.uploadId)
      .then(() => undefined, () => undefined);
  }, 20_000);

  const startTime = Date.now();
  // 진단 기록 함수 — try 안에서 준비되지만 실패 경로(catch)에서도 호출해야 하므로 외부에 둔다.
  let writeDiagnostics: (() => Promise<void>) | null = null;
  let totalCost = 0;
  // 진단 기록용 — 참고자료 로드 전(다운로드 실패 등)에도 안전하게 읽히도록 let 로 둔다.
  let referenceImageCount = 0;
  /** 형식을 못 읽어 반영하지 못한 참고 자료 수(P8 알림). */
  let referenceSkippedCount = 0;
  let aggInputTokens = 0;
  let aggOutputTokens = 0;
  let modelUsed = MODELS.generation();

  try {
    // 2) 다운로드
    const tDownload = Date.now();
    const { data: fileBlob, error: dlErr } = await admin.storage
      .from(STORAGE_BUCKET)
      .download(upload.storage_path);
    if (dlErr || !fileBlob) {
      throw new Error(`Storage download failed: ${dlErr?.message}`);
    }
    const fileBuffer = await fileBlob.arrayBuffer();
    // 원본 내용 해시 — 같은 자료를 다시 올렸는지 판정하는 축(P11 재생성 중복 방지가 쓴다).
    // 파일명·크기는 같은 자료를 다른 이름으로 올리면 갈라지므로 내용으로 잰다.
    const contentSha256 = createHash('sha256').update(Buffer.from(fileBuffer)).digest('hex');
    const { error: shaErr } = await admin
      .from('user_uploads')
      .update({ content_sha256: contentSha256 })
      .eq('id', upload.id);
    if (shaErr && !isMissingColumnError(shaErr)) {
      console.warn('[private-gen] content_sha256 기록 실패:', shaErr.message);
    }
    // ── 세션 간 중복 방지 (P11): 같은 자료를 전에 올린 적이 있으면 그때 만든 발문을 가져온다.
    //
    // 운영 전체에서 발문이 완전히 동일한 문항이 37건 있었다 — 같은 파일 재업로드다.
    // 임베딩 유사도 대신 발문 앞부분을 그대로 보여 주고 피하게 한다(Voyage 임베딩이
    // 2026-07-21 이후 죽어 있어 그 경로는 지금 없다).
    //
    // 지금 await 하지 않는다 — 텍스트 선발사(prefire)가 이 조회를 기다리면 안 된다.
    // 배치가 자기 지시문을 만들 때 짧은 상한으로 받아 간다.
    const priorStemsPromise: Promise<string[]> = (async () => {
      try {
        const { data: sameFileUploads, error: upErr } = await admin
          .from('user_uploads')
          .select('id')
          .eq('user_id', upload.user_id)
          .eq('content_sha256', contentSha256)
          .neq('id', upload.id)
          .limit(10);
        if (upErr || !sameFileUploads?.length) return [];
        const { data: priorQuestions, error: qErr } = await admin
          .from('private_questions')
          .select('stem, created_at')
          .in(
            'upload_id',
            sameFileUploads.map((u) => u.id),
          )
          .order('created_at', { ascending: false })
          .limit(PRIOR_STEM_LIMIT);
        if (qErr || !priorQuestions) return [];
        return priorQuestions.map((q) => String(q.stem ?? ''));
      } catch (e: unknown) {
        // 조회 실패는 생성을 막지 않는다 — 중복 방지는 있으면 좋은 것이지 필수가 아니다.
        console.warn(
          '[private-gen] 이전 발문 조회 실패(생략):',
          e instanceof Error ? e.message.slice(0, 140) : String(e),
        );
        return [];
      }
    })();
    // ── 진단 수집 시작. 단계별 소요와 세부 수치를 모아 마지막에 Storage 로 남긴다.
    const diag: {
      timings: Record<string, number>;
      extract: Record<string, unknown>;
      embedded: ExtractEmbeddedDiagnostic & {
    selectMs?: number;
    chosen?: number | null;
    /** 상한 절삭 전 판정 결과 — chosen(절삭 후)만으론 원인 규명이 안 됐던 문제 대응. */
    select?: SelectExamImagesDiag & { max?: number };
  };
      generation: Record<string, unknown>;
      inpaint: unknown[];
      batches: unknown[];
    } = { timings: {}, extract: {}, embedded: {}, generation: {}, inpaint: [], batches: [] };
    diag.timings.queueToStartMs = tDownload - startTime;
    diag.timings.downloadMs = Date.now() - tDownload;
    diag.extract.fileSizeBytes = fileBuffer.byteLength;

    /**
     * 진단 JSON 을 Storage 에 남긴다(스키마 변경 없이 조회 가능).
     * 경로: {userId}/{uploadId}/diagnostics.json — GET /api/uploads/[id]/diagnostics 로 읽는다.
     * 실패해도 본 처리에 영향을 주지 않는다.
     */
    writeDiagnostics = async (): Promise<void> => {
      try {
        const payload: GenerationDiagnostics = {
          uploadId: uploadRow.id,
          fileType: upload.file_type,
          fileSizeBytes: fileBuffer.byteLength,
          wantsImages,
          desiredCount,
          requestedDifficulty: input.difficulty ?? null,
          requestedTypes: input.questionTypes ?? [],
          referenceImages: referenceImageCount,
          timings: { ...diag.timings, totalMs: Date.now() - startTime },
          extract: diag.extract,
          embedded: diag.embedded,
          generation: diag.generation,
          inpaint: diag.inpaint,
          batches: diag.batches,
          // 경고는 개수·페이지 번호 위주라 강의 내용이 들어가지 않는다. 방어적으로 길이 제한.
          warnings: warnings.slice(0, 60).map((w) => String(w).slice(0, 300)),
          finishedAt: new Date().toISOString(),
        };
        // 저장소: ai_cost_log.metadata (jsonb).
        // Storage 에 JSON 으로 넣으려 했지만 user_uploads 버킷의 allowed_mime_types 가
        // pdf/pptx/이미지/dicom 만 허용해 application/json 업로드가 거부됐다(조용히 실패).
        // 마이그레이션 없이 쓸 수 있는 jsonb 컬럼으로 옮긴다. cost_usd=0 이라 비용 집계에
        // 영향을 주지 않으며, endpoint 로 진단 행임을 구분한다.
        const { error: diagErr } = await admin.from('ai_cost_log').insert({
          user_id: input.userId,
          endpoint: 'private.diagnostics',
          model: modelUsed,
          cost_usd: 0,
          input_tokens: 0,
          output_tokens: 0,
          metadata: payload as unknown as Record<string, unknown>,
        });
        if (diagErr) console.warn('[private-gen] 진단 기록 실패:', diagErr.message);
      } catch (e) {
        console.warn(
          '[private-gen] 진단 기록 예외:',
          e instanceof Error ? e.message : String(e),
        );
      }
    };

    // 3) 추출 · 참고자료 · 분류 카탈로그를 동시에 시작한다(서로 독립).
    //
    //    ★ 전처리와 생성의 중첩: 추출은 "본문 텍스트"를 확보한 즉시 onEarlyText 로 알려주고,
    //      호출자는 그 시점에 텍스트 배치를 먼저 출발시킨다. 그래서 페이지 렌더·Vision·OCR
    //      시간이 생성 시간 뒤로 숨는다(예전에는 추출·Vision·OCR 이 모두 끝나야 생성 시작).
    await updateProgress('extracting');
    const warnings: string[] = [];
    // '이미지형'을 고르지 않았다면 크롭이 문항에 쓰이지 않으므로 이미지 분석을 생략할 수 있다.
    const wantsImages = (input.questionTypes ?? []).includes('이미지형');
    // 이번 요청의 문항 이미지 상한 — 요청 문항 수에 연동(고정 8이 공급 병목이었다).
    const featuredCap = featuredBudget(desiredCount);

    // ── 크롭 OCR 스트리밍(이미지 준비 조기화)
    // 추출이 크롭을 만든 즉시 여기로 넘겨 OCR 을 출발시킨다(남은 페이지 Vision 과 겹침).
    // 아래 OCR "단계"는 시작 보장 + 완료 대기만 담당하게 된다. 동시성은 종전과 동일하게
    // OCR_CONCURRENCY 로 제한한다(슬롯 이양 세마포어 — 해제·획득 사이에 새 작업이
    // 끼어들어 동시성이 초과되지 않게 대기자에게 슬롯을 그대로 넘긴다).
    let ocrChars = 0;
    let ocrActive = 0;
    const ocrWaiters: Array<() => void> = [];
    const ocrTasks = new Map<CroppedImage, Promise<void>>();
    const startCropOcr = (slideText: string, pageIndex: number, crop: CroppedImage): void => {
      if (ocrTasks.has(crop)) return;
      const task = (async () => {
        if (ocrActive < OCR_CONCURRENCY) {
          ocrActive += 1;
        } else {
          await new Promise<void>((resolve) => ocrWaiters.push(resolve));
        }
        try {
          const r = await runOcr({
            png: crop.ocrPng ?? crop.png, // OCR 은 전처리본, 표시는 원본 색상 유지
            userIdForLog: input.userId,
            context: slideText,
            // 같은 호출에서 텍스트 "위치"까지 받아온다(추가 API 호출 없음).
            // 이 좌표로 정답 단서 텍스트를 배경색으로 덮어 지운다.
            withBoxes: true,
            widthPx: crop.widthPx,
            heightPx: crop.heightPx,
          });
          // 단일 동기 문장 += 는 JS 이벤트루프 상 원자적이라 병렬 누적에 안전.
          totalCost += r.costUsd;
          ocrChars += r.text.length;
          crop.ocrText = r.text; // 주석 텍스트 유무 판정에 사용
          crop.ocrBoxes = r.boxes; // 마스킹 좌표(없으면 안전 폴백 경로)
        } catch (e) {
          warnings.push(
            `slide ${pageIndex}: OCR 실패 — ${e instanceof Error ? e.message : String(e)}`,
          );
        } finally {
          const next = ocrWaiters.shift();
          if (next) next(); // 슬롯 이양 — ocrActive 유지
          else ocrActive -= 1;
        }
      })();
      ocrTasks.set(crop, task);
    };

    let resolveEarlyText: (text: string) => void = () => {};
    const earlyText = new Promise<string>((resolve) => {
      resolveEarlyText = resolve;
    });

    const tExtract = Date.now();
    const extractPromise = extractFromBuffer({
      buffer: fileBuffer,
      fileType: upload.file_type,
      userIdForLog: input.userId,
      wantsImages,
      maxFeatured: featuredCap,
      warnings,
      diag,
      startOcr: startCropOcr,
      onEarlyText: (text) => {
        diag.timings.textReadyMs = Date.now() - startTime;
        resolveEarlyText(text);
      },
      onVisionProgress: async (completed, total) =>
        updateProgress('vision', completed, total),
    });
    extractPromise
      .then(() => { diag.timings.extractTotalMs = Date.now() - tExtract; })
      .catch(() => {});
    const referencePromise = loadReferenceImages({
      uploadIds: input.referenceUploadIds ?? [],
      userId: input.userId,
    });
    // 추출이 실패해도 earlyText 가 영원히 대기하지 않게 방어한다.
    extractPromise.catch(() => resolveEarlyText(''));

    const subTopicsRes = await admin
      .from('sub_topics')
      .select('id, code, name, subject:subjects ( name )');
    // 참고자료는 선발사 배치가 클로저로 참조하므로 반드시 그 전에 확정해야 한다
    //  (const 초기화 전 접근 = ReferenceError). 추출과 병렬로 이미 시작돼 있어 대기 비용은 없다.
    const referenceLoaded = await referencePromise;
    const referenceImages = referenceLoaded.images;
    referenceImageCount = referenceImages.length;
    referenceSkippedCount = referenceLoaded.skipped;
    if (referenceSkippedCount > 0) {
      warnings.push(
        `참고 자료 ${referenceSkippedCount}건은 형식을 읽지 못해 반영하지 못했습니다(PDF·PPTX·DOCX·이미지 지원).`,
      );
    }
    // 참고 자료 형식 프로파일(P7) — 텍스트를 읽은 자료가 있으면 1회 호출로 요약한다.
    // 요약은 시스템 프롬프트(캐시 대상)에 붙으므로 배치가 늘어도 비용이 늘지 않는다.
    const referenceProfile = await summarizeReferenceFormat({
      texts: referenceLoaded.texts,
      userId: input.userId,
      onCost: (usd) => {
        totalCost += usd;
      },
    });
    diag.generation.referenceTexts = referenceLoaded.texts.length;
    diag.generation.referenceProfile = referenceProfile;
    // 프로파일을 못 쓰게 된 사유. "문항이 없어서"와 "종결 형태가 의미 없어서"는 원인이 다르고,
    // 후자는 프로파일 품질 문제라 프롬프트를 고쳐야 한다(실측에서 영문 자료가 그랬다).
    // isUsableProfile 은 타입 술어라 부정 분기 안에서는 referenceProfile 이 null 로 좁혀진다 —
    // 그래서 사유는 **분기 밖에서** 미리 계산해 둔다.
    const referenceProfileWhy = !referenceProfile
      ? '요약 호출 실패'
      : referenceProfile.observed_questions <= 0
        ? '문항 형태가 없음'
        : '발문 종결을 뽑지 못함';
    if (referenceLoaded.texts.length > 0 && !isUsableProfile(referenceProfile)) {
      warnings.push(
        `참고 자료 형식 프로파일을 쓰지 못했습니다(${referenceProfileWhy}) — 기본 규격으로 생성합니다.`,
      );
    }

    // 4) 분류 카탈로그·생성 프롬프트·배치 계획을 OCR "이전"에 준비한다 — 본문 텍스트가
    //    충분한 자료는 아래 "텍스트 선발사 배치"가 OCR 과 병행으로 먼저 출발할 수 있게.
    type CatalogRow = {
      id: string;
      code: string;
      name: string;
      subject: { name: string } | { name: string }[] | null;
    };
    const catalog = (subTopicsRes.data ?? []).map((row) => {
      const s = row as CatalogRow;
      const subj = Array.isArray(s.subject) ? s.subject[0] : s.subject;
      return {
        id: s.id,
        code: s.code,
        name: s.name,
        subject_name: subj?.name ?? '',
      };
    });
    const codeToId = new Map(catalog.map((c) => [c.code, c.id]));

    const catalogText = catalog
      .map((c) => `  - ${c.subject_name} > ${c.name} (code: \`${c.code}\`)`)
      .join('\n');
    let systemPrompt = PRIVATE_GENERATION_SYSTEM_PROMPT.replace(
      '{SUB_TOPIC_CATALOG}',
      catalogText,
    );
    // 사용자 지정 난이도·문항유형을 생성 지시로 반영.
    // 선택된 유형은 난이도 지시(지식형 전용 문단)에서 먼저 참조하므로 여기서 확정한다.
    const selectedTypes = input.questionTypes ?? [];
    const wantsClinical = selectedTypes.includes('임상형');
    const wantsKnowledge = selectedTypes.includes('지식형');

    // P4 난이도 조작적 정의.
    //
    // 종전에는 "쉬운/표준/어려운 난이도 위주(difficulty 1~2 / 2 / 2~3)" 한 줄이었다. 무엇이
    // 어려워지는지(인지 수준·감별 폭·수치 해석 유무·오답 근접도)를 말하지 않으니 모델도 알 수
    // 없었고, 하(1~2)와 상(2~3)이 2 에서 겹쳐 요청이 달라도 결과가 같았다.
    // 실측: 저장된 difficulty 의 85 %가 2, 요청 '상' 에서도 3 이 6/10 뿐.
    //
    // 값은 요청에 맞춰 올리라고 하지 않는다(A안 — 정직 신고). 모델이 만든 문항의 실제 수준을
    // 적게 하고, 서버가 요청값과 대조해 mismatch 를 센다. 강제 일치시키면 신고값이 요청값의
    // 사본이 되어 "요청대로 나왔는가"를 재는 신호가 사라진다.
    const DIFFICULTY_DIRECTIVES: Record<'하' | '중' | '상', string> = {
      '하':
        '**난이도 하(재인)**: 자료가 가르친 개념 하나를 그대로 묻는다 — 정의·대표 소견·1차 약물·' +
        '대표 위험인자. 증례를 쓴다면 전형적인 양상으로만 쓰고, 소견 하나로 답이 정해지게 한다. ' +
        '오답은 범주가 달라도 된다(명백히 다른 질환군).',
      '중':
        '**난이도 중(적용)**: 두 개 이상의 소견·조건을 통합해야 답이 나오게 한다 — 진단 후 표준 치료, ' +
        '금기 하나를 반영한 약물 선택, 검사 결과와 증상의 결합. 감별 후보 2~3개가 실제로 경합해야 하고, ' +
        '오답은 정답과 같은 범주(같은 장기·같은 약물군·같은 분류 축)에서 고른다.',
      '상':
        '**난이도 상(분석)**: 비전형 양상, 검사 수치 해석(참고치 대비 방향), 2단계 추론(진단 → 다음 검사·처치), ' +
        '예외·금기·용량 조절 중 하나를 반드시 포함한다. 오답은 정답과 소견 한두 개 차이로 갈리게 만든다. ' +
        '다만 자료가 뒷받침하지 않는 수치·소견을 지어내면서까지 어렵게 만들지는 않는다 — ' +
        '그럴 땐 감별을 좁히는 조건을 지문에 더 넣어 난이도를 올린다.',
    };
    // 지식형에 적용할 난이도 지침 — 위 정의는 증례 언어로 쓰여 있어 지식형에는 '상'이 없다.
    //
    // 2026-08-19 실측(요청 '상', 지식형+임상형 10문항): difficulty 3 다섯 문항이 **전부 임상 증례형**이고
    // 지식형 다섯 문항은 1~2 에 머물렀다(Stanford 분류·기전·위험인자). 위 '상' 정의가 요구하는 것
    // (비전형 양상·2단계 추론·수술 시점)이 전부 환자를 전제하므로, 증례를 쓰지 않는 지식형(K0)은
    // 따를 지침이 없었던 것이다. 요청 '하'는 7/10, '중'은 7/8 로 지식형만으로도 맞았으므로
    // 구멍은 '상' 하나다 — 지식형을 어렵게 만드는 방법을 따로 적어 준다.
    const KNOWLEDGE_DIFFICULTY_DIRECTIVES: Record<'하' | '중' | '상', string> = {
      '하':
        '지식형에서는 자료에 그대로 적힌 사실 하나를 묻는다(정의·대표 소견·분류 이름).',
      '중':
        '지식형에서는 두 개념의 관계를 묻는다 — 기전이 증상으로 이어지는 경로, 분류에 따라 달라지는 처치 원칙, ' +
        '검사 소견이 가리키는 병태.',
      '상':
        '지식형에서 난이도 3은 증례 없이도 만들 수 있다. 다음 중 하나를 쓴다: ' +
        '**(a) 예외·금기** — 원칙이 뒤집히는 조건(“이 약을 단독으로 쓰면 안 되는 이유는?”), ' +
        '**(b) 경계 수치** — 판단이 갈리는 값과 그 근거(“수술을 고려하는 직경 기준은?”), ' +
        '**(c) 기전의 하위 단계** — 한 단계 더 들어간 물음(“이 손상이 일어나는 벽의 층은?”), ' +
        '**(d) 유사 개념 감별** — 헷갈리는 두 개념을 가르는 결정적 차이 하나, ' +
        '**(e) 흔한 오개념 정면 겨냥** — 학생이 반대로 알기 쉬운 방향을 정답이 가르게 한다. ' +
        '오답 4개는 모두 “그럴듯한데 한 조건에서 틀린” 진술이어야 한다. ' +
        '증례를 붙여 어렵게 만들려 하지 않는다 — 그건 임상형의 몫이다.',
    };
    // 요청 난이도의 정수 대응(1/2/3) — 모델 신고값과 대조해 mismatch 를 센다(P4).
    const requestedDifficultyLevel: 1 | 2 | 3 | null =
      input.difficulty === '하' ? 1 : input.difficulty === '중' ? 2 : input.difficulty === '상' ? 3 : null;
    const diffDirective = input.difficulty
      ? DIFFICULTY_DIRECTIVES[input.difficulty] +
        // 지식형을 고른 요청에만 붙인다. 임상형만 고른 요청에 붙이면 "증례 없이" 지침이
        // 증례 문항까지 눌러 임상형이 약해진다(규격 첨부와 같은 원칙).
        (wantsKnowledge ? `\n${KNOWLEDGE_DIFFICULTY_DIRECTIVES[input.difficulty]}` : '') +
        '\n각 문항의 `difficulty` 에는 **요청 난이도가 아니라 그 문항이 실제로 요구하는 수준**' +
        '(1=재인, 2=적용, 3=분석)을 정직하게 적는다. 요청에 맞추려고 값을 올리거나 내리지 않는다.'
      : '';
    const typeDirectives: Record<string, string> = {
      // 종전에는 이 한 줄이 지식형 규격 전부였다(임상형에는 C0~C11, 이미지형에는 가림 검사가
      // 있는데 지식형만). 그 결과 발문의 48 %가 두 문형에 몰리고 껍데기 증례가 나왔다.
      // 실제 규격은 아래 KNOWLEDGE_RULES(K0~K7) 가 전담한다.
      '지식형': '**지식형**: 아래 "지식형 문항 규격(K0~K7)"을 그대로 적용한다. 환자 증례로 감싸지 말고 자료가 가르친 개념을 직접 묻는다.',
      // 임상형의 실제 규격은 아래 CLINICAL_VIGNETTE_RULES 가 전담한다. 여기서는 어느
      // 규격을 따르라는 포인터만 둔다 — 예전처럼 이 한 줄이 규격 전부이면 모델이
      // 지식형으로 되돌아간다(2026-08-16 실측: 임상형 10문항이 전부 지식형이었다).
      '임상형': '**임상형**: 아래 "임상형 문항 규격(C0~C11)"을 그대로 적용한다. 환자 한 명의 증례로 시작해 임상 판단 하나를 묻는다.',
      '이미지형':
        '**이미지형**: 자료의 의료 이미지를 판독·해석해야 푸는 문항을 가능한 한 많이 만든다(이미지가 있으면 우선). ' +
        '**그림을 가려도 풀리는 문항은 이미지형이 아니다** — 그림에서 읽어야만 알 수 있는 소견' +
        '(위치·모양·크기·분포·신호 강도·염색 양상)을 답의 근거로 삼는다. ' +
        '표식(A·B·C)을 가리키는 문항은 판독 문항의 한 형태일 뿐이므로 **드물게만** 쓴다' +
        '(허용 여부는 묶음별 지시를 따른다).',
    };
    const typeDirective = selectedTypes.length
      ? `선택된 문항 유형(${selectedTypes.join(', ')})을 전체 문항에 고르게 배분한다.\n${selectedTypes.map((type) => typeDirectives[type]).join('\n')}`
      : '';
    if (diffDirective || typeDirective) {
      systemPrompt += `\n\n## 사용자 지정 출제 조건\n${[diffDirective, typeDirective].filter(Boolean).join('\n')}`;
    }
    // 임상형을 고른 요청에만 붙인다. 지식형·이미지형만 고른 요청에 붙이면 그 문항들까지
    // 증례를 달게 되어 사용자가 고른 유형과 어긋난다.
    if (wantsClinical) {
      systemPrompt += `\n\n${CLINICAL_VIGNETTE_RULES}`;
    }
    // 지식형을 고른 요청에만 붙인다. 임상형·이미지형만 고른 요청에 붙이면 K0("증례를 쓰지 않는다")가
    // 증례 문항까지 눌러 임상형이 지식형으로 되돌아간다(임상형 규격을 반대로 붙였을 때와 같은 사고).
    if (wantsKnowledge) {
      systemPrompt += `\n\n${KNOWLEDGE_RULES}`;
    }
    // 형식 프로파일은 **규격 뒤에** 붙인다. 뒤에 오는 지시가 앞의 규격을 덮어쓰는 것이
    // 이번 의도다(사용자 결정: 참고 자료 형식이 기본 규격보다 우선, 안전 규칙만 예외).
    if (isUsableProfile(referenceProfile)) {
      systemPrompt += `\n\n${buildReferenceProfileSection(referenceProfile)}`;
    }
    const client = getAnthropic();
    modelUsed = MODELS.generation();

    // 생성 시간은 배치당 출력 토큰(≈ 문항 수)이 지배한다. 문항을 GEN_BATCH_MAX_QUESTIONS
    // 이하의 균등한 소배치로 나눠 병렬 실행하면 전체 소요가 "가장 큰 배치 1개" 수준으로
    // 줄어든다. (4문항 배치도 디코딩만 1분+ 라 2문항으로 축소 — 상수 주석 참고.)
    const batchCount = Math.ceil(desiredCount / GEN_BATCH_MAX_QUESTIONS);
    const baseBatchSize = Math.floor(desiredCount / batchCount);
    const batchRemainder = desiredCount % batchCount;
    const batchSizes = Array.from(
      { length: batchCount },
      (_, i) => baseBatchSize + (i < batchRemainder ? 1 : 0),
    );
    // 조합형(ㄱ/ㄴ/ㄷ) 빈도 제한: 학교 시험에서 매우 드문 유형이라 요청에 별도 조건이 없으면
    // 10문항당 1문항 이하로 억제한다. 배치가 병렬이라 "전체의 10%"를 프롬프트로 지시해도
    // 배치마다 독립 판단해 과다 생성되므로, 허용 배치를 정해 결정론적으로 배분한다.
    // 참고 자료가 있으면 그 학교가 실제로 조합형을 쓰는지에 맞춘다(P7 형식 우선).
    // 안 쓰는 학교면 0 — 기본값(10문항당 1)은 "학교 시험에서 드물다"는 일반론이고,
    // 프로파일은 그 학교의 실제 관찰이라 더 구체적이다.
    const comboQuota = isUsableProfile(referenceProfile)
      ? referenceProfile.combo_used
        ? Math.max(1, Math.floor(desiredCount / 10))
        : 0
      : Math.floor(desiredCount / 10);
    const comboBatches = new Set(
      Array.from({ length: comboQuota }, (_, i) => batchSizes.length - 1 - i).filter(
        (i) => i >= 0,
      ),
    );
    // 표식(A·B·C) 문항 빈도 제한 — 10문항당 1문항 이하(사용자 정책 2026-08-16).
    //
    // 처음에는 "표식 이미지를 받은 배치마다 최소 1문항"으로 요구했는데, 배치가 5개면
    // 10문항 중 5문항이 표식 문항이 될 수 있다. 표식은 판독 문항의 한 형태일 뿐이라
    // 그 정도 비중이면 문제집이 단조로워진다. 조합형과 같은 방식으로 억제한다.
    // 이미지 배치는 뒤쪽에 몰려 있으므로(선발사 배치는 이미지를 못 받는다) 마지막
    // 배치부터 허용해 "표식을 실제로 받은 배치"에 배분이 떨어지게 한다.
    // 조합형 배치와는 겹치지 않게 고른다 — 한 배치가 조합형과 표식 문항을 동시에 떠맡으면
    // 그 배치(2문항)가 통째로 특수 유형이 된다.
    const markerQuota = Math.floor(desiredCount / 10);
    const markerBatches = new Set<number>();
    for (let i = batchSizes.length - 1; i >= 0 && markerBatches.size < markerQuota; i--) {
      if (comboBatches.has(i)) continue;
      markerBatches.add(i);
    }
    let completedQuestions = 0;
    // 배치 비용 로그용 — 추출 완료 후 채워진다(선발사 배치는 추출 전에 시작하므로 0으로 기록).
    let extractedSlideCount = 0;
    let extractedCropCount = 0;

    // ★ 텍스트 선(先)발사 — 본문 텍스트가 확보되는 즉시(추출 완료를 기다리지 않고)
    //   텍스트 배치들을 출발시켜, 남은 전처리(페이지 렌더·Vision·크롭 OCR) 시간을
    //   생성 시간 뒤로 숨긴다.
    //   · 이미지형 미선택: 어차피 이미지를 쓰지 않으므로 전 배치를 여기서 출발.
    //   · 이미지형 선택: 앞쪽 절반만 텍스트로 먼저 출발하고, 나머지는 OCR·이미지 배정을
    //     받아 이미지 판독 문항을 담당한다.
    //   실패는 즉시 던지지 않고 감싸 두었다가 본배치 단계에서 전체 컨텍스트로 재시도한다.
    const earlyFullText = await earlyText;
    const canPrefire = batchSizes.length > 1 && earlyFullText.trim().length >= 1000;

    // ── 배치별 출제 초점 (P11 · 세션 내 중복 방지)
    //
    // 한 번 정하면 바꾸지 않는다. 선발사 배치는 여기(원문 텍스트)에서 뽑은 목록으로
    // 배정을 받고, 뒤이어 뜨는 배치도 **같은 목록**을 봐야 배정이 겹치지 않는다.
    // 나중에 만들어지는 compositeText(OCR 포함)로 목록을 갈아끼우면 이미 출발한 배치와
    // 경계가 어긋나 두 배치가 같은 주제를 맡는다.
    let focusTopics: readonly string[] = extractFocusTopics(earlyFullText);
    diag.generation.focusTopicSource = focusTopics.length > 0 ? 'early' : 'none';
    // 조기 출발 폭. 이미지형이라도 "이미지가 실제로 필요한 배치"만 전처리를 기다리면 된다.
    //   실측 근거: 텍스트는 1.6초에 준비되는데 이미지형은 첫 배치가 10초에야 출발했다.
    //
    // 이미지 배치 예약 수는 "이미지 판독 문항 목표 수"에서 역산한다. 종전의 고정 1/3 예약은
    //   이미지형을 선택해도 문항의 2/3가 이미지를 아예 받을 수 없어(선발사 배치는 이미지
    //   배정 대상에서 제외) 이미지 문항 비율을 구조적으로 깎았다.
    //   목표: 이미지형 단독 선택이면 전 문항, 다른 유형과 섞이면 유형 수로 나눈 몫.
    //   공급 상한(featured 최대 featuredCap장 × 장당 MAX_QUESTIONS_PER_IMAGE문항)으로 캡.
    //   예약을 늘려도 벽시계 시간은 거의 늘지 않는다 — 이미지 배치들은 어차피 추출·정제
    //   완료 후에야 출발하고 서로 병렬(GEN_CONCURRENCY)이라, 전체 소요를 지배하는
    //   "추출→정제→이미지 배치 1개" 경로의 길이는 예약 수와 무관하다.
    //   최소 1배치는 텍스트 선발사로 남겨 전처리를 생성 뒤로 숨기는 조기 출발을 유지한다.
    const imageQuestionTarget = wantsImages
      ? Math.min(
          selectedTypes.length <= 1
            ? desiredCount
            : Math.ceil(desiredCount / selectedTypes.length),
          featuredCap * MAX_QUESTIONS_PER_IMAGE,
        )
      : 0;
    const imageBatchesNeeded = wantsImages
      ? Math.min(
          batchSizes.length - 1,
          Math.max(1, Math.ceil(imageQuestionTarget / GEN_BATCH_MAX_QUESTIONS)),
        )
      : 0;
    const prefireCount = !canPrefire
      ? 0
      : wantsImages
        ? Math.max(1, batchSizes.length - imageBatchesNeeded)
        : batchSizes.length;

    // 조기 텍스트는 슬라이드 라벨 없이 한 덩어리로 오므로, 구간 분할은 문자 기준으로 한다.
    const prefireSegments =
      earlyFullText.length < GEN_SEGMENT_ENABLE_MIN_CHARS
        ? 1
        : Math.max(
            1,
            Math.min(
              prefireCount || 1,
              Math.floor(earlyFullText.length / GEN_SEGMENT_MIN_CHARS),
            ),
          );
    const prefireSegmented = prefireSegments > 1;
    const prefireContext = (batchIndex: number): string => {
      if (!prefireSegmented) return earlyFullText;
      const segIndex = Math.min(
        prefireSegments - 1,
        Math.floor((batchIndex * prefireSegments) / Math.max(1, prefireCount)),
      );
      const segLen = Math.ceil(earlyFullText.length / prefireSegments);
      const pad = Math.round(segLen * GEN_SEGMENT_OVERLAP_RATIO);
      let from = Math.max(0, segIndex * segLen - pad);
      let to = Math.min(earlyFullText.length, segIndex * segLen + segLen + pad);
      if (from > 0) {
        const nl = earlyFullText.indexOf('\n', from);
        if (nl >= 0 && nl - from < 500) from = nl + 1;
      }
      if (to < earlyFullText.length) {
        const nl = earlyFullText.lastIndexOf('\n', to);
        if (nl > from) to = nl;
      }
      return earlyFullText.slice(from, to);
    };

    const slotsFor = (batchIndex: number) =>
      Array.from(
        { length: batchSizes[batchIndex] },
        (_, k) => batchSizes.slice(0, batchIndex).reduce((sum, size) => sum + size, 0) + k,
      );

    // 배치의 "임상 증례형 최소 수".
    //
    // imageQuotaFor 와 같은 이유로 필요하다. 시스템 프롬프트에 "유형을 고르게 배분한다"만
    // 두면 배치가 병렬로 독립 판단해 임상형이 0개인 배치가 나온다. 실측(2026-08-16)에서는
    // 임상형만 골랐는데도 10문항 전부가 지식형이었다.
    // 임상형 단독 선택이면 배치 전 문항이 임상형이어야 하고, 다른 유형과 섞이면 유형 수로
    // 나눈 몫(최소 1)을 요구한다. 이미지 문항도 증례형일 수 있으므로 imageQuota 와
    // 서로 자리를 다투지 않는다(증례 + 사진 판독은 국시의 기본형이다).
    const clinicalQuotaFor = (batchSize: number): number => {
      if (!wantsClinical) return 0;
      if (selectedTypes.length <= 1) return batchSize;
      return Math.max(1, Math.min(batchSize, Math.ceil(batchSize / selectedTypes.length)));
    };

    // 배치의 "지식형 최소 수" — clinicalQuotaFor 와 같은 이유(병렬 배치의 독립 판단).
    const knowledgeQuotaFor = (batchSize: number): number => {
      if (!wantsKnowledge) return 0;
      if (selectedTypes.length <= 1) return batchSize;
      return Math.max(1, Math.min(batchSize, Math.ceil(batchSize / selectedTypes.length)));
    };

    // 발문 유형(ask_kind) 배분.
    //
    // "한 묶음 안에서 유형을 겹치지 말라"는 지시만으로는 배치 간 중복을 못 막는다 — 배치는
    // 서로를 못 보므로 전부 '치료'와 '총론'으로 몰린다(실측: 치료 28 %·총론 23 % vs 기전 2 %).
    // 조합형·표식과 같은 방식으로 **코드가 배치마다 다른 유형을 배정**한다.
    const knowledgeAskPlan = (batchIndex: number, batchSize: number): string[] => {
      if (!wantsKnowledge) return [];
      const pool = KNOWLEDGE_ASK_KINDS;
      const need = Math.max(1, knowledgeQuotaFor(batchSize));
      // 배치의 시작점을 **누적 슬롯 수**로 잡는다.
      //
      // 종전 `batchIndex * need` 는 배치 크기가 쿼터와 다르면(혼합 유형 요청) 시작점이
      // 겹쳐, 7종을 다 쓰기도 전에 앞쪽 유형이 반복됐다(2026-08-19 실측: 10문항에
      // mechanism 3회·고유 유형 6/10). 앞선 배치들이 실제로 소비한 칸 수를 세면
      // 첫 7칸이 7종을 모두 덮은 뒤에 순환한다.
      const consumed = batchSizes
        .slice(0, batchIndex)
        .reduce((sum, size) => sum + Math.max(1, knowledgeQuotaFor(size)), 0);
      const start = consumed % pool.length;
      return Array.from({ length: Math.min(need, pool.length) }, (_, k) => pool[(start + k) % pool.length]);
    };

    // 부정형("옳지 않은 것은?") 허용 묶음 — 조합형과 같은 방식으로 상한을 결정론적으로 배분한다.
    // 허용된 묶음은 최대 1문항이므로 "허용 묶음 수 ≈ 목표 부정형 문항 수"가 된다.
    //
    // 참고 자료가 있으면 **그 비율을 따른다**(P7 형식 우선). 2026-08-19 실측에서 프로파일이
    // `negative_ratio: 0.4`(표본 5문항 중 2문항이 부정형 — 정확)였는데도 이 계산이 프로파일을
    // 안 봐서 기본 20 % 로 눌렸다. 배치 지시는 시스템 프롬프트보다 뒤·구체적이라 실제로는
    // 배치 지시가 이긴다 — 즉 "형식은 프로파일 우선"이 여기서만 지켜지지 않고 있었다.
    //
    // 유형 비율(vignette_ratio)은 일부러 반영하지 않는다. 그건 사용자가 화면에서 고른
    // 문항 유형(지식형·임상형)의 몫이고, 프로파일이 그것까지 뒤집으면 요청 위반이 된다.
    const negativeQuota = isUsableProfile(referenceProfile)
      ? Math.min(batchSizes.length, Math.round(referenceProfile.negative_ratio * desiredCount))
      : Math.max(1, Math.round(desiredCount / 10) * 2);
    const negativeBatches = new Set<number>();
    for (let i = 0; i < batchSizes.length && negativeBatches.size < negativeQuota; i++) {
      if (comboBatches.has(i) || markerBatches.has(i)) continue;
      negativeBatches.add(i);
    }

    type SettledBatch = { ok: true; v: BatchResult } | { ok: false; e: unknown };
    const prefired: Array<Promise<SettledBatch> | null> = batchSizes.map((_, batchIndex) =>
      batchIndex < prefireCount
        ? generateAndPersistBatch(batchIndex, slotsFor(batchIndex), batchSizes.length, {
            contextText: prefireContext(batchIndex),
            featured: [],
            getDisplayPng: async () => null,
            segmented: prefireSegmented,
            clinicalQuota: clinicalQuotaFor(batchSizes[batchIndex]),
            knowledgeQuota: knowledgeQuotaFor(batchSizes[batchIndex]),
            knowledgeAskKinds: knowledgeAskPlan(batchIndex, batchSizes[batchIndex]),
            allowNegativeAsk: negativeBatches.has(batchIndex),
          }).then(
            (v): SettledBatch => ({ ok: true, v }),
            (e: unknown): SettledBatch => ({ ok: false, e }),
          )
        : null,
    );
    diag.generation.batchCount = batchSizes.length;
    // P3·P4 계획값 — 결과(배치별 forbiddenAsk·askKinds·difficultyMismatch)와 대조해 읽는다.
    diag.generation.requestedDifficultyLevel = requestedDifficultyLevel;
    diag.generation.negativeBatches = [...negativeBatches];
    diag.generation.knowledgeQuotaPerBatch = batchSizes.map((n) => knowledgeQuotaFor(n));
    diag.generation.prefireCount = prefireCount;
    diag.generation.prefireSegments = prefireSegments;
    diag.generation.imageQuestionTarget = imageQuestionTarget;
    diag.generation.imageBatchesNeeded = imageBatchesNeeded;
    diag.generation.featuredCap = featuredCap;
    diag.timings.firstBatchStartMs = Date.now() - startTime;
    if (prefireCount > 0) {
      warnings.push(
        `텍스트 선발사: ${prefireCount}/${batchSizes.length} 배치를 전처리 완료 전에 출발.`,
      );
    }

    // 4-b) 추출 완료 대기 — 위 선발사 배치들은 이 시간 동안 이미 생성 중이다.
    //      상한을 넘기면 이미지 없이(본문 텍스트만으로) 생성을 마무리한다. 실행이 끝나지
    //      않는 것보다 이미지 문항이 빠진 채로라도 끝나는 편이 언제나 낫다.
    const { slides } = await withDeadline(extractPromise, EXTRACT_WAIT_TIMEOUT_MS, { slides: [] }, () => {
      diag.extract.extractTimedOut = true;
      warnings.push(
        `전처리가 ${Math.round(EXTRACT_WAIT_TIMEOUT_MS / 1000)}초를 넘겨 본문 텍스트만으로 생성을 마쳤습니다.`,
      );
    });
    diag.timings.extractAwaitedMs = Date.now() - startTime;
    const allCrops = slides.flatMap((s) =>
      s.croppedImages.map((c) => ({ slide: s, crop: c })),
    );
    const totalCropped = allCrops.length;
    extractedSlideCount = slides.length;
    extractedCropCount = totalCropped;


    // 5) crop 이미지 OCR — crop 단위로 평탄화해 전역 병렬 처리.
    //    (슬라이드 단위 병렬은 임베드 이미지 경로처럼 crop 이 첫 슬라이드에 몰리면
    //     사실상 순차가 되어 crop 수 × 호출 지연만큼 느려진다.)
    // 선발사 배치가 이미 생성 중이면 단계 표시를 'ocr' 로 되돌리지 않는다(진행 표시 역행 방지).
    const tOcr = Date.now();
    const reportOcrProgress = prefireCount === 0 && allCrops.length > 0;
    if (reportOcrProgress) {
      await updateProgress('ocr', 0, allCrops.length, { page_count: slides.length });
    } else {
      await updateProgress('generating', completedQuestions, desiredCount, {
        page_count: slides.length,
      });
    }
    // 스트리밍으로 이미 시작된 크롭은 완료만 기다리고, 시작이 누락된 크롭이 있다면
    // 여기서 방어적으로 시작한다(중복 시작은 crop 객체 단위로 차단됨). 동시성·컨텍스트·
    // 비용 누적은 전부 startCropOcr 안에 있어 종전과 동일하다.
    for (const { slide, crop } of allCrops) startCropOcr(slide.text, slide.pageIndex, crop);
    let ocrDone = 0;
    // 상한 초과 시 아직 안 끝난 OCR 은 포기하고 진행한다(해당 크롭은 주석 텍스트 없이 쓰인다).
    await withDeadline(
      Promise.all(
        allCrops.map(({ crop }) =>
          (ocrTasks.get(crop) ?? Promise.resolve()).then(async () => {
            ocrDone += 1;
            if (reportOcrProgress) await updateProgress('ocr', ocrDone, allCrops.length);
          }),
        ),
      ),
      OCR_WAIT_TIMEOUT_MS,
      [] as unknown[],
      () => {
        diag.extract.ocrTimedOut = true;
        warnings.push(`크롭 OCR ${allCrops.length - ocrDone}건이 상한을 넘겨 생략됐습니다.`);
      },
    );
    // 스트리밍이라 이 값은 "Vision 과 겹친 뒤 남은 잔여 대기"만 나타낸다.
    diag.timings.ocrMs = Date.now() - tOcr;
    diag.extract.ocrCalls = allCrops.length;
    diag.extract.ocrChars = ocrChars;
    const slideSummaries = slides.map((s) => ({
      pageIndex: s.pageIndex,
      slideText: s.text,
      ocrTexts: s.croppedImages
        .filter((c) => (c.ocrText ?? '').length > 0)
        .map((c) => `[${c.region.kind}] ${c.ocrText}`),
      cropCount: s.croppedImages.length,
    }));

    // 5.5) 추출 결과가 전부 비어 있으면 Claude 호출은 의미 없음 → 명확한 실패 메시지.
    const totalSlideText = slideSummaries
      .map((ss) => ss.slideText)
      .join(' ')
      .trim();
    const hasAnyContext =
      totalSlideText.length > 0 || ocrChars > 0 || totalCropped > 0;
    if (!hasAnyContext) {
      throw new Error(
        '추출된 텍스트·이미지가 없습니다. 자료에 본문 텍스트나 의료 이미지가 포함되어 있는지 확인하세요.',
      );
    }

    // 6) 통합 컨텍스트 구성 — 슬라이드 텍스트 + OCR 결과를 라벨링해 한 번에 전달
    const contextBlocks: string[] = [];
    for (const ss of slideSummaries) {
      const parts: string[] = [];
      if (ss.slideText) parts.push(`텍스트: ${ss.slideText}`);
      if (ss.ocrTexts.length > 0) parts.push(`이미지(OCR):\n${ss.ocrTexts.join('\n')}`);
      if (parts.length > 0) {
        contextBlocks.push(`## 슬라이드 ${ss.pageIndex} (이미지 ${ss.cropCount}장)\n${parts.join('\n')}`);
      }
    }
    const compositeText = contextBlocks.join('\n\n');

    // 원문 텍스트에서 초점을 못 뽑았을 때만(스캔본 등 earlyText 가 비었을 때) 슬라이드
    // 구조에서 다시 뽑는다. 이미 뽑았으면 건드리지 않는다 — 선발사 배치가 그 목록으로
    // 이미 출발했다.
    if (focusTopics.length === 0) {
      focusTopics = extractFocusTopics(compositeText);
      if (focusTopics.length > 0) diag.generation.focusTopicSource = 'composite';
    }
    diag.generation.focusTopicCount = focusTopics.length;

    // ── 배치별 구간 분할
    // 지금까지는 모든 배치가 자료 전체(최대 15만 자)를 실어 동시에 호출했다. 그래서
    // 배치 수만큼 입력 토큰이 중복 과금되고, 순간 입력량이 커져 429(rate limit)에 걸려
    // 백오프 대기가 전체 소요를 지배했다(실측: 배치 삽입이 49~105초로 흩어짐).
    // 각 배치에 자기 구간만 주면 배치당 입력이 구간 수만큼 줄고, 구간이 물리적으로
    // 분리돼 배치 간 문항 중복도 함께 줄어든다.
    //
    // 안전장치:
    //  - 자료가 작으면(GEN_SEGMENT_ENABLE_MIN_CHARS 미만) 분할하지 않는다(이득 없음).
    //  - 구간이 너무 얇아 출제 근거가 부족해지지 않게 구간당 최소 길이를 보장하고,
    //    필요하면 구간 수를 배치 수보다 적게 줄여 여러 배치가 같은 구간을 공유한다.
    //  - 경계에서 문맥이 끊기지 않게 앞뒤로 겹침을 둔다.
    const segmentCount = (() => {
      if (batchSizes.length <= 1) return 1;
      if (compositeText.length < GEN_SEGMENT_ENABLE_MIN_CHARS) return 1;
      const byLength = Math.floor(compositeText.length / GEN_SEGMENT_MIN_CHARS);
      return Math.max(1, Math.min(batchSizes.length, byLength));
    })();

    /** 문장/줄 경계에 맞춰 text 의 index/count 번째 구간을 잘라낸다(앞뒤 겹침 포함). */
    const sliceByChars = (
      text: string,
      index: number,
      count: number,
      maxChars = Number.POSITIVE_INFINITY,
    ): string => {
      if (count <= 1) return text;
      const segLen = Math.ceil(text.length / count);
      const pad = Math.round(segLen * GEN_SEGMENT_OVERLAP_RATIO);
      let start = Math.max(0, index * segLen - pad);
      let end = Math.min(text.length, index * segLen + segLen + pad);
      // 시작은 다음 줄바꿈까지 밀고, 끝은 이전 줄바꿈까지 당겨 문장이 잘리지 않게 한다.
      if (start > 0) {
        const nl = text.indexOf('\n', start);
        if (nl >= 0 && nl - start < 500) start = nl + 1;
      }
      if (end < text.length) {
        const nl = text.lastIndexOf('\n', end);
        if (nl > start && end - nl < 500) end = nl;
      }
      return text.slice(start, Math.min(end, start + maxChars));
    };

    /** 배치 index 가 볼 출제 근거. 분할이 필요 없으면 전체를 그대로 준다. */
    const segmentForBatch = (batchIndex: number, batchCount: number): string => {
      if (segmentCount <= 1) return compositeText;
      // 배치를 구간에 고르게 배분(구간 수 < 배치 수면 여러 배치가 같은 구간을 본다).
      const segIndex = Math.min(
        segmentCount - 1,
        Math.floor((batchIndex * segmentCount) / Math.max(1, batchCount)),
      );
      // 슬라이드 블록이 구간 수보다 많으면 블록 경계로 나눈다(문장이 잘리지 않는다).
      if (contextBlocks.length >= segmentCount) {
        const per = Math.ceil(contextBlocks.length / segmentCount);
        const from = Math.max(0, segIndex * per - 1); // 앞 블록 1개 겹침
        const to = Math.min(contextBlocks.length, segIndex * per + per + 1);
        return contextBlocks.slice(from, to).join('\n\n');
      }
      // 텍스트 위주 PDF 는 본문이 한 블록에 몰리므로 문자 단위로 나눈다.
      return sliceByChars(compositeText, segIndex, segmentCount);
    };
    if (segmentCount > 1) {
      warnings.push(
        `출제 근거 ${compositeText.length}자를 ${segmentCount}개 구간으로 분할해 배치별로 배정.`,
      );
    }

    // 7) Claude 호출 — 문항 생성 (프롬프트·배치 계획은 4)에서 준비됨)
    await updateProgress('generating', 0, desiredCount);

    // crop 된 의료 이미지 — 인덱스 라벨과 함께 제시.
    // Storage 업로드는 생성 응답에서 실제 사용된 이미지만 골라 나중에 수행한다 (고아·비용 방지).
    // 텍스트 캡처 검열 — 강의록 본문 캡처를 문항 이미지에서 배제한다.
    //
    // 판정 기준을 "글자 수"에서 "텍스트가 차지하는 면적 비율"로 바꿨다.
    //  · 글자 수는 이미지 크기·주석 밀도와 무관한 절대값이라, 라벨이 조금 많은 진짜
    //    임상영상(설명이 붙은 조영술·초음파)과 글자로 가득 찬 슬라이드를 못 가른다.
    //  · 이제 정답 단서 유출은 마스킹 후 재검증이 막는다(readResidualText). 그래서 이
    //    사전 필터의 역할은 "덮고 나면 그림이 남지 않는 이미지"를 걸러내는 것 하나다.
    //    그 판단에는 글자가 화면을 얼마나 덮고 있는지가 정확한 척도다.
    //  실측(대동맥 강의록): 그림 크롭 0.0~7.4% vs 텍스트 페이지 28.0~44.1% —
    //  임계 15%는 양쪽에 2배 이상 여유가 있다.
    const TEXT_AREA_RATIO_MAX = 0.15;
    const meaningfulOcrLen = (t?: string) =>
      (t ?? '').replace(/[^\p{L}\p{N}]/gu, '').length;
    const textAreaRatio = (c: (typeof slides)[number]['croppedImages'][number]) => {
      const boxes = c.ocrBoxes ?? [];
      if (boxes.length === 0) return null;
      const total = Math.max(1, c.widthPx * c.heightPx);
      const area = boxes.reduce(
        (sum, b) => sum + Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0),
        0,
      );
      return area / total;
    };
    const isTextCapture = (c: (typeof slides)[number]['croppedImages'][number]) => {
      if (c.region.kind === 'text_slide') return true; // vision 이 텍스트 캡처로 분류
      const ratio = textAreaRatio(c);
      if (ratio !== null) return ratio >= TEXT_AREA_RATIO_MAX;
      // 좌표를 못 받은 경우에만 종전 글자 수 기준으로 폴백한다.
      const len = meaningfulOcrLen(c.ocrText);
      if (CLINICAL_IMAGE_KINDS.has(c.region.kind) && len >= 80) return true;
      return len >= 250;
    };

    // gi = 전역 이미지 인덱스. 배치마다 서로 다른 이미지 묶음을 주더라도 인페인팅 캐시와
    // Storage 경로는 전역 인덱스로 통일해야 배치 간 중복 작업·경로 충돌이 없다.
    const featuredImages = slides
      .flatMap((s) => s.croppedImages.map((c) => ({ slide: s.pageIndex, c })))
      // 페이지 전체 OCR 폴백 크롭은 문항 이미지에서 제외(주석·다중 그림·정답 단서 혼입 방지).
      .filter((x) => !x.c.ocrOnly)
      // 강의록 텍스트 캡처는 문항 이미지 후보에서 원천 배제.
      .filter((x) => {
        const excluded = isTextCapture(x.c);
        if (excluded) {
          const ratio = textAreaRatio(x.c);
          warnings.push(
            `이미지(슬라이드 ${x.slide}, ${x.c.region.kind}) 텍스트 캡처로 제외 — ` +
              (ratio !== null
                ? `텍스트 면적비 ${(ratio * 100).toFixed(1)}%`
                : `글자 ${meaningfulOcrLen(x.c.ocrText)}자(좌표 없음)`),
          );
        }
        return !excluded;
      })
      // (예전에는 "인페인팅으로 못 지울 이미지"를 여기서 미리 걸렀다. 마스킹은 좌표를
      //  배경색으로 덮는 방식이라 글자가 많아도 실패하지 않으므로 사전 제외가 필요 없다.
      //  덕분에 문항에 쓸 수 있는 이미지가 늘어난다 — 실측에서 8장 중 3장만 살아남던 문제.)
      .slice(0, featuredCap)
      .map((x, gi) => ({ ...x, gi }));

    // 사용자가 '이미지형'을 선택하지 않았으면 이미지를 생성 배치에 아예 넣지 않는다.
    // 넣으면 시스템 프롬프트의 "이미지 판독 문항 우선" 지시 때문에 이미지 문항이 만들어지고,
    // 그 이미지가 정제(인페인팅) 검증에서 탈락하거나 "동일 이미지 최대 2문제" 정리에 걸리면
    // 문항이 통째로 삭제돼 요청 수보다 적게 남는다(10 요청 → 6 저장의 주 원인).
    const useImages = wantsImages && featuredImages.length > 0;
    if (!useImages) {
      systemPrompt +=
        '\n\n## 이미지 사용 금지(이번 요청)\n' +
        '이번 요청에서는 의료 이미지를 제공하지 않는다. 모든 문항은 제공된 텍스트 근거만으로 ' +
        '풀 수 있게 만들고, `image_indices` 는 **항상 빈 배열 []** 로 둔다. ' +
        '"다음 심전도에서", "아래 흉부 X-ray 를 보고" 처럼 제시되지 않은 그림을 가리키는 발문도 쓰지 않는다.';
    } else {
      // 기본 규칙과의 충돌 해소.
      //
      // 시스템 프롬프트에는 "이미지 안에 주석·설명 텍스트가 많아 보면 정답이 드러나는
      // 그림은 image_indices 에 넣지 않는다"는 규칙이 있다. 그런데 모델에게 주는 것은
      // **라벨이 살아 있는 원본**이고 학생이 받는 것은 라벨이 지워진 정제본이다.
      // 그 차이를 알려 주지 않으면 라벨이 붙은 해부도·조직 사진(= 표식 문항을 만들 수
      // 있는 바로 그 그림들)을 모델이 스스로 제외해 버린다.
      systemPrompt +=
        '\n\n## 이미지 라벨 안내(이번 요청)\n' +
        '제시된 [이미지 N]은 **원본**이라 라벨·주석 글자가 그대로 보인다. 학생이 받는 ' +
        '이미지에서는 그 글자가 자동으로 모두 지워진다. 따라서 **라벨이 많다는 이유만으로 ' +
        'image_indices 에서 빼지 않는다** — 라벨이 붙은 해부도·조직 사진일수록 좋은 판독 ' +
        '문항이 된다.\n' +
        '- 다만 그림에서 읽은 라벨 글자를 발문·선지·해설에 그대로 옮겨 적으면 정답이 ' +
        '노출되므로 절대 쓰지 않는다.\n' +
        '- 원본 그림에 **지시선·브래킷**이 있던 자리는 라벨을 지운 뒤 반드시 기호(A·B·C…)로 ' +
        '바꿔 둔다. 그러니 학생 화면의 지시선은 항상 기호를 달고 있다. 반대로 기호가 없는 ' +
        '부분은 학생이 특정할 수 없으므로 그 부분을 지목하는 문항을 만들지 않는다.\n' +
        '- "표식 안내"가 붙은 이미지는 라벨 자리에 A·B·C 표식이 찍혀 있다. 그 표식을 ' +
        '가리켜 물으면 그림을 보지 않고는 풀 수 없는 문항이 된다. ' +
        '다만 표식 문항은 **드물게만** 쓴다 — 묶음별 지시에서 허용한 경우에만 만들고, ' +
        '허용해도 최대 1문항이다. 나머지는 표식을 언급하지 말고 그림의 소견으로 출제한다.';
    }

    // 선별 텍스트 인페인팅(비용 최적화): 모든 featured 를 미리 인페인팅하지 않고,
    // 생성이 "실제 참조한" 이미지에 한해 저장 직전 1회만 인페인팅한다(캐시로 배치 간 중복 방지).
    // 대상: 다이어그램/일러스트 유형(anatomy_diagram/chart_graph/other) + 주석 텍스트 감지.
    // 실제 임상 사진(xray/ct/mri/ecg/pathology/microscope/ultrasound)은 재생성 위험이라 제외.
    // 생성 모델은 원본(주석 포함)을 보고 문항을 만들고(내용 이해), 학생에게는 정제본이 저장된다.
    // 정제 결과에 글자가 이보다 많이 남아 있으면 "텍스트 잔존"으로 판단(정답 단서 위험).
    //
    // 8 → 2 로 조인다. 잔존 계산에서 짧은 패널 라벨(A~E, 1~5)은 이미 빼고 세므로, 남은
    // 숫자는 전부 "실제 글자 조각"이다. 실측 사고: 잔존 3자가 통과했는데 그 3자가
    // 하필 "Int"(Intimal Flap 의 앞부분)라 화면에 그대로 읽혔다 — 진단 단어의 앞부분은
    // 조각이어도 정답 단서다. 단어 조각을 남기지 않으려면 임계가 한 글자 수준이어야 한다.
    // 한 글자는 진단명을 드러낼 수 없고(패널 라벨 A~E·1~5 는 애초에 세지 않는다),
    // OCR 이 질감을 글자로 오독하는 잡음이 대개 한 글자라 여기서 끊는다.
    // 실측: "In"(2자)이 화면에 그대로 읽혔다 — 두 글자부터는 단어 조각이라 막아야 한다.
    const RESIDUAL_TEXT_MAX = 1;
    // 2패스부터의 마스킹은 "앞 패스가 이미 빗나간 자리"를 덮는 작업이라 여백을 넉넉히 잡는다.
    // (1패스 기본 여백 pad 2px·8% 로는 작은 크롭에서 글자 가장자리가 삐져나왔다.)
    const SECOND_PASS_MASK_OPTS = { pad: 6, padRatio: 0.3 } as const;
    // 마스킹→검증 반복 상한. 실측 10장에서 1패스 5·2패스 3·3패스 1로 전부 수렴했다.
    const MAX_MASK_PASSES = 3;

    /**
     * 정제(마스킹) 결과에 남은 글자를 다시 읽어 "덮였는지"를 실제로 확인한다.
     *
     * 반환하는 len 은 문항 이미지에서 지워져야 할 글자 수 — 의도적으로 남기는 짧은
     * 패널 라벨(A~E, 1~5 …)은 제외한다. 그것들은 그림의 일부이자 발문이 가리키는
     * 대상이라 남는 게 정상이고, 세면 멀쩡한 이미지가 과도하게 제외된다.
     *
     * OCR 은 원본과 같은 전처리(업스케일·대비 정규화)를 거친 이미지로 수행해야 작은
     * 크롭의 글자를 놓치지 않는다. 실패하면 len 0 을 돌려 "판단 불가"로 통과시킨다
     * (검증 실패를 이유로 이미지를 버리면 일시적 API 오류가 공급을 끊는다).
     */
    const readResidualText = async (
      crop: CroppedImage,
      png: Uint8Array,
    ): Promise<{ len: number; boxes: NonNullable<Awaited<ReturnType<typeof runOcr>>['boxes']> }> => {
      try {
        const forOcr = await preprocessForOcr(png, {
          grayscale: crop.region.kind === 'ecg' || crop.region.kind === 'xray',
          normalizeContrast: true,
        }).catch(() => png);
        const r = await runOcr({
          png: forOcr,
          userIdForLog: input.userId,
          withBoxes: true,
          widthPx: crop.widthPx,
          heightPx: crop.heightPx,
        });
        totalCost += r.costUsd;
        const boxes = (r.boxes ?? []).filter((b) => !isShortFigureLabel(b.text));
        const len =
          boxes.length > 0
            ? boxes.map((b) => b.text).join('').replace(/[^\p{L}\p{N}]/gu, '').length
            : // 좌표가 없으면 전체 텍스트로 보수적으로 판단(짧은 라벨만 남은 경우는 통과).
              (r.text ?? '')
                .split(/\s+/)
                .filter((t) => !isShortFigureLabel(t))
                .join('')
                .replace(/[^\p{L}\p{N}]/gu, '').length;
        return { len, boxes };
      } catch {
        return { len: 0, boxes: [] };
      }
    };

    // 인페인팅된 이미지를 다시 OCR 하여 남은 "의미 있는 글자(한글·라틴·숫자)" 개수를 센다.
    // OCR 실패 시 0 반환(판단 불가 → 과도한 제외 방지).
    const residualTextLen = async (png: Uint8Array): Promise<number> => {
      try {
        const r = await runOcr({ png, userIdForLog: input.userId });
        totalCost += r.costUsd;
        return (r.text ?? '').replace(/[^\p{L}\p{N}]/gu, '').length;
      } catch {
        return 0;
      }
    };

    // 표시용 이미지 반환. 인페인팅 대상은 (1차 인페인팅 → OCR 검증 → 필요 시 2차 인페인팅)
    // 을 거치고, 그래도 글자가 남거나 인페인팅이 실패하면 null 을 반환한다.
    // null = "정답 단서 텍스트를 못 지운 이미지" → 호출자는 업로드/문항 연결을 하지 않고 제외한다.
    // ── 좌표 기반 마스킹 (생성형 인페인팅 대체)
    //
    // 인페인팅은 이미지를 재생성하는 방식이라 해부도·모식도에서 라벨을 새로 그려 넣었고,
    // 실측에서 4장 중 3장이 정제 후 글자가 오히려 늘어(11→32, 26→112, 28→115, 44→176자)
    // 폐기됐다. 장당 19~20초를 쓰고 결과를 버린 셈이다.
    // 이제 크롭 OCR 이 같은 호출에서 알려준 좌표만 배경색으로 덮는다(장당 수 ms, 추가 호출 0).
    // 그림 픽셀은 건드리지 않아 삽화가 보존되고, 정제 실패로 이미지를 잃지 않는다.
    // 문항이 가리켜야 하는 짧은 단독 라벨(A~E, 1~5 …)은 mask-text 규칙이 남긴다.
    //
    // 롤백: ENABLE_TEXT_INPAINT=1 이면 예전 생성형 인페인팅 경로를 쓴다.
    const legacyInpaint = process.env.ENABLE_TEXT_INPAINT === '1';

    // ── 지운 라벨 자리에 A·B·C 표식 찍기
    //
    // 정제가 그림 속 글자를 전부 지우고 나면 학생 화면의 그림에는 **가리킬 것이 하나도
    // 남지 않는다.** 그래서 이미지형 문항이 "이 그림에 대한 설명으로 옳은 것은?" 으로
    // 후퇴했다(2026-08-16 사용자 지적). 지운 좌표는 알고 있으므로 그 자리에 표식을
    // 찍고, 표식↔원본 라벨 대응표를 생성 모델에게만 넘긴다. 정답 단서(라벨 글자)는
    // 여전히 지워진 채로 "가리킬 대상"만 생긴다.
    // 롤백: ENABLE_IMAGE_MARKERS=0
    const markersEnabled = process.env.ENABLE_IMAGE_MARKERS !== '0';
    /**
     * 학생에게 보여줄 이미지. **표식이 있는 판과 없는 판을 둘 다** 만든다.
     *
     * 왜 둘 다인가(2026-08-16 운영 지적): 표식은 이미지 정제 단계에서 찍히는데, 그 이미지를
     * 쓰는 문항이 표식을 실제로 묻는지는 생성이 끝나야 안다. 한 판만 만들면 표식을 묻지
     * 않는 문항에도 A~E 가 붙어 나간다 — 실측에서 8장 중 5장이 그랬다. 표식은 가리킬 것이
     * 있을 때만 의미가 있고, 아니면 그림을 어지럽히는 낙서다.
     * 정제(마스킹)는 공유하고 표식만 얹은 판을 따로 두므로 추가 비용은 캔버스 렌더 1회뿐이다.
     */
    type DisplayImage = {
      /** 표식 없는 정제본 — 표식을 묻지 않는 문항이 쓴다. */
      plain: Uint8Array;
      /** 표식을 얹은 판. 표식이 없으면 plain 과 같은 참조. */
      annotated: Uint8Array;
      markers: PlacedMarker[];
    };
    const displayCache = new Map<number, Promise<DisplayImage | null>>();
    const getDisplayPng = (i: number): Promise<DisplayImage | null> => {
      const fi = featuredImages[i];
      const ocrLen = (fi.c.ocrText ?? '').replace(/[^\p{L}\p{N}]/gu, '').length;
      const boxes = fi.c.ocrBoxes ?? [];

      const cached = displayCache.get(i);
      if (cached) return cached;

      const p = (async (): Promise<DisplayImage | null> => {
        const t0 = Date.now();
        const rec: Record<string, unknown> = {
          gi: i,
          kind: fi.c.region.kind,
          ocrLen,
          boxes: boxes.length,
        };
        /**
         * 덮인 자리 중 "구조 이름 라벨"이었던 곳에 표식을 찍는다.
         *
         * 표식을 못 찍으면 대응표도 비운다 — 없는 표식을 가리키는 문항이 만들어지면
         * 학생이 풀 수 없다.
         */
        const withMarkers = async (
          png: Uint8Array,
          regions: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }>,
        ): Promise<DisplayImage> => {
          if (!markersEnabled || regions.length === 0) {
            return { plain: png, annotated: png, markers: [] };
          }
          const sources = selectMarkerSources(regions, fi.c.widthPx, fi.c.heightPx);
          if (sources.length === 0) {
            rec.markers = 0;
            return { plain: png, annotated: png, markers: [] };
          }
          const out = await annotateMarkers(png, sources);
          // 기본판에도 **필수 기호**(원본 지시선·브래킷이 붙은 자리)는 찍는다.
          //
          // #225 에서 "문항이 물을 때만 표식을 찍는다"로 바꿨더니, 라벨이 지워진 지시선이
          // 가리키는 것 없는 맨 선으로 남았다(2026-08-18 운영 지적: 뇌 사진의 지시선 3개,
          // 대뇌 겉질 그림의 층 브래킷). 원본에 지시선이 있다는 것은 그 자리에 이름표가
          // 있어야 한다는 뜻이므로, 그 기호는 문항과 무관하게 필수다.
          const req = await annotateMarkers(png, sources, { onlyRequired: true });
          rec.markers = out.markers.length;
          rec.requiredMarkers = req.markers.length;
          rec.markerLabels = out.markers.map((m) => `${m.letter}=${m.label}`);
          return { plain: req.png, annotated: out.png, markers: out.markers };
        };
        try {
          // 글자가 거의 없으면 손대지 않는다(정답 단서 위험 없음).
          // 지운 것이 없으니 표식을 찍을 자리도 없다.
          if (ocrLen < 8) {
            rec.result = 'no_text';
            return { plain: fi.c.png, annotated: fi.c.png, markers: [] };
          }

          if (!legacyInpaint) {
            let useBoxes = boxes;
            if (useBoxes.length === 0) {
              // 좌표 누락은 OCR 응답의 간헐적 실수인 경우가 많다. 바로 버리면 그 문항이
              // 텍스트 문항으로 치환돼 이미지 비율이 떨어지므로, 좌표 요청 OCR 을 1회
              // 재시도해 이미지를 살린다. (정제는 생성 전 병렬 구간 + 장당 시간 상한
              // 안에서 돌므로 전체 소요에 주는 영향은 없다.)
              try {
                const retry = await runOcr({
                  png: fi.c.ocrPng ?? fi.c.png,
                  userIdForLog: input.userId,
                  withBoxes: true,
                  widthPx: fi.c.widthPx,
                  heightPx: fi.c.heightPx,
                });
                totalCost += retry.costUsd;
                const retryBoxes = retry.boxes ?? [];
                rec.boxRetry = retryBoxes.length;
                if (retryBoxes.length > 0) useBoxes = retryBoxes;
              } catch {
                // 재시도 실패 → 아래 제외 경로.
              }
            }
            if (useBoxes.length === 0) {
              // 글자는 많은데 위치를 모른다 → 어디를 덮을지 알 수 없다.
              // 정답 단서가 남을 수 있으므로 문항 이미지에서 제외한다(안전 우선).
              warnings.push(`이미지 ${i}: 텍스트 위치를 얻지 못해 문항에서 제외(글자 ${ocrLen}자).`);
              rec.result = 'no_boxes';
              return null;
            }
            // ── 마스킹 + 결과 검증
            //
            // 마스킹은 "OCR 이 준 좌표"만 덮는다. 그 좌표가 일부 줄을 빠뜨리거나 어긋나면
            // 글자가 그대로 남는데, 배경이 어두운 영상에서는 빗나간 마스크가 배경색으로
            // 채워져 눈에 띄지 않아 육안 검수로도 놓친다.
            // 실측 사고(운영): 심초음파 크롭에서 라벨 7줄 중 2줄만 덮이고 "Intimal Flap"
            // 등 5줄이 남아 진단명이 이미지에 그대로 노출됐다. 그런데 진단 로그에는
            // "5개 마스킹"으로 남아 로그만으로는 정상으로 보였다.
            // 근본 원인은 좌표 품질이 아니라 **검증의 부재**다 — 생성형 인페인팅을 좌표
            // 마스킹으로 교체할 때(e040e76) 인페인팅 경로에 있던 잔존 텍스트 재검사가
            // 함께 옮겨지지 않았다. 아래에서 "덮은 뒤 실제로 글자가 사라졌는지"를 확인하고,
            // 남아 있으면 새로 얻은 좌표로 2차 마스킹, 그래도 남으면 이미지를 제외한다.
            // 마스킹 → 검증을 잔존 글자가 사라질 때까지 반복한다.
            //
            // 왜 반복이 필요한가: OCR 이 주는 박스는 글자보다 좁게 나오는 일이 잦다
            // (실측: "Aortic Valve" 가 x 7~60 에 있는데 박스는 7~37 — 뒤쪽 "Valve" 가
            // 그대로 남았다). 남은 조각을 다시 읽어 덮으면 대개 한 번 더로 정리되지만,
            // 그 조각의 박스도 또 좁을 수 있어 실행에 따라 두 번으로는 부족했다
            // (운영 실측에서 "Int" → "In" 처럼 한 글자씩만 줄어든 사례).
            // 실측 10장 기준 1패스 5·2패스 3·3패스 1로 전부 수렴한다.
            let current = fi.c.png;
            let boxesToMask = useBoxes;
            let lastLen = 0;
            // 1패스에서 덮인 자리 = 원본 라벨이 있던 자리. 표식은 여기에 찍는다
            // (2패스 이후는 "1패스가 빗나간 조각"이라 구조 이름이 아니다).
            let labelRegions: Array<{ text: string; x0: number; y0: number; x1: number; y1: number }> = [];
            for (let pass = 1; pass <= MAX_MASK_PASSES; pass++) {
              const m = await maskTextRegions(
                current,
                boxesToMask,
                // 2패스부터는 "앞 패스가 이미 빗나간 자리"를 덮는 작업이라 여백을 넉넉히.
                pass === 1 ? undefined : SECOND_PASS_MASK_OPTS,
              );
              current = m.png;
              rec[`pass${pass}Masked`] = m.masked;
              if (pass === 1) {
                rec.keptBoxes = m.kept;
                rec.keptReasons = m.keptReasons;
                labelRegions = m.regions;
              }

              const check = await readResidualText(fi.c, current);
              rec[`pass${pass}Residual`] = check.len;
              lastLen = check.len;
              if (check.len <= RESIDUAL_TEXT_MAX) {
                rec.result = pass === 1 ? 'masked' : `masked_${pass}pass`;
                rec.passes = pass;
                // 표식은 잔존 텍스트 검사를 통과한 뒤에 찍는다. A~E 는
                // isShortFigureLabel() 이 걸러 주지만, 검사 전에 찍으면 그 판정에
                // 의존하게 되므로 순서로 의존을 없앤다.
                return await withMarkers(current, labelRegions);
              }
              // 글자는 남았는데 위치를 모르면 더 덮을 수 없다.
              if (check.boxes.length === 0) break;
              boxesToMask = check.boxes;
            }
            warnings.push(
              `이미지 ${i}: ${MAX_MASK_PASSES}회 마스킹 후에도 글자 ${lastLen}자가 남아 문항에서 제외(정답 단서 위험).`,
            );
            rec.result = 'residual_text';
            rec.passes = MAX_MASK_PASSES;
            return null;
          }

          // ── 폴백: 예전 생성형 인페인팅(옵션)
          const cleaned = await inpaintRemoveText(fi.c.png, { userId: input.userId });
          rec.inpaintMs = Date.now() - t0;
          if (!cleaned) {
            warnings.push(`이미지 ${i}: 텍스트 제거 실패 — 문항에서 제외`);
            rec.result = 'inpaint_failed';
            return null;
          }
          const residual = await residualTextLen(cleaned);
          rec.residual = residual;
          if (residual > RESIDUAL_TEXT_MAX) {
            warnings.push(`이미지 ${i}: 텍스트가 남아 문항에서 제외(잔존 ${residual}자)`);
            rec.result = 'residual_text';
            return null;
          }
          // 생성형 인페인팅은 이미지를 재생성하므로 원본 좌표와 결과가 어긋난다 —
          // 표식을 찍을 수 없다(이 경로는 롤백용 옵션이다).
          rec.result = 'inpainted';
          return { plain: cleaned, annotated: cleaned, markers: [] };
        } catch (e) {
          rec.result = 'error';
          rec.error = e instanceof Error ? e.message.slice(0, 80) : String(e).slice(0, 80);
          return null;
        } finally {
          rec.totalMs = Date.now() - t0;
          diag.inpaint.push(rec);
        }
      })();
      displayCache.set(i, p);
      return p;
    };

    type GeneratedQuestion = {
      stem: string;
      choices: string[];
      answer_index: number;
      explanation: string;
      concepts: string[];
      difficulty: 1 | 2 | 3;
      /** P3 — 발문 유형(definition·mechanism·diagnosis…). 모델이 신고하고 저장·측정에 쓴다. */
      ask_kind?: string | null;
      image_indices: number[];
      sub_topic_code: string | null;
    };
    type BatchResult = {
      generatedCount: number;
      contentSummary: string;
      ids: string[];
      unmatched: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    };
    // 배치별 생성 컨텍스트 — "텍스트 선발사 배치"(이미지 없음)와 "전체 컨텍스트 배치"가
    // 같은 함수를 공유하기 위한 주입 지점.
    /**
     * 배치에 제시하는 이미지 한 장.
     *
     * markers 는 정제 단계에서 그 이미지에 실제로 찍힌 A·B·C 표식이다. 정제 완료 전에는
     * 알 수 없으므로 resolveFeatured 가 채운다(배정 시점에는 비어 있다).
     */
    type BatchImage = {
      slide: number;
      c: CroppedImage;
      gi: number;
      markers?: PlacedMarker[];
    };
    type GenContext = {
      contextText: string;
      /** 이 배치에 제시할 이미지. gi 는 전역 인덱스(인페인팅 캐시·Storage 경로 기준). */
      featured: BatchImage[];
      /**
       * 이미지를 "정제 완료를 기다려" 확정하는 경로. 있으면 featured 대신 이걸 쓴다.
       * 배치가 자기 몫의 정제만 기다리게 해서(배치별 게이팅) 느린 한 장이 다른 배치를
       * 붙잡지 않게 한다. 반환값에는 정제에 성공한 이미지만 담긴다.
       */
      resolveFeatured?: () => Promise<BatchImage[]>;
      /** 정제 후 확정된 장수로 이미지 문항 최소 수를 다시 계산한다(정제 탈락 반영). */
      imageQuotaFor?: (featuredLen: number, batchSize: number) => number;
      getDisplayPng: (gi: number) => Promise<DisplayImage | null>;
      /**
       * 이 배치에서 "환자 증례로 시작하는" 임상형 문항의 최소 수.
       * imageQuota 와 같은 이유로 정량 지시가 필요하다 — 정성 지시만으로는 배치가
       * 독립 판단해 임상형이 0개인 배치가 나온다(실측: 임상형 10문항 전부 지식형).
       */
      clinicalQuota?: number;
      /**
       * 이 배치에서 K0~K7 규격의 지식형으로 만들 최소 문항 수(P3).
       * clinicalQuota 와 같은 이유로 정량 지시가 필요하다.
       */
      knowledgeQuota?: number;
      /** 이 배치에 배정된 지식형 발문 유형(ask_kind) — 배치 간 유형 편중을 코드가 막는다. */
      knowledgeAskKinds?: readonly string[];
      /** 이 배치에서 부정형("옳지 않은 것은?") 발문을 허용하는지. */
      allowNegativeAsk?: boolean;
      /**
       * 429(rate limit) 재시도 대기 상한. 보충 배치는 본 배치들이 방금 끝난 직후에
       * 실행돼 429 를 맞기 쉬운데, 기본 상한(45초)을 그대로 기다리면 그 대기가 전체
       * 소요를 지배한다(실측 66초 꼬리). 보충은 짧게 여러 번 재시도한다.
       */
      retryMaxDelayMs?: number;
      /**
       * contextText 가 자료 "전체"가 아니라 배정된 구간인지. true 면 배치 지시문에서
       * "구간을 스스로 골라 출제하라"는 문구를 쓰지 않는다(이미 구간만 받았으므로).
       */
      segmented?: boolean;
      /**
       * 이 배치에서 "이미지를 직접 판독해야 풀 수 있는" 문항의 최소 수.
       * 시스템 프롬프트의 '확신이 없으면 image_indices 를 빈 배열로' 지시가 이미지형
       * 요청에서도 모델을 보수적으로 만들어, 이미지를 받은 배치조차 텍스트 문항만
       * 만드는 일이 잦았다 — 정량 지시로 강제한다. 0 이면 지시하지 않는다.
       */
      imageQuota?: number;
    };

    // 진단 카운터. generateAndPersistBatch 가 선발사 경로에서 일찍 호출되므로
    // const 가 아니라 함수 선언으로 두어 초기화 순서(TDZ) 문제를 피한다.
    function bumpGenDiag(key: string): void {
      diag.generation[key] = ((diag.generation[key] as number | undefined) ?? 0) + 1;
    }

    // 배치 1개 생성+저장. function 선언 호이스팅 덕분에 OCR 이전의 선발사 호출부에서도
    // 사용할 수 있다 (참조하는 카탈로그·프롬프트는 모두 4)에서 미리 준비됨).
    // slots: 이 배치가 채울 generation_slot 목록(연속이 아닐 수 있다 — 부족분 보충용).
    async function generateAndPersistBatch(
      batchIndex: number,
      slots: number[],
      batchCount: number,
      gen: GenContext,
    ): Promise<BatchResult> {
      const batchSize = slots.length;
      const tBatch = Date.now();
      // 이 배치에 배정된 이미지의 정제만 기다린다(다른 배치의 느린 이미지와 무관).
      const tWait = Date.now();
      const featured = gen.resolveFeatured ? await gen.resolveFeatured() : gen.featured;
      const imageWaitMs = Date.now() - tWait;
      const imageQuota = gen.imageQuotaFor
        ? gen.imageQuotaFor(featured.length, batchSize)
        : (gen.imageQuota ?? 0);
      const batchDiag: Record<string, unknown> = {
        i: batchIndex,
        size: batchSize,
        images: featured.length,
        imageWaitMs,
      };
      const validImageIndex = (i: number) => i >= 0 && i < featured.length;
      const { data: existingBatch, error: existingBatchError } = await admin
        .from('private_questions')
        .select('id, generation_slot')
        .eq('upload_id', uploadRow.id)
        .in('generation_slot', slots);
      if (existingBatchError) throw existingBatchError;
      if ((existingBatch?.length ?? 0) >= batchSize) {
        completedQuestions += batchSize;
        await updateProgress('partially_completed', completedQuestions, desiredCount, {
          completed_question_count: completedQuestions,
        });
        batchDiag.kept = batchSize;
        batchDiag.reused = true;
        batchDiag.totalMs = Date.now() - tBatch;
        diag.batches.push(batchDiag);
        return {
          generatedCount: batchSize,
          contentSummary: '',
          ids: (existingBatch ?? []).map((row) => row.id),
          unmatched: 0,
          cacheReadTokens: 0,
          cacheCreationTokens: 0,
        };
      }

      const userMessage = buildPrivateGenerationUserMessage({
        subTopicCatalog: catalog,
        desiredCount: batchSize,
        style,
        topic: input.topic,
        keywords: input.keywords,
      });
      const userContent: Anthropic.MessageParam['content'] = [];
      // 형식 프로파일을 뽑았으면 그림을 배치마다 다시 보내지 않는다(P7).
      //
      // 종전에는 참고 이미지 6장을 **모든 배치에** 실었다 — 배치 5개면 30장 분량이 오갔고,
      // 그러면서도 앞 3쪽만 본 셈이었다. 프로파일은 시스템 프롬프트(캐시 대상)에 한 번만
      // 붙으므로 더 많은 내용을 보고도 전송량이 준다. 스캔본이라 텍스트를 못 읽었을 때만
      // 종전처럼 그림을 싣는다.
      const referenceImagesForBatch = isUsableProfile(referenceProfile) ? [] : referenceImages;
      for (let i = 0; i < referenceImagesForBatch.length; i++) {
        userContent.push({
          type: 'text',
          text: `[기출 형식 참고 ${i + 1}] 내용은 출제 근거로 사용하지 말고 문항의 구조, 질문 방식, 선지 구성 방식만 참고하세요.`,
        });
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: Buffer.from(referenceImagesForBatch[i]).toString('base64'),
          },
        } as Anthropic.ImageBlockParam);
      }
      // 표식이 찍힌 이미지가 몇 장인지 — 배치 지시문의 표식 문항 요구에 쓴다.
      let markedImageCount = 0;
      for (let i = 0; i < featured.length; i++) {
        userContent.push({ type: 'text', text: `[이미지 ${i}] (필수 자료에서 커팅)` });
        userContent.push({
          type: 'image',
          source: {
            type: 'base64',
            media_type: 'image/png',
            data: await toGenerationImageBase64(featured[i].c.png),
          },
        } as Anthropic.ImageBlockParam);
        // 모델에게 주는 이미지는 라벨이 살아 있는 원본이고, 학생이 받는 이미지는 라벨이
        // 지워지고 그 자리에 표식이 찍힌 정제본이다. 그 차이를 대응표로 알려 줘야
        // "A로 표시된 …" 형태의 문항을 만들 수 있다.
        const legend = buildMarkerLegend(i, featured[i].markers ?? []);
        if (legend) {
          markedImageCount += 1;
          userContent.push({ type: 'text', text: legend });
        }
      }
      // 병렬 배치 간 중복 방지.
      //  - 구간 분할이 적용된 경우(gen.segmented): 아래 근거 자체가 이 배치에 배정된
      //    구간이므로 "구간을 골라 출제하라"고 하지 않고 "받은 근거로만 출제"하게 한다.
      //  - 분할하지 않은 경우(자료가 작음): 종전처럼 구간을 스스로 나눠 맡게 안내한다.
      const batchDirective =
        batchCount === 1
          ? ''
          : (gen.segmented
              ? `\n\n아래 출제 근거는 전체 자료를 ${batchCount}묶음으로 나눠 이번 묶음(${batchIndex + 1}번째)에 배정된 구간입니다. ` +
                `다른 묶음이 나머지 구간을 담당하므로, 제시된 근거 안에서만 출제하고 정확히 지정된 수만큼 만드세요.`
              : `\n\n이번 묶음은 전체 출제 계획 ${batchCount}묶음 중 ${batchIndex + 1}번째 묶음입니다. ` +
                `자료를 ${batchCount}개 구간으로 나눴을 때 ${batchIndex + 1}번째 구간의 내용을 우선 출제해 다른 묶음과의 중복을 피하고, 정확히 지정된 수만큼 만드세요.`) +
            (batchIndex === 0
              ? ' 핵심·기본 개념 문항을 포함하세요.'
              : ' 전형적인 기본 정의 문항보다 응용·감별 문항을 우선하세요.');
      // 초점 배정(P11) — "N번째 구간을 우선하라"는 말만으로는 배치들이 같은 증례를 만든다.
      // 같은 텍스트를 받은 모델들이 각자 고른 "N번째 구간"은 서로 다르지 않기 때문이다.
      // 자료의 소제목을 코드가 겹치지 않게 나눠 주고, 다른 묶음 몫도 함께 알려 준다.
      const focusDirective = buildFocusDirective(
        assignFocus(focusTopics, batchIndex, batchCount),
      );
      if (focusDirective) batchDiag.focusAssigned = true;
      // 세션 간 중복(P11) — 같은 파일을 다시 올린 경우. 이전 발문 앞부분을 보여 주고 피하게 한다.
      const priorStems = await withDeadline(priorStemsPromise, PRIOR_STEMS_TIMEOUT_MS, [], () =>
        bumpGenDiag('priorStemsTimeout'),
      );
      const priorDirective = buildPriorStemsDirective(priorStems ?? []);
      if (priorDirective) batchDiag.priorStems = (priorStems ?? []).length;
      // 이미지를 받지 못한 배치가 발문에서 그림을 가리키면(예: "다음은 …모식도이다")
      // 학생 화면에 그림 없는 문항이 나온다. 배치 단위로 명시 금지한다.
      const noImageDirective =
        featured.length === 0
          ? '\n\n이번 묶음에는 의료 이미지가 제공되지 않았습니다. 따라서 ' +
            '"다음은 …모식도이다", "아래 그림에서", "제시된 심전도에서" 처럼 제시되지 않은 그림·사진·' +
            '모식도를 가리키는 표현을 발문에 절대 쓰지 말고, image_indices 는 항상 빈 배열 [] 로 두세요. ' +
            '모든 문항은 제공된 텍스트만으로 풀 수 있어야 합니다.'
          : // 이미지를 받은 배치에도 "발문과 image_indices 를 반드시 일치시켜라"를 건다.
            // 실측: 그림을 가리키는 발문인데 image_indices 가 비어 있어 문항이 삭제되고
            // 보충 생성(27.6초)이 돌았다. 예방이 사후 재생성보다 훨씬 싸다.
            '\n\n**발문과 image_indices 는 반드시 일치시키세요.** ' +
            '"다음 CT에서", "제시된 그림은" 처럼 그림을 가리키는 표현을 쓸 거면 그 이미지 번호를 ' +
            'image_indices 에 반드시 넣고, 번호를 넣지 않을 문항에서는 그림을 가리키는 표현을 쓰지 마세요. ' +
            '(불일치 문항은 학생이 풀 수 없어 폐기됩니다.)' +
            // 이미지형 요청의 정량 강제. "우선 생성" 같은 정성 지시만으로는 기본 규칙
            // ('확신이 없으면 빈 배열')에 눌려 이미지를 받은 배치조차 텍스트 문항만
            // 만드는 일이 잦았다 — 최소 수를 명시해야 이미지 문항 비율이 유지된다.
            (imageQuota > 0
              ? `\n\n**이미지 판독 문항 최소 ${imageQuota}문항**: 이번 묶음 ${batchSize}문항 중 ` +
                `최소 ${imageQuota}문항은 제시된 [이미지 N]을 직접 판독·해석해야 풀 수 있는 문항으로 ` +
                `만들고, 그 문항의 image_indices 에 해당 번호를 넣으세요. 텍스트 근거와 이미지 근거가 ` +
                `모두 가능한 내용이면 이미지 판독 문항을 우선하세요. ` +
                `단, 같은 이미지는 최대 ${MAX_QUESTIONS_PER_IMAGE}문항까지만 사용하세요.\n\n` +
                // 이미지형의 실패 형태는 "이미지가 안 붙는 것"이 아니라 "붙었는데 봐도
                // 안 봐도 풀리는 것"이었다(사용자 지적 2026-08-16). 자기 점검을 못박는다.
                `**가림 검사(필수)**: 이미지 판독 문항을 하나 쓸 때마다 "그림을 손으로 가려도 이 문항이 ` +
                `풀리는가?"를 자문하세요. 풀린다면 그것은 이미지 문항이 아니라 지식 문항입니다. ` +
                `그림에서 읽어야만 알 수 있는 것(위치·모양·크기·분포·신호 강도·염색 양상·기호가 ` +
                `가리키는 대상)을 정답의 근거로 삼아 다시 쓰세요. ` +
                `"…에 대한 설명으로 옳은 것은?" 처럼 그림과 무관하게 성립하는 문두는 쓰지 않습니다.\n` +
                // 실측 실패 사례(2026-08-18): 뇌 단면도를 붙여 놓고 선지는 전부 신경전달물질
                // 설명이었다. 그림은 장식이고 정답은 교과서 지식으로 갈렸다.
                `- **선지 검사**: 다섯 선지가 모두 그림과 무관한 일반 지식 서술이면 그 문항은 ` +
                `이미지형이 아닙니다. 정답을 가르는 근거가 지문·선지의 글이 아니라 **그림**에 ` +
                `있어야 합니다.\n` +
                // 실측 실패 사례(2026-08-18): 선지가 I~V층을 하나씩 설명하는데, 학생이 받는
                // 그림에는 층을 가르는 표시가 하나도 없었다(원본 라벨은 정제로 지워진다).
                `- **구획 문항 조건**: 특정 층·구역·구획을 선지에서 하나씩 지목하려면(예: "I층은 …", ` +
                `"II층은 …"), 그 구획이 학생이 받는 그림에 **기호로 구분돼 있어야** 합니다. ` +
                `아래 "표식 안내"에 없는 구획은 학생이 어느 부분인지 알 수 없으므로 그런 문항을 ` +
                `만들지 마세요. 대신 그림에서 실제로 보이는 것(전체 형태·상대 위치·염색 양상)을 물으세요.\n` +
                `- **학생이 보는 그림에는 라벨 글자가 없습니다.** 원본에서 읽은 라벨을 학생도 볼 수 ` +
                `있다고 가정하지 마세요. 학생이 가리킬 수 있는 것은 기호(A·B·C…)뿐입니다.`
              : '') +
            // 표식(A·B·C)이 찍힌 이미지가 있으면 그것을 가리키는 문항을 반드시 만들게 한다.
            // 표식은 "그림을 봐야만 풀리는" 형태를 구조적으로 보장하는 유일한 장치다.
            // 표식 문항은 **드물게** 쓴다. 전체 10문항당 1문항 이하(사용자 정책 2026-08-16).
            // 조합형과 같은 이유로 정량 배분이 필요하다 — 배치가 병렬이라 "10 %"를 말로
            // 지시하면 배치마다 독립 판단해 과다 생성된다. 허용 배치를 정해 결정론적으로 나눈다.
            (markedImageCount > 0 && markerBatches.has(batchIndex)
              ? `\n\n**표식 문항 최대 1문항**: 표식 안내가 붙은 이미지가 ${markedImageCount}장 있습니다. ` +
                `이번 묶음에서는 "A로 표시된 구조는?" 처럼 **표식을 직접 가리키는 문항을 최대 1문항까지** ` +
                `만들 수 있습니다(적합하지 않으면 만들지 않아도 됩니다). ` +
                `표식을 가리킬 때는 반드시 **"…로 표시된"** 표현을 쓰고(예: "C로 표시된 부위의 진단은?"), ` +
                `image_indices 에 해당 이미지 번호를 넣으세요. ` +
                `대응표에 적힌 라벨 원문은 발문·선지·해설에 그대로 쓰지 마세요(정답 노출).`
              : markedImageCount > 0
                ? `\n\n이번 묶음에서는 **표식(A·B·C…)을 가리키는 문항을 만들지 마세요.** ` +
                  `표식 안내가 붙은 이미지가 있어도, 그 그림에서 읽어야 알 수 있는 소견으로 ` +
                  `문항을 만드세요.`
                : '');
      // 임상형 정량 지시. 이미지 유무와 무관하므로 noImageDirective 바깥에 둔다
      // (안에 두면 이미지를 못 받은 텍스트 배치가 이 지시를 통째로 놓친다).
      const clinicalDirective = buildClinicalQuotaDirective(batchSize, gen.clinicalQuota ?? 0);
      // 지식형 정량 지시(P3) — 배정된 발문 유형·부정형 허용 여부까지 숫자로 못박는다.
      const knowledgeDirective = buildKnowledgeQuotaDirective({
        batchSize,
        quota: gen.knowledgeQuota ?? 0,
        assignedAskKinds: gen.knowledgeAskKinds ?? [],
        allowNegative: gen.allowNegativeAsk ?? false,
      });
      // 조합형 빈도 제한(요청에 별도 조건이 없을 때).
      const comboDirective = comboBatches.has(batchIndex)
        ? '\n\n이번 묶음에서는 ㄱ/ㄴ/ㄷ 조합형을 **최대 1문항까지만** 포함할 수 있습니다(필요 없으면 넣지 않아도 됩니다). 나머지는 단일 정답 5지선다로 만드세요.'
        : '\n\n이번 묶음에서는 ㄱ/ㄴ/ㄷ 조합형("옳은 것을 모두 고른 것은?")을 **만들지 마세요.** 모든 문항을 단일 정답 5지선다로 만드세요.';
      userContent.push({
        type: 'text',
        text:
          `다음은 필수 업로드 자료에서 추출한 출제 근거입니다. 기출 형식 참고 자료의 의학 내용은 사용하지 말고, 아래 내용과 필수 자료 이미지만으로 문항을 만드세요.\n\n` +
          (gen.contextText || '(추출된 텍스트·이미지 없음)') +
          `\n\n${userMessage}${batchDirective}${focusDirective}${priorDirective}${noImageDirective}${clinicalDirective}${knowledgeDirective}${comboDirective}`,
      });

      // 해설 길이 상한(350자) 적용 후 문항당 실출력은 ~1,000토큰대. 다만 지시 이탈로
      // 길어질 때 출력이 잘리면 함수호출(functionCall)이 통째로 사라져 "tool_use 블록이
      // 없음"으로 실패하므로 예산은 여유 있게(문항당 1,800) 잡는다. max_tokens 는 상한일
      // 뿐이라 실제 속도는 실출력 토큰 수가 결정한다.
      const genMaxTokens = Math.min(16000, Math.max(6000, batchSize * 1800));
      const callGenerate = (maxTokens: number) =>
        withRetry(
          () =>
            createMessage(client, {
              model: modelUsed,
              max_tokens: maxTokens,
              system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
              tools: [PRIVATE_GENERATION_TOOL_SCHEMA],
              tool_choice: { type: 'tool', name: 'generate_private_questions' },
              messages: [{ role: 'user', content: userContent }],
            }),
          gen.retryMaxDelayMs
            ? { maxAttempts: 4, backoffMs: 700, maxDelayMs: gen.retryMaxDelayMs }
            : {},
        );
      const tGenCall = Date.now();
      // 헤지 대상은 "모델 호출"만이다 — 위쪽 이미지 준비 대기는 포함하지 않는다.
      // 패자 응답도 provider 는 청구하므로, 늦게 도착하면 hedgeLoser 로 별도 기록한다
      // (배치 완료 후 비동기 도착일 수 있어 totalCost 합산에는 넣지 않는다 — 일일 캡은
      // ai_cost_log 합산이라 기록만으로 반영된다).
      let response = await hedgedCall(() => callGenerate(genMaxTokens), {
        afterMs: GEN_HEDGE_AFTER_MS,
        onHedge: () => {
          bumpGenDiag('batchHedged');
          warnings.push(`배치 ${batchIndex + 1} 모델 호출 지연 — 복제 요청으로 꼬리 단축 시도.`);
        },
        onRetry: () => bumpGenDiag('batchRetried'),
        onLoser: (late) => {
          void recordAiCost({
            userId: input.userId,
            endpoint: 'private.generate',
            model: modelUsed,
            costUsd: calculateCost(
              modelUsed,
              late.usage.input_tokens,
              late.usage.output_tokens,
              late.usage.cache_read_input_tokens ?? 0,
              late.usage.cache_creation_input_tokens ?? 0,
            ),
            inputTokens: late.usage.input_tokens,
            outputTokens: late.usage.output_tokens,
            metadata: { uploadId: uploadRow.id, batch: batchIndex + 1, hedgeLoser: true },
          }).catch(() => undefined);
        },
      });
      batchDiag.genCallMs = Date.now() - tGenCall;
      let toolUseBlock = response.content.find(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      if (!toolUseBlock) {
        // 도구 호출 누락 — 대부분 출력 잘림(max_tokens) 또는 모델의 간헐적 미준수.
        // 예산을 2배로 올려 1회 재시도한다.
        console.warn(
          `[private-gen] tool_use 누락 → 재시도 (batch=${batchIndex + 1}, stop=${response.stop_reason})`,
        );
        // 버리는 첫 응답도 청구된 호출 — 폐기 사유와 함께 기록하고 합계에도 반영한다.
        const discardedCost = calculateCost(
          modelUsed,
          response.usage.input_tokens,
          response.usage.output_tokens,
          response.usage.cache_read_input_tokens ?? 0,
          response.usage.cache_creation_input_tokens ?? 0,
        );
        totalCost += discardedCost;
        aggInputTokens += response.usage.input_tokens;
        aggOutputTokens += response.usage.output_tokens;
        await recordAiCost({
          userId: input.userId,
          endpoint: 'private.generate',
          model: modelUsed,
          costUsd: discardedCost,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
          metadata: { uploadId: uploadRow.id, batch: batchIndex + 1, discarded: 'tool_use_missing' },
        });
        const tRetry = Date.now();
        response = await callGenerate(Math.min(30000, genMaxTokens * 2));
        batchDiag.genRetryMs = Date.now() - tRetry;
        toolUseBlock = response.content.find(
          (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
        );
      }
      if (!toolUseBlock) {
        throw new Error(
          `생성 응답에 도구 호출이 없습니다 (stop=${response.stop_reason ?? '?'}). 잠시 후 다시 시도해주세요.`,
        );
      }
      const parsed = toolUseBlock.input as {
        questions: GeneratedQuestion[];
        content_summary: string;
      };
      if (!Array.isArray(parsed.questions) || parsed.questions.length === 0) {
        throw new Error(`Claude 생성 응답 파싱 실패 (batch=${batchIndex + 1})`);
      }

      const genCost = calculateCost(
        modelUsed,
        response.usage.input_tokens,
        response.usage.output_tokens,
        response.usage.cache_read_input_tokens ?? 0,
        response.usage.cache_creation_input_tokens ?? 0,
      );
      totalCost += genCost;
      aggInputTokens += response.usage.input_tokens;
      aggOutputTokens += response.usage.output_tokens;
      await recordAiCost({
        userId: input.userId,
        endpoint: 'private.generate',
        model: modelUsed,
        costUsd: genCost,
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        metadata: {
          uploadId: uploadRow.id,
          batch: batchIndex + 1,
          batchCount,
          slides: extractedSlideCount,
          croppedImages: extractedCropCount,
          ocrChars,
        },
      });

      // 선지 5개 고정: 모델이 6개를 준 경우를 저장 전에 정규화하고, 채점 불가(정답 위치
      // 불명·선지 부족) 문항은 폐기한다. 폐기로 빈 슬롯이 생기면 보충 단계가 채운다.
      // 이후 이미지 연결·정리 로직은 모두 이 kept 배열 기준으로 인덱스를 맞춘다
      // (parsed.questions 를 그대로 쓰면 폐기분 때문에 inserted 와 어긋난다).
      // let — 검증(P1) 이 폐기 모드로 돌 때 걸러진 배열로 갈아끼운다.
      let kept: Array<{
        q: GeneratedQuestion;
        choices: string[];
        answerIndex: number;
        /** P1 검증 점수. 검증을 못 돌렸거나 시간 초과면 null. */
        verifyScore?: number | null;
      }> = [];
      for (const q of parsed.questions) {
        if (kept.length >= batchSize) break;
        const normalized = normalizeChoiceSet(q.choices, q.answer_index);
        if (!normalized) {
          warnings.push(
            `선지 구성이 올바르지 않아 문항 1개 폐기(선지 ${(q.choices ?? []).length}개) — 보충 생성으로 대체.`,
          );
          continue;
        }
        if (normalized.choices.length !== (q.choices ?? []).length) {
          warnings.push(
            `선지 ${(q.choices ?? []).length}개 → ${REQUIRED_CHOICE_COUNT}개로 정규화(정답 유지).`,
          );
        }
        // 정답 길이 누출(F17-L): 정답만 유독 길어 길이만으로 답이 드러나는 문항은 폐기하고
        // 보충 단계가 채우게 한다. 공유풀(admission)에서 검증된 규칙을 그대로 쓴다 —
        // 운영 987문항 실측에서 정답=최장 선지 32.6 %(임상형 36.7 %), 기대 20 %.
        const leakage = lintChoiceLeakage({
          stem: String(q.stem ?? ''),
          choices: normalized.choices,
          answer_index: normalized.answerIndex,
        }).filter((issue) => issue.rule === 'F17-L');
        if (leakage.length > 0) {
          bumpGenDiag('leakageDiscarded');
          warnings.push(`정답 길이 누출로 문항 1개 폐기 — 보충 생성으로 대체. ${leakage[0].message}`);
          continue;
        }
        // 정답 위치 셔플(조합형 제외) — 3번 쏠림(30.7 %)을 코드에서 없앤다.
        const shuffled = shuffleChoices(normalized.choices, normalized.answerIndex);
        kept.push({ q, choices: shuffled.choices, answerIndex: shuffled.answerIndex });
      }
      if (kept.length === 0) {
        throw new Error(`생성된 문항이 모두 형식 오류입니다 (batch=${batchIndex + 1})`);
      }

      // ── 검증 1패스 (P1)
      //
      // 내신 경로에는 의학적 정확성 검사가 **하나도** 없었다. 감사에서 실물 해설
      // "도파민은 억제성 신경전달물질로 운동 조절에 관여하며"가 그대로 저장돼 나갔다.
      // 공유풀(admission)이 쓰는 verifyQuestion 을 'private' 모드로 재사용한다 —
      // 형식(F 규격)은 코드가 이미 결정론적으로 보므로 의학 내용 4가지만 판정시킨다.
      //
      // 가용성 우선: 늦거나 실패한 검증은 **통과로 친다**. 검증 때문에 생성이 멈추는 쪽이
      // 검증 없이 저장되는 쪽보다 나쁘다. 못 돌린 건수는 verifyUnavailable 로 남는다.
      //
      // ⚠ 여기서 쌓는 warnings 는 지금 진단에만 남는 내부 기록이다. 경고를 화면에 띄우는
      //   P8 을 붙일 때 이 문구를 그대로 내보내지 말 것 — 검증기 판정문이 학생에게
      //   "이 문항은 틀렸을 수 있다"로 읽히는데 정작 조치는 안 한 상태가 된다.
      if (VERIFY_MODE !== 'off') {
        const tVerify = Date.now();
        const rejected = new Set<number>();
        await mapWithConcurrency(kept, VERIFY_CONCURRENCY, async (k, i) => {
          const verdict = await withDeadline(
            verifyQuestion({
              // private 모드 메시지는 과목·소주제를 쓰지 않는다(자료 기반이라 분류가 없다).
              subjectName: '내신대비',
              subTopicName: k.q.sub_topic_code ?? '미분류',
              isRiskCategory: false,
              mode: 'private',
              sourceText: gen.contextText,
              question: {
                ...k.q,
                choices: k.choices,
                answer_index: k.answerIndex,
              },
            }).catch((e: unknown) => {
              bumpGenDiag('verifyUnavailable');
              console.warn(
                '[private-gen] 검증 실패(통과 처리):',
                e instanceof Error ? e.message.slice(0, 140) : String(e),
              );
              return null;
            }),
            VERIFY_TIMEOUT_MS,
            null,
            () => bumpGenDiag('verifyTimeout'),
          );
          if (!verdict) return;

          k.verifyScore = verdict.score;
          void recordAiCost({
            userId: input.userId,
            endpoint: 'private.verify',
            model: verdict.usage.model,
            costUsd: verdict.usage.costUSD,
            inputTokens: verdict.usage.inputTokens,
            outputTokens: verdict.usage.outputTokens,
            metadata: { uploadId: uploadRow.id, batch: batchIndex + 1 },
          });
          totalCost += verdict.usage.costUSD;

          if (!isPrivateVerifyFailure(verdict, PRIVATE_VERIFY_REJECT_SCORE)) return;

          const reason = (verdict.issues ?? [])[0] ?? '사유 미상';
          if (VERIFY_MODE === 'discard') {
            rejected.add(i);
            bumpGenDiag('verifyRejected');
            warnings.push(
              `의학 검증 미통과로 문항 1개 폐기(${verdict.severity}, ${verdict.score.toFixed(2)}) — ` +
                `보충 생성으로 대체. ${String(reason).slice(0, 120)}`,
            );
          } else {
            bumpGenDiag('verifyFlagged');
            warnings.push(
              `의학 검증 경고(${verdict.severity}, ${verdict.score.toFixed(2)}): ` +
                String(reason).slice(0, 120),
            );
          }
        });
        batchDiag.verifyMs = Date.now() - tVerify;
        batchDiag.verifyScored = kept.filter((k) => typeof k.verifyScore === 'number').length;
        batchDiag.verifyMode = VERIFY_MODE;
        if (rejected.size > 0) {
          kept = kept.filter((_, i) => !rejected.has(i));
          if (kept.length === 0) {
            throw new Error(`생성된 문항이 모두 검증 미통과입니다 (batch=${batchIndex + 1})`);
          }
        }
      }

      // ── 이미지형 블라인드 풀이 검사 (P9)
      //
      // 프롬프트에는 "이 이미지를 빼도 풀 수 있는가를 자문하라"는 가림 검사가 있다.
      // 그런데 그건 모델의 자기점검이라 통과율이 100 %에 수렴했고, 실물에서
      // "뇌 단면도 … 설명으로 옳은 것은?"(그림 없이 풀리는 이미지형)이 그대로 나갔다.
      // 자문을 실측으로 바꾼다 — 그림을 빼고 실제로 풀려 보고, 독립 시도가 전부 정답이면
      // 그 그림은 장식이므로 폐기하고 보충이 채운다.
      //
      // 검증(P1)과 같은 가용성 원칙: 늦거나 실패한 시도는 판정하지 않는다.
      if (BLIND_MODE !== 'off') {
        const targets = kept
          .map((k, i) => ({ k, i }))
          .filter(({ k }) => (k.q.image_indices ?? []).some(validImageIndex));
        if (targets.length > 0) {
          const tBlind = Date.now();
          const blindRejected = new Set<number>();
          await mapWithConcurrency(targets, BLIND_CONCURRENCY, async ({ k, i }) => {
            const attempts = await withDeadline(
              Promise.all(
                Array.from({ length: BLIND_ATTEMPTS }, () =>
                  blindSolveOnce({ stem: String(k.q.stem ?? ''), choices: k.choices }).catch(
                    (e: unknown) => {
                      bumpGenDiag('blindUnavailable');
                      console.warn(
                        '[private-gen] 블라인드 풀이 실패(통과 처리):',
                        e instanceof Error ? e.message.slice(0, 140) : String(e),
                      );
                      return null;
                    },
                  ),
                ),
              ),
              BLIND_TIMEOUT_MS,
              null,
              () => bumpGenDiag('blindTimeout'),
            );
            if (!attempts) return;

            for (const a of attempts) {
              if (!a) continue;
              void recordAiCost({
                userId: input.userId,
                endpoint: 'private.blind',
                model: a.usage.model,
                costUsd: a.usage.costUSD,
                inputTokens: a.usage.inputTokens,
                outputTokens: a.usage.outputTokens,
                metadata: { uploadId: uploadRow.id, batch: batchIndex + 1 },
              });
              totalCost += a.usage.costUSD;
            }
            bumpGenDiag('blindChecked');

            const picks = attempts.map((a) => a?.answerIndex ?? null);
            if (!isBlindSolvable(picks, k.answerIndex)) return;

            // 왜 골랐는지는 폐기를 사람이 재검토할 때만 쓴다 — 사용자에게는 안 나간다.
            const basis = attempts.find((a) => a?.basis)?.basis ?? '';
            if (BLIND_MODE === 'discard') {
              blindRejected.add(i);
              bumpGenDiag('blindDiscarded');
              warnings.push(
                `그림 없이도 답이 정해져 이미지 문항 1개 폐기 — 보충 생성으로 대체. ${basis.slice(0, 120)}`,
              );
            } else {
              bumpGenDiag('blindFlagged');
              warnings.push(`블라인드 풀이 경고(그림 없이 ${BLIND_ATTEMPTS}회 정답): ${basis.slice(0, 120)}`);
            }
          });
          batchDiag.blindMs = Date.now() - tBlind;
          batchDiag.blindTargets = targets.length;
          batchDiag.blindMode = BLIND_MODE;
          if (blindRejected.size > 0) {
            kept = kept.filter((_, i) => !blindRejected.has(i));
            if (kept.length === 0) {
              throw new Error(
                `이미지 문항이 모두 그림 없이 풀립니다 (batch=${batchIndex + 1})`,
              );
            }
          }
        }
      }

      let unmatched = 0;
      const rows = kept.map((k, questionIndex) => {
        const subTopicId = k.q.sub_topic_code ? codeToId.get(k.q.sub_topic_code) ?? null : null;
        if (!subTopicId) unmatched += 1;
        const stem = normalizeStemEnding(sanitizeStemArtifacts(k.q.stem));
        // 실제로 만들어진 유형을 저장한다(P2). 요청 유형(user_uploads.requested_types)과
        // 대조해 '수확률'을 낸다 — 임상형을 요청했는데 지식형이 나오는 실패는 로그에
        // 흔적을 안 남겨서(저장 정상·문항 수 정상) 세지 않으면 아무도 모른다.
        // 그림이 붙은 문항은 image, 아니면 증례 판정(isClinicalVignette)으로 clinical/knowledge.
        const hasImage = (k.q.image_indices ?? []).some(validImageIndex);
        const kind: PrivateQuestionKind = hasImage
          ? 'image'
          : isClinicalVignette(stem)
            ? 'clinical'
            : 'knowledge';
        // ── 해설 규격(P12): 어미는 고치고, 길이·오답 언급은 재기만 한다.
        //
        // 어미만 결정론적으로 바꾼다(형태라서 의미가 안 변한다). 길이는 자르지 않는다 —
        // 의학 해설을 글자 수로 자르면 "…따라서 금기는" 에서 끊겨 틀린 문항이 된다.
        // 오답 언급도 세기만 한다: 해설을 코드가 이어 붙이면 근거 없는 문장이 생긴다.
        const toned = normalizeExplanation(String(k.q.explanation ?? ''));
        if (toned.changed) bumpGenDiag('explanationToneFixed');
        if (toned.unresolved.length > 0) {
          bumpGenDiag('explanationToneUnresolved');
          warnings.push(
            `해설 어미를 통일하지 못함(변환표에 없는 어미: ${toned.unresolved.slice(0, 3).join(', ')}) — 원문 유지.`,
          );
        }
        const explanation = toned.text;
        if (explanation.length > EXPLANATION_SOFT_LIMIT_CHARS) {
          bumpGenDiag('explanationTooLong');
          warnings.push(
            `해설이 ${explanation.length}자로 상한(${EXPLANATION_TARGET_CHARS}자)을 넘음 — 자르지 않고 기록만 함.`,
          );
        }
        const coverage = countDistractorsMentioned({
          explanation,
          choices: k.choices,
          answerIndex: k.answerIndex,
        });
        if (coverage.mentioned < MIN_DISTRACTORS_MENTIONED) {
          bumpGenDiag('explanationThinDistractors');
          warnings.push(
            `해설이 오답 ${coverage.total}개 중 ${coverage.mentioned}개만 다룸(누락 ${coverage.missing.join('·')}번).`,
          );
        }
        return {
          user_id: input.userId,
          upload_id: uploadRow.id,
          sub_topic_id: subTopicId,
          stem,
          choices: k.choices,
          answer_index: k.answerIndex,
          explanation,
          concepts: k.q.concepts ?? [],
          difficulty: k.q.difficulty,
          generation_slot: slots[questionIndex],
          kind,
          // P3 — 모델이 신고한 발문 유형. 카탈로그 밖 값은 버린다(오탈자·창작 방지).
          ask_kind: normalizeAskKind(k.q.ask_kind),
          verify_score: k.verifyScore ?? null,
        };
      });

      // ── P3·P4 계측: 발문 규칙 위반·유형 편중·난이도 신고 대조.
      //
      // 임상형 수확량과 같은 이유로 "세기만" 한다. 발문을 자동으로 고치면 의미가 바뀌고
      // (예: "가장 적절한 치료는?" → "치료는?" 은 선지 우열 판정을 바꾼다), 난이도는
      // 애초에 코드가 판정할 수 없다. 첫 주는 경고·진단으로만 남겨 프롬프트 효과를 본다.
      {
        const forbidden = rows.filter((r) => hasForbiddenAsk(r.stem));
        const shells = rows.filter((r) => r.kind === 'knowledge' && hasPatientIntro(r.stem));
        const askKinds = rows.map((r) => r.ask_kind).filter(Boolean) as string[];
        const dupAsk = askKinds.length - new Set(askKinds).size;
        batchDiag.forbiddenAsk = forbidden.length;
        batchDiag.knowledgeShell = shells.length;
        batchDiag.askKindDup = dupAsk;
        batchDiag.askKinds = askKinds;
        if (forbidden.length > 0) {
          warnings.push(
            `배치 ${batchIndex + 1}: 금지 발문("가장 적절한"·"다음 중") ${forbidden.length}문항 — ` +
              `예: ${forbidden[0].stem.slice(-24)}`,
          );
        }
        if (shells.length > 0) {
          warnings.push(
            `배치 ${batchIndex + 1}: 껍데기 증례(환자 도입 + 지식형 발문) ${shells.length}문항.`,
          );
        }
        if (requestedDifficultyLevel !== null) {
          const mismatched = rows.filter((r) => r.difficulty !== requestedDifficultyLevel).length;
          batchDiag.difficultyMismatch = mismatched;
          batchDiag.difficultyReported = rows.map((r) => r.difficulty);
        }
      }

      // 임상형 수확량 계측.
      //
      // 이 실패는 로그에 흔적을 안 남긴다 — 저장은 정상이고 문항 수도 맞다. 화면을 사람이
      // 보기 전에는 아무도 모른다(그래서 2026-08-16 에 사용자가 먼저 발견했다).
      // 고치지는 않는다: 지문을 자동으로 증례로 바꾸는 것은 의학 내용을 발명하는 일이라
      // 코드가 할 수 없다. 대신 세어서 경고·진단으로 남겨 회귀를 즉시 드러낸다.
      const clinicalQuota = gen.clinicalQuota ?? 0;
      if (clinicalQuota > 0) {
        const yieldStat = measureClinicalYield(
          rows.map((r) => r.stem),
          clinicalQuota,
        );
        batchDiag.clinicalQuota = clinicalQuota;
        batchDiag.clinicalKept = yieldStat.clinical;
        if (yieldStat.shortfall > 0) {
          warnings.push(
            `배치 ${batchIndex + 1}: 임상 증례형이 ${yieldStat.clinical}/${clinicalQuota}문항에 그침` +
              `(전체 ${yieldStat.total}문항) — 나머지는 지식형으로 생성됨.`,
          );
        }
      }

      const upsertOptions = { onConflict: 'upload_id,generation_slot' } as const;
      const saveWithoutMetrics = () =>
        admin
          .from('private_questions')
          .upsert(rows.map(withoutMetricColumns), upsertOptions)
          .select('id');

      let { data: inserted, error: insertErr } = questionMetricColumnsSupported
        ? await admin.from('private_questions').upsert(rows, upsertOptions).select('id')
        : await saveWithoutMetrics();
      // 00040 미적용 환경: 계측 컬럼 때문에 저장 전체가 거절되면 계측만 버리고 다시 넣는다.
      if (insertErr && questionMetricColumnsSupported && isMissingColumnError(insertErr)) {
        questionMetricColumnsSupported = false;
        warnings.push('문항 유형 계측 컬럼이 없어 계측 없이 저장(마이그레이션 00040 미적용).');
        ({ data: inserted, error: insertErr } = await saveWithoutMetrics());
      }
      if (insertErr || !inserted) {
        throw new Error('생성된 문항을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.');
      }

      const usedIndices = new Set<number>();
      for (const { q } of kept) {
        for (const i of q.image_indices ?? []) if (validImageIndex(i)) usedIndices.add(i);
      }
      // ── 표식은 "그 표식을 실제로 묻는 문항"에만 붙인다.
      //
      // 표식은 정제 단계에서 찍히는데, 그 이미지를 쓰는 문항이 표식을 묻는지는 생성이
      // 끝나야 안다. 종전에는 한 판만 만들어 표식을 묻지 않는 문항에도 A~E 가 붙어
      // 나갔다(실측 8장 중 5장). 이제 문항별로 어느 판을 쓸지 고른다.
      // 같은 이미지가 두 문항에 걸리고 한쪽만 표식을 물으면 두 판을 각각 저장한다.
      const wantsMarked = (stem: string) => stemReferencesMarker(sanitizeStemArtifacts(stem));
      const variantsNeeded = new Map<number, Set<boolean>>();
      for (const { q } of kept) {
        const marked = wantsMarked(q.stem);
        for (const i of q.image_indices ?? []) {
          if (!validImageIndex(i)) continue;
          const set = variantsNeeded.get(i) ?? new Set<boolean>();
          set.add(marked);
          variantsNeeded.set(i, set);
        }
      }
      // key = `${로컬 이미지 인덱스}:${표식판 여부}`.
      const indexToPath = new Map<string, string>();
      const tImages = Date.now();
      let markedUploads = 0;
      // 이미지당 인페인팅(+검증 OCR)이 수십 초씩 걸릴 수 있어 직렬 대신 병렬로 정제·업로드.
      await Promise.all(
        [...usedIndices].map(async (i) => {
          const gi = featured[i].gi;
          const display = await gen.getDisplayPng(gi);
          if (!display) return; // 텍스트 제거 실패로 제외된 이미지 — 업로드/연결 안 함
          const variants = variantsNeeded.get(i) ?? new Set([false]);
          for (const marked of variants) {
            // 표식이 없는 이미지는 두 판이 같으므로 표식판을 따로 만들지 않는다.
            const useMarked = marked && display.markers.length > 0;
            const imgPath = questionImagePath(uploadRow.user_id, uploadRow.id, gi, useMarked);
            const { error: upErr } = await admin.storage
              .from(STORAGE_BUCKET)
              .upload(imgPath, Buffer.from(useMarked ? display.annotated : display.plain), {
                contentType: 'image/png',
                upsert: true,
              });
            if (upErr) warnings.push(`이미지 ${gi} Storage 저장 실패 — ${upErr.message}`);
            else {
              indexToPath.set(`${i}:${marked}`, imgPath);
              if (useMarked) markedUploads += 1;
            }
          }
        }),
      );
      batchDiag.imageWorkMs = Date.now() - tImages;
      batchDiag.imagesUsed = indexToPath.size;
      batchDiag.markedUploads = markedUploads;
      const imageRows = kept.flatMap(({ q }, qi) => {
        const qId = inserted[qi]?.id;
        if (!qId) return [];
        return (q.image_indices ?? [])
          .filter(validImageIndex)
          .map((i, order) => {
            const storagePath = indexToPath.get(`${i}:${wantsMarked(q.stem)}`);
            if (!storagePath) return null;
            const fi = featured[i];
            // 발문이 말하는 검사와 다른 종류의 이미지는 연결하지 않는다(예: 발문은
            // 흉부 X-ray 인데 붙은 그림은 심초음파 — 학생이 볼 때 따로 논다).
            // 연결을 끊으면 이후 "그림을 가리키는데 이미지가 없는 문항" 정리가 받아
            // 발문이 그림에 의존하면 삭제하고 보충 생성이 채운다.
            if (stemModalityConflict(sanitizeStemArtifacts(q.stem), fi.c.region.kind)) {
              warnings.push(
                `문항 발문과 이미지 종류 불일치(${fi.c.region.kind}) — 이미지 연결 해제.`,
              );
              return null;
            }
            return {
              private_question_id: qId,
              user_id: input.userId,
              upload_id: uploadRow.id,
              storage_path: storagePath,
              source_page: fi.slide,
              kind: fi.c.region.kind,
              // 캡션(이미지 하단 작은 글자 설명)은 저장하지 않는다 — OCR 로 잡힌 주석이
              // 정답 단서로 노출되거나 UI 를 지저분하게 만들어 표시하지 않기로 함.
              caption: null,
              sort_order: order,
            };
          })
          .filter((row): row is NonNullable<typeof row> => row !== null);
      });
      if (imageRows.length > 0) {
        const { error: imageError } = await admin
          .from('private_question_images')
          .upsert(imageRows, { onConflict: 'private_question_id,storage_path' });
        if (imageError) warnings.push(`이미지 연결 저장 실패 — ${imageError.message}`);
      }

      // 텍스트 제거 실패로 이미지가 제외된 문항 처리.
      // 발문이 그림을 가리키는(그림 없이는 못 푸는) 문항만 삭제하고, 텍스트만으로 완결된
      // 문항은 이미지 연결만 빠진 채로 살린다 — 불필요한 삭제는 요청 수 미달과
      // 보충 생성(수십 초 추가)을 유발한다.
      const orphanIds: string[] = [];
      kept.forEach(({ q }, qi) => {
        const idx = (q.image_indices ?? []).filter(validImageIndex);
        if (idx.length === 0) return;
        // 살아남은 이미지가 하나라도 있으면 유지 (그 문항이 실제로 쓰는 판 기준).
        if (idx.some((i) => indexToPath.has(`${i}:${wantsMarked(q.stem)}`))) return;
        const qid = inserted[qi]?.id;
        if (!qid) return;
        if (stemDependsOnImage(q.stem)) {
          orphanIds.push(qid);
        } else {
          warnings.push('이미지가 제외됐지만 발문이 텍스트만으로 완결돼 문항은 유지.');
        }
      });
      if (orphanIds.length > 0) {
        await admin.from('private_questions').delete().in('id', orphanIds);
      }
      const orphanSet = new Set(orphanIds);

      // kind 보정 — 그림 없이 살아남은 문항은 image 가 아니다.
      // 저장은 생성 결과(image_indices)로 라벨을 붙이지만, 그 뒤 정제 실패·모달리티 불일치로
      // 연결이 끊길 수 있다. 그대로 두면 '이미지형 수확률'이 실제보다 높게 잡혀
      // 측정 자체가 거짓말을 한다.
      if (questionMetricColumnsSupported) {
        const withImage = new Set(imageRows.map((r) => r.private_question_id));
        const demoted = new Map<PrivateQuestionKind, string[]>();
        rows.forEach((row, qi) => {
          const qid = inserted?.[qi]?.id;
          if (!qid || orphanSet.has(qid)) return;
          if (row.kind !== 'image' || withImage.has(qid)) return;
          const corrected: PrivateQuestionKind = isClinicalVignette(row.stem)
            ? 'clinical'
            : 'knowledge';
          demoted.set(corrected, [...(demoted.get(corrected) ?? []), qid]);
        });
        for (const [kind, ids] of demoted) {
          const { error: kindErr } = await admin
            .from('private_questions')
            .update({ kind })
            .in('id', ids);
          if (kindErr) warnings.push(`문항 유형 보정 실패 — ${kindErr.message}`);
        }
      }

      const keptIds = inserted
        .map((row) => row.id)
        .filter((id): id is string => !!id && !orphanSet.has(id));
      const keptCount = Math.max(0, rows.length - orphanIds.length);

      completedQuestions += keptCount;
      await updateProgress(
        completedQuestions < desiredCount ? 'partially_completed' : 'generating',
        completedQuestions,
        desiredCount,
        { completed_question_count: completedQuestions },
      );
      batchDiag.kept = keptCount;
      batchDiag.totalMs = Date.now() - tBatch;
      diag.batches.push(batchDiag);
      return {
        generatedCount: keptCount,
        contentSummary: parsed.content_summary,
        ids: keptIds,
        unmatched,
        cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
        cacheCreationTokens: response.usage.cache_creation_input_tokens ?? 0,
      };
    }

    // ── 이미지 정제를 생성 "이전"에 끝낸다.
    //
    // 종전에는 생성이 끝난 뒤 참조된 이미지를 정제했다. 그래서 (a) 정제 대기가 배치 완료를
    // 붙잡고, (b) 정제 실패 이미지를 참조한 문항이 삭제돼 보충 생성까지 유발했다
    // (실측: 배치 구간 136초, 8장 중 4장 폐기 후 2문항 보충).
    // 이제 생성 전에 정제를 끝내고 실패한 이미지는 목록에서 제거한다. 모델은 애초에 쓸 수 있는
    // 이미지만 보므로 사후 삭제·보충이 사라지고, 정제는 이미 출발한 텍스트 배치와 겹쳐 돈다.
    // 장당 시간 상한(IMAGE_REFINE_TIMEOUT_MS)을 둬 느린 한 건이 전체를 붙잡지 못하게 한다.
    // ★ 배치별 이미지 준비 게이팅
    //
    // 종전에는 여기서 featured 전체의 정제가 끝날 때까지 기다린 뒤(배리어) 배치를
    // 출발시켰다. 배치마다 쓰는 이미지가 다른데도 "가장 느린 이미지 한 장"이 모든 이미지
    // 배치를 붙잡았다(실측: 정제 구간이 15.3초까지 커져 앞단에서 번 8초를 상쇄).
    // 이제 배치는 자기에게 배정된 이미지의 정제만 기다린다. 정제는 이미지별로 독립이고
    // getDisplayPng 는 gi 단위로 캐시되므로, 배정만 먼저 확정하면 서로 기다릴 이유가 없다.
    const withRefineTimeout = (
      promise: Promise<DisplayImage | null>,
    ): Promise<DisplayImage | null> =>
      Promise.race([
        promise,
        new Promise<DisplayImage | null>((resolve) =>
          setTimeout(() => resolve(null), IMAGE_REFINE_TIMEOUT_MS),
        ),
      ]);
    diag.extract.featuredBefore = featuredImages.length;
    // 정제에 성공해 실제로 문항에 쓸 수 있었던 이미지(gi) — 배치들이 채워 나간다.
    const refinedUsableGis = new Set<number>();
    /** 배정된 이미지의 정제를 기다려 "쓸 수 있는 것만" 남긴다. 장당 시간 상한 적용. */
    const resolveRefined = async (list: BatchImage[]): Promise<BatchImage[]> => {
      if (list.length === 0) return [];
      const results = await Promise.all(
        list.map(async (fi) => ({ fi, display: await withRefineTimeout(getDisplayPng(fi.gi)) })),
      );
      // 정제 결과에 찍힌 표식을 이미지에 붙여 배치 프롬프트가 대응표를 쓸 수 있게 한다.
      const usable = results
        .filter((r) => r.display !== null)
        .map((r) => ({ ...r.fi, markers: r.display?.markers ?? [] }));
      for (const fi of usable) refinedUsableGis.add(fi.gi);
      if (usable.length < list.length) {
        warnings.push(
          `이미지 정제 결과 ${usable.length}/${list.length}장만 이 배치에서 사용 가능 — 나머지는 제외.`,
        );
      }
      return usable;
    };

    // 배치별 이미지 배정: 같은 이미지를 여러 배치가 각자 문항으로 쓰면 "동일 이미지 최대
    // 2문제" 정리에서 초과분 문항이 삭제된다. 배치마다 겹치지 않는 이미지 묶음을 주면
    // 한 이미지를 참조하는 문항이 배치 크기(≤2) 이하로 제한돼 삭제가 발생하지 않는다.
    // 배정은 "정제 이전" 목록(featuredImages)으로 한다 — 정제 결과를 기다려 배정하면
    // 다시 배리어가 생긴다. 정제에 실패한 장은 각 배치가 자기 몫을 기다릴 때 걸러낸다.
    const featuredForBatch = (batchIndex: number, batchCount: number) => {
      if (!useImages || featuredImages.length === 0) return [];
      if (batchCount <= 1) return featuredImages;
      // 텍스트 선발사로 먼저 출발한 배치는 OCR·이미지 이전에 시작했으므로 이미지를 받을 수
      // 없다. 이미지는 남은 배치들에만 분배해 어떤 이미지도 버려지지 않게 한다.
      const eligible = Array.from(
        { length: Math.max(0, batchCount - prefireCount) },
        (_, k) => k + prefireCount,
      );
      if (eligible.length === 0) return [];
      const pos = eligible.indexOf(batchIndex);
      if (pos < 0) return [];
      // 균등 분배(나머지를 앞 배치부터 1장씩). 종전 ceil 분배는 앞 배치가 몫을 다 가져가
      // 꼬리 배치가 0장을 받았다 — 6장·4배치면 [2,2,2,0] 이 되어 마지막 배치 문항이
      // 통째로 텍스트 문항이 됐다(실측에서 이미지 문항이 8개가 아닌 6개에 그친 직접 원인).
      // 이제 [2,2,1,1] 로 나눠 자격 있는 배치는 최소 1장을 받는다.
      const base = Math.floor(featuredImages.length / eligible.length);
      const remainder = featuredImages.length % eligible.length;
      const start = pos * base + Math.min(pos, remainder);
      const count = base + (pos < remainder ? 1 : 0);
      // 이미지 수가 배치 수보다 적으면 뒤쪽 배치는 이미지 없이(텍스트 문항) 생성한다.
      return featuredImages.slice(start, start + count);
    };

    // 배치의 "이미지 판독 문항 최소 수". 단독 선택이면 배치 전 문항이 목표, 유형 혼합이면
    // 유형 비중만큼(최소 1). 배정된 이미지의 재사용 상한(장당 MAX_QUESTIONS_PER_IMAGE)을
    // 넘는 강제는 하지 않는다 — 초과분은 저장 후 정리에서 삭제돼 오히려 문항을 잃는다.
    const imageQuotaFor = (featuredLen: number, batchSize: number): number => {
      if (!wantsImages || featuredLen === 0) return 0;
      const supplyCap = featuredLen * MAX_QUESTIONS_PER_IMAGE;
      if (selectedTypes.length <= 1) return Math.min(batchSize, supplyCap);
      return Math.max(
        1,
        Math.min(batchSize, supplyCap, Math.round(batchSize / selectedTypes.length)),
      );
    };

    const genFor = (batchIndex: number, batchCount: number): GenContext => {
      const assigned = featuredForBatch(batchIndex, batchCount);
      return {
        contextText: segmentForBatch(batchIndex, batchCount),
        // 배정만 지금 확정하고, 정제 완료는 배치가 시작할 때 자기 몫만 기다린다.
        featured: [],
        resolveFeatured: () => resolveRefined(assigned),
        imageQuotaFor,
        getDisplayPng,
        segmented: segmentCount > 1,
        clinicalQuota: clinicalQuotaFor(batchSizes[batchIndex] ?? 1),
        knowledgeQuota: knowledgeQuotaFor(batchSizes[batchIndex] ?? 1),
        knowledgeAskKinds: knowledgeAskPlan(batchIndex, batchSizes[batchIndex] ?? 1),
        allowNegativeAsk: negativeBatches.has(batchIndex),
      };
    };

    const tGen = Date.now();
    const batchFailureReasons: string[] = [];

    const batchSettled = await mapWithConcurrency(
      batchSizes,
      GEN_CONCURRENCY,
      async (batchSize, batchIndex): Promise<BatchResult | null> => {
        const slots = Array.from(
          { length: batchSize },
          (_, k) => batchSizes.slice(0, batchIndex).reduce((sum, size) => sum + size, 0) + k,
        );
        try {
          const early = prefired[batchIndex];
          if (early) {
            const settled = await early;
            if (settled.ok) return settled.v;
            // 선발사 실패(일시 오류·텍스트 컨텍스트 부족) → OCR 완료된 전체 컨텍스트로 재시도.
            // (부분 저장은 upsert(upload_id,generation_slot) + 기존 슬롯 조회로 안전하게 이어짐.)
            console.warn(
              `[private-gen] 텍스트 선발사 배치 ${batchIndex + 1} 실패 — 전체 컨텍스트로 재시도:`,
              settled.e instanceof Error ? settled.e.message : String(settled.e),
            );
          }
          return await generateAndPersistBatch(
            batchIndex,
            slots,
            batchSizes.length,
            genFor(batchIndex, batchSizes.length),
          );
        } catch (e) {
          // 배치 1개 실패가 전체 생성을 실패시키지 않게 격리한다. 빈 슬롯은 아래 보충 단계가
          // 다시 채운다(이전에는 여기서 throw 되어 성공한 배치까지 'failed' 로 끝났다).
          const reason = e instanceof Error ? e.message : String(e);
          batchFailureReasons.push(reason);
          warnings.push(`배치 ${batchIndex + 1} 생성 실패 — 보충 생성으로 대체 시도. ${reason}`);
          return null;
        }
      },
    );
    diag.timings.batchesMs = Date.now() - tGen;
    // 배리어를 없앤 대신, 실제로 정제에 성공해 쓰인 이미지 수를 여기서 집계한다.
    diag.extract.featuredUsable = refinedUsableGis.size;
    const batchResults = batchSettled.filter((r): r is BatchResult => r !== null);
    diag.generation.batchesSucceeded = batchSettled.filter((r) => r !== null).length;
    if (batchResults.length === 0) {
      // 전부 실패한 경우 원인을 그대로 올린다(크레딧 소진 등은 sanitizeErrorMessage 가
      // 사용자용 문구로 바꾼다). 종전에는 일괄 "잠시 후 다시 시도" 문구라 원인 파악이 불가능했다.
      const firstReason = batchFailureReasons[0];
      throw new Error(
        firstReason
          ? `문항 생성에 모두 실패했습니다. ${firstReason}`
          : '문항 생성에 모두 실패했습니다. 잠시 후 다시 시도해주세요.',
      );
    }
    const unmatched = batchResults.reduce((sum, result) => sum + result.unmatched, 0);

    // 동일 의료 이미지 최대 2문제: 병렬 배치라 같은 이미지가 여러 문항(2개 초과)에
    // 연결될 수 있다. 업로드 전체를 훑어 storage_path 당 문항이 2개를 넘으면 초과분의
    // 이미지 연결을 제거하고, 그 결과 이미지가 하나도 남지 않은(=이미지 판독 전용) 문항은
    // 발문이 실제 이미지 없이 이미지를 참조하게 되므로 통째로 삭제한다.
    // (함수로 분리: 이미지를 실은 보충 배치가 새 연결을 만들 수 있어 보충 라운드 뒤에도
    //  같은 정리를 다시 돌린다. 멱등 — 유지 대상 선정이 generation_slot 순이라 반복 호출 안전.)
    const enforceImageReuseCap = async (): Promise<void> => {
    try {
      const [{ data: linkRows }, { data: slotRows }] = await Promise.all([
        admin
          .from('private_question_images')
          .select('id, private_question_id, storage_path')
          .eq('upload_id', upload.id),
        admin
          .from('private_questions')
          .select('id, generation_slot, stem')
          .eq('upload_id', upload.id),
      ]);
      const slotOf = new Map((slotRows ?? []).map((r) => [r.id, r.generation_slot ?? 0]));
      // 같은 이미지의 표식판(`_m`)과 기본판은 **한 이미지로 묶어야** 한다. 경로로 묶으면
      // 두 판이 각각 상한(MAX_QUESTIONS_PER_IMAGE)을 받아 한 그림이 4문항에 붙는다.
      const imageKey = (p: string) => {
        const gi = questionImageIndex(p ?? '');
        return gi === null ? p : `gi:${gi}`;
      };
      const byPath = new Map<string, { id: string; qid: string }[]>();
      for (const r of linkRows ?? []) {
        const key = imageKey(r.storage_path);
        const arr = byPath.get(key) ?? [];
        arr.push({ id: r.id, qid: r.private_question_id });
        byPath.set(key, arr);
      }
      const removeLinkIds: string[] = [];
      for (const [, arr] of byPath) {
        // 오래된(먼저 생성된) 문항 우선 유지 — generation_slot 순.
        arr.sort((a, b) => (slotOf.get(a.qid) ?? 0) - (slotOf.get(b.qid) ?? 0));
        const keptQ = new Set<string>();
        for (const r of arr) {
          if (keptQ.size < MAX_QUESTIONS_PER_IMAGE || keptQ.has(r.qid)) keptQ.add(r.qid);
          else removeLinkIds.push(r.id);
        }
      }
      if (removeLinkIds.length > 0) {
        const removedSet = new Set(removeLinkIds);
        await admin.from('private_question_images').delete().in('id', removeLinkIds);
        // 링크 제거 후 이미지가 하나도 남지 않은 문항 = 삭제 대상.
        const remainingByQ = new Map<string, number>();
        for (const r of linkRows ?? []) {
          if (removedSet.has(r.id)) continue;
          remainingByQ.set(
            r.private_question_id,
            (remainingByQ.get(r.private_question_id) ?? 0) + 1,
          );
        }
        const affectedQ = new Set(
          (linkRows ?? []).filter((r) => removedSet.has(r.id)).map((r) => r.private_question_id),
        );
        // 링크가 모두 제거된 문항 중, 발문이 그림을 가리키는 것만 삭제한다.
        // (텍스트만으로 완결된 문항은 살려 요청 수 미달과 보충 생성을 피한다.)
        const stemOf = new Map((slotRows ?? []).map((r) => [r.id, r.stem ?? '']));
        const orphanQ = [...affectedQ]
          .filter((qid) => (remainingByQ.get(qid) ?? 0) === 0)
          .filter((qid) => stemDependsOnImage(stemOf.get(qid) ?? ''));
        if (orphanQ.length > 0) {
          await admin.from('private_questions').delete().in('id', orphanQ);
        }
      }
    } catch (cleanupErr) {
      warnings.push(
        `이미지 재사용 정리 실패 — ${cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)}`,
      );
    }
    };
    await enforceImageReuseCap();

    // ── 부족분 보충: 요청 수를 반드시 채운다.
    // 실제 저장 결과를 DB 에서 다시 읽어(누적 산술이 아니라 사실 기준) 빈 슬롯을 확인하고,
    // 남은 슬롯을 "이미지 없는 텍스트 문항"으로 다시 생성한다. 이미지를 주지 않으므로
    // 인페인팅 탈락·이미지 재사용 정리로 또 삭제되는 일이 없다.
    // 부족 원인: 모델이 요청 수보다 적게 반환 / 이미지 문항 삭제 / 배치 실패.
    const readSaved = async () => {
      const { data } = await admin
        .from('private_questions')
        .select('id, generation_slot')
        .eq('upload_id', uploadRow.id)
        .order('generation_slot', { ascending: true });
      return data ?? [];
    };

    // 이미지별(gi 기준) 현재 문항 연결 수. 보충 배치에 "재사용 상한에 아직 여유가 있는"
    // 이미지만 다시 실기 위해 저장 경로(crops/q_image_{gi}.png)에서 gi 를 역산한다.
    const readImageLinkCounts = async (): Promise<Map<number, number>> => {
      const counts = new Map<number, number>();
      const { data } = await admin
        .from('private_question_images')
        .select('storage_path')
        .eq('upload_id', uploadRow.id);
      for (const r of data ?? []) {
        // `_m`(표식판)도 같은 gi 로 센다 — 아니면 재사용 상한이 두 배로 풀린다.
        const gi = questionImageIndex(r.storage_path ?? '');
        if (gi === null) continue;
        counts.set(gi, (counts.get(gi) ?? 0) + 1);
      }
      return counts;
    };

    /**
     * 보충 배치용 축약 컨텍스트. 빈 슬롯이 원래 속해 있던 구간(= 그 슬롯을 맡았던 배치의
     * 자료 구간)을 중심으로 잘라, 주제 다양성은 유지하면서 입력을 크게 줄인다.
     * 자료가 짧으면 그대로 전체를 쓴다.
     */
    const backfillContext = (slot: number): string => {
      if (compositeText.length <= GEN_BACKFILL_CONTEXT_CHARS) return compositeText;
      // 빈 슬롯을 원래 맡았던 배치와 같은 구간을 준다(본 배치와 동일한 분할 로직 재사용).
      const batchIndex = Math.min(
        batchSizes.length - 1,
        Math.floor((slot / Math.max(1, desiredCount)) * batchSizes.length),
      );
      const segment = segmentForBatch(batchIndex, batchSizes.length);
      return segment.length <= GEN_BACKFILL_CONTEXT_CHARS
        ? segment
        : sliceByChars(segment, 0, 1, GEN_BACKFILL_CONTEXT_CHARS).slice(
            0,
            GEN_BACKFILL_CONTEXT_CHARS,
          );
    };
    // ── 깨진 그림 참조 정리
    // 발문이 "다음은 …모식도이다" 처럼 제시된 그림을 가리키는데 연결된 이미지가 하나도 없으면
    // 학생이 풀 수 없는 문항이다(사용자 신고 사례). 원인은 두 가지다.
    //   ① 모델이 image_indices 를 비운 채 발문에서만 그림을 언급(프롬프트 위반)
    //   ② 이미지가 정제 실패·재사용 상한으로 빠졌는데 발문 판정이 그림 표현을 놓침
    // 배치 내부 검사로는 ①을 잡을 수 없어(연결이 애초에 없으므로) 저장 결과를 훑어 정리한다.
    // 삭제한 슬롯은 바로 아래 보충 단계가 다시 채운다.
    // (함수로 분리: 이미지를 실은 보충 배치도 ①을 만들 수 있어 보충 라운드 뒤에 재실행.)
    const removeBrokenFigureQuestions = async (): Promise<void> => {
    try {
      const [{ data: qRows }, { data: imgRows }] = await Promise.all([
        admin.from('private_questions').select('id, stem').eq('upload_id', uploadRow.id),
        admin
          .from('private_question_images')
          .select('private_question_id')
          .eq('upload_id', uploadRow.id),
      ]);
      const linked = new Set((imgRows ?? []).map((r) => r.private_question_id));
      const brokenIds = (qRows ?? [])
        .filter((r) => !linked.has(r.id) && stemDeclaresFigure(r.stem ?? ''))
        .map((r) => r.id);
      if (brokenIds.length > 0) {
        await admin.from('private_questions').delete().in('id', brokenIds);
        warnings.push(
          `그림을 가리키지만 이미지가 없는 문항 ${brokenIds.length}개 삭제 — 보충 생성으로 대체.`,
        );
        // 보충 라운드 뒤 재실행에서도 누적되게 더한다.
        diag.generation.brokenFigureRefsRemoved =
          ((diag.generation.brokenFigureRefsRemoved as number | undefined) ?? 0) +
          brokenIds.length;
      }
    } catch (e) {
      warnings.push(
        `깨진 그림 참조 정리 실패 — ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    };
    await removeBrokenFigureQuestions();

    const tBackfill = Date.now();
    diag.generation.backfillRounds = [];
    let saved = await readSaved();
    // 진행률 기준도 DB 사실값으로 맞춘다(삭제된 문항까지 세어 100%를 넘기지 않게).
    completedQuestions = saved.length;
    for (let round = 0; round < GEN_BACKFILL_ROUNDS && saved.length < desiredCount; round++) {
      const usedSlots = new Set(saved.map((r) => r.generation_slot));
      const missingSlots = Array.from({ length: desiredCount }, (_, s) => s).filter(
        (s) => !usedSlots.has(s),
      );
      if (missingSlots.length === 0) break;
      warnings.push(
        `보충 생성 ${round + 1}회차: ${saved.length}/${desiredCount} → 부족 ${missingSlots.length}문항 재생성.`,
      );
      const fillBatches: number[][] = [];
      for (let i = 0; i < missingSlots.length; i += GEN_BATCH_MAX_QUESTIONS) {
        fillBatches.push(missingSlots.slice(i, i + GEN_BATCH_MAX_QUESTIONS));
      }
      // 보충 라운드 계측 — 실측에서 1문항 보충에 27.6초가 걸려 총 시간을 지배했다.
      // 어느 단계(모델 호출 vs 재시도 대기)인지 다음 실측에서 갈라 보기 위해 기록한다.
      const tRound = Date.now();
      const roundRec: Record<string, unknown> = {
        round: round + 1,
        missing: missingSlots.length,
        batches: fillBatches.length,
      };
      // 이미지 재투입: 종전 보충은 무조건 텍스트 전용이라, 이미지 문항이 폐기될 때마다
      // 텍스트 문항으로 치환돼 최종 이미지 문항 비율이 떨어졌다. 재사용 상한(장당
      // MAX_QUESTIONS_PER_IMAGE)에 여유가 남은 이미지를 보충 배치에 겹치지 않게 1장씩
      // 나눠 실어 이미지 문항으로 되채운다. 정제(마스킹)는 이미 생성 전에 끝나 캐시에
      // 있으므로 추가 지연이 없다.
      // 배치 슬롯 수 이상 여유가 남은 이미지만 준다 — 모델이 배치의 전 문항에 같은
      // 이미지를 붙여도 상한을 넘지 않아, 사후 정리로 문항을 또 잃는 순환이 안 생긴다.
      let fillFeatured: Array<GenContext['featured']> = fillBatches.map(() => []);
      // 보충에는 "이미 정제에 성공한" 이미지만 쓴다(캐시 히트라 추가 지연이 없고,
      // 정제 실패분을 다시 실어 문항이 또 삭제되는 순환을 막는다).
      const refinedPool = featuredImages.filter((fi) => refinedUsableGis.has(fi.gi));
      if (useImages && refinedPool.length > 0) {
        try {
          const linkCounts = await readImageLinkCounts();
          const pool = refinedPool
            .map((fi) => ({
              fi,
              remaining: MAX_QUESTIONS_PER_IMAGE - (linkCounts.get(fi.gi) ?? 0),
            }))
            .filter((x) => x.remaining > 0)
            .sort((a, b) => b.remaining - a.remaining);
          fillFeatured = fillBatches.map((slots) => {
            const pickIdx = pool.findIndex((x) => x.remaining >= slots.length);
            if (pickIdx < 0) return [];
            return [pool.splice(pickIdx, 1)[0].fi];
          });
        } catch (e) {
          warnings.push(
            `보충 이미지 배정 실패 — 텍스트 전용으로 진행. ${e instanceof Error ? e.message : String(e)}`,
          );
          fillFeatured = fillBatches.map(() => []);
        }
      }
      const imagesOffered = fillFeatured.reduce((n, f) => n + f.length, 0);
      roundRec.imagesOffered = imagesOffered;
      await mapWithConcurrency(fillBatches, GEN_CONCURRENCY, async (slots, i) => {
        try {
          await generateAndPersistBatch(i, slots, fillBatches.length, {
            // 보충은 "빠르게 빈 칸만 채우는" 호출이다. 본 배치들이 방금 끝난 직후라
            // 같은 대용량 컨텍스트를 다시 실으면 입력 처리량이 커져 429 를 맞고,
            // 기본 백오프(최대 45초)를 기다리며 전체 소요를 지배한다(실측 66초 꼬리).
            // → 빈 슬롯이 속한 구간의 컨텍스트만 잘라 싣고, 재시도 대기도 짧게 잡는다.
            contextText: backfillContext(slots[0]),
            featured: [],
            resolveFeatured: () => resolveRefined(fillFeatured[i]),
            imageQuotaFor,
            getDisplayPng, // 정제 캐시가 이미 채워져 있어 재호출 비용 없음
            // 보충은 "빈 칸 한두 개"라 오래 기다릴 이유가 없다. 실측에서 1문항 보충이
            // 27.6초를 써 총 시간을 지배했으므로 대기 상한을 더 조인다.
            retryMaxDelayMs: 3_000,
            // 보충 문항도 사용자가 고른 유형을 지켜야 한다. 빼먹으면 폐기가 일어날 때마다
            // 임상형이 지식형으로 조용히 치환된다(이미지 재투입을 넣은 것과 같은 이유).
            clinicalQuota: clinicalQuotaFor(slots.length),
            knowledgeQuota: knowledgeQuotaFor(slots.length),
            knowledgeAskKinds: knowledgeAskPlan(batchSizes.length + round, slots.length),
            allowNegativeAsk: false,
          });
        } catch (e) {
          warnings.push(
            `보충 배치 실패 — ${e instanceof Error ? e.message : String(e)}`,
          );
        }
        return null;
      });
      // 이미지를 실은 보충이 만들 수 있는 초과 연결·깨진 그림 참조를 라운드 안에서
      // 정리한다 — 정리로 생긴 빈 슬롯은 다음 라운드가 다시 채운다.
      if (imagesOffered > 0) {
        await enforceImageReuseCap();
        await removeBrokenFigureQuestions();
      }
      const beforeCount = saved.length;
      saved = await readSaved();
      roundRec.ms = Date.now() - tRound;
      roundRec.filled = saved.length - beforeCount;
      (diag.generation.backfillRounds as unknown[] | undefined)?.push(roundRec);
    }
    if (saved.length < desiredCount) {
      warnings.push(`최종 ${saved.length}/${desiredCount}문항 — 요청 수를 채우지 못했습니다.`);
    }
    diag.timings.backfillMs = Date.now() - tBackfill;
    const generatedCount = saved.length;
    const insertedIds = saved.map((r) => r.id);
    completedQuestions = generatedCount;
    const contentSummary = batchResults.map((result) => result.contentSummary).find(Boolean) ?? '';
    const cacheReadTokens = batchResults.reduce((sum, result) => sum + result.cacheReadTokens, 0);
    const cacheCreationTokens = batchResults.reduce(
      (sum, result) => sum + result.cacheCreationTokens,
      0,
    );

    // ── 사용자 알림(P8). 완료 시점의 사실에서 조립한다 — warnings 문자열은 리팩터마다
    // 바뀌므로 태그를 달면 조용히 사라진다. 의학 검증 플래그는 넣지 않는다(warn 모드의
    // 오탐이 멀쩡한 문항까지 의심하게 만든다 — 사람 검토로 오탐률을 낮춘 뒤 재검토).
    const notices = buildUploadNotices({
      desiredCount,
      savedCount: generatedCount,
      wantsImages,
      featuredImageCount: refinedUsableGis.size,
      truncatedChars: Number(diag.extract.textTruncated ?? 0),
      referenceSkipped: referenceSkippedCount,
      batchFailureReasons,
      leakageDiscarded: Number(diag.generation.leakageDiscarded ?? 0),
      verifyRejected: Number(diag.generation.verifyRejected ?? 0),
      blindDiscarded: Number(diag.generation.blindDiscarded ?? 0),
    });
    diag.generation.notices = notices;

    const titleTrim = input.title?.trim();
    await admin
      .from('user_uploads')
      .update({
        status: 'completed',
        processing_stage: 'completed',
        progress_current: generatedCount,
        progress_total: desiredCount,
        completed_question_count: generatedCount,
        target_question_count: desiredCount,
        heartbeat_at: new Date().toISOString(),
        processed_at: new Date().toISOString(),
        extracted_text: contentSummary.slice(0, 2000),
        error_message: null,
        // 00040 미적용 환경에서도 생성이 죽지 않게 컬럼이 있을 때만 싣는다
        // (계측 컬럼과 같은 폴백 원칙 — 알림 하나 때문에 완료 처리가 거절되면 안 된다).
        ...(uploadNoticeColumnSupported ? { notice: notices } : {}),
        // 사용자가 지정한 문제집 이름이 있으면 세트 표시명으로 저장.
        ...(titleTrim ? { file_name: titleTrim } : {}),
      })
      .eq('id', upload.id)
      .then(async (res) => {
        // notice 컬럼이 없으면 PGRST204 — 알림만 빼고 한 번 더 쓴다.
        if (res.error && isMissingColumnError(res.error) && uploadNoticeColumnSupported) {
          uploadNoticeColumnSupported = false;
          warnings.push('알림 컬럼이 없어 알림 없이 완료 처리(마이그레이션 00040 미적용).');
          await admin
            .from('user_uploads')
            .update({
              status: 'completed',
              processing_stage: 'completed',
              progress_current: generatedCount,
              progress_total: desiredCount,
              completed_question_count: generatedCount,
              target_question_count: desiredCount,
              heartbeat_at: new Date().toISOString(),
              processed_at: new Date().toISOString(),
              extracted_text: contentSummary.slice(0, 2000),
              error_message: null,
              ...(titleTrim ? { file_name: titleTrim } : {}),
            })
            .eq('id', upload.id);
        }
        return res;
      });

    await writeDiagnostics();

    if (warnings.length > 0) {
      // 업로드 자체는 private 자료라 본문은 남기지 말고 메타만 기록.
      console.warn(
        `[private-gen] uploadId=${upload.id} warnings=${warnings.length}`,
      );
    }

    return {
      generatedCount,
      privateQuestionIds: insertedIds,
      contentSummary,
      unmatched,
      usage: {
        model: modelUsed,
        inputTokens: aggInputTokens,
        outputTokens: aggOutputTokens,
        cacheReadTokens,
        cacheCreationTokens,
        costUSD: totalCost,
        durationMs: Date.now() - startTime,
      },
      extractStats: {
        pages: slides.length,
        croppedImages: totalCropped,
        ocrChars,
      },
    };
  } catch (error) {
    await admin
      .from('user_uploads')
      .update({
        status: 'failed',
        processing_stage: 'failed',
        heartbeat_at: new Date().toISOString(),
        error_message: sanitizeErrorMessage(error),
      })
      .eq('id', upload.id);
    // 실패 원인 분석을 위해 진단도 남긴다(생성 전 단계에서 죽은 경우 diag 가 없을 수 있어 방어).
    try {
      await writeDiagnostics?.();
    } catch {
      /* 무시 */
    }
    throw error;
  } finally {
    clearInterval(heartbeatTimer);
  }
}
