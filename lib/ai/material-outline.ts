/**
 * 자료에서 "출제 초점" 목록을 뽑고 배치에 나눠 준다 (P11 · 세션 내 중복 방지). 순수 함수만 둔다.
 *
 * 왜 필요한가 (2026-08-19 실측)
 * ──────────────────────────
 * 한 번의 생성 안에서 **임상형 5문항 중 4문항이 같은 증례**로 나왔다
 * ("65세 남자가 갑작스러운 등 통증…"). 배치는 서로 병렬·독립이라 다른 배치가 무엇을
 * 만들었는지 못 본다. 자료가 커서 구간 분할이 걸리면 물리적으로 갈라지지만, 강의록 1강은
 * 대개 분할 하한(GEN_SEGMENT_ENABLE_MIN_CHARS)에 못 미쳐 **모든 배치가 같은 전체 텍스트**를
 * 받는다. 그러고는 "N번째 구간을 우선 출제하라"는 말만 듣는데, 같은 텍스트를 받은
 * 모델들이 각자 고른 "N번째 구간"은 서로 다르지 않다 — 다들 가장 눈에 띄는 증례를 고른다.
 *
 * 그래서 코드가 **초점을 배정**한다. 자료에서 소제목·슬라이드 제목을 뽑아 배치마다
 * 겹치지 않게 나눠 주고, 다른 배치가 무엇을 맡았는지도 함께 알려 준다(피하라고 말하려면
 * 무엇을 피해야 하는지 알아야 한다).
 *
 * 초점을 못 뽑으면 어떻게 하나
 * ─────────────────────────
 * 표지 한 장 + 본문 한 덩어리처럼 제목이 없는 자료가 있다. 그때는 빈 배열을 돌려주고
 * 호출부가 종전 지시("N번째 구간 우선")를 그대로 쓴다. 근거 없이 지어낸 초점을 주면
 * 자료에 없는 주제로 출제하라는 지시가 되어 더 나쁘다. 근본 해결은 R1(자료 분석 → 출제 계획).
 */

/** 초점 후보로 인정하는 줄 길이(자). 너무 짧으면 라벨, 너무 길면 본문이다. */
const MIN_TOPIC_CHARS = 2;
const MAX_TOPIC_CHARS = 40;

/**
 * 제목이 아닌 것이 확실한 줄. 슬라이드 첫 줄이 늘 제목은 아니라서 걸러야 한다.
 * (한글에 \b 는 경계가 없으므로 쓰지 않는다 — "그림 1" 같은 문자열에서 오작동한다.)
 */
const NOT_A_TOPIC = [
  /^목\s*차$/,
  /^감사합니다/,
  /^참고\s*문헌/,
  /^references?$/i,
  /^outline$/i,
  /^contents?$/i,
  /^introduction$/i,
  /^summary$/i,
  /^질문/,
  /^[0-9\s.\-–—()]+$/, // 번호·쪽수만 있는 줄
  /^\[[^\]]*\]$/, // [이미지] 같은 라벨만 있는 줄
  // 파이프라인이 붙이는 구조 라벨. 폴백 스캔이 이걸 제목으로 집어 "슬라이드 3 (이미지 0장)"
  // 같은 초점을 배정하던 결함을 막는다 — 초점이 아니라 자료의 골격 표시다.
  /^슬라이드\s*\d+/,
  /^이미지\s*\(OCR\)/,
  /^텍스트$/,
];

/** 문장으로 끝나면 제목이 아니라 본문이다. */
const SENTENCE_ENDING = /(다|요|음|까|죠)[.!?]?$|[.!?]$/;

function normalizeLine(raw: string): string {
  return raw
    .replace(/^#+\s*/, '')
    .replace(/^텍스트:\s*/, '')
    .replace(/^[-•·▪◦‣*]\s*/, '')
    .replace(/^\d+[.)]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTopicLike(line: string): boolean {
  if (line.length < MIN_TOPIC_CHARS || line.length > MAX_TOPIC_CHARS) return false;
  if (NOT_A_TOPIC.some((re) => re.test(line))) return false;
  if (SENTENCE_ENDING.test(line)) return false;
  // 한글이나 영문 글자가 하나도 없으면 제목으로 볼 수 없다.
  return /[가-힣A-Za-z]/.test(line);
}

/**
 * 출제 근거 텍스트에서 초점 후보(소제목·슬라이드 제목)를 뽑는다.
 *
 * 슬라이드 블록(`## 슬라이드 N …`)이 있으면 각 블록의 **첫 내용 줄**을 그 슬라이드의
 * 제목으로 본다(파이프라인이 만드는 형식이다). 블록이 없으면 짧고 문장이 아닌 줄을
 * 훑는다 — PDF 본문에서 소제목은 대개 그렇게 생겼다.
 */
export function extractFocusTopics(
  text: string,
  options: { max?: number } = {},
): string[] {
  const max = options.max ?? 24;
  const src = String(text ?? '');
  if (!src.trim()) return [];

  const found: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const line = normalizeLine(raw);
    if (!isTopicLike(line)) return;
    const key = line.replace(/\s/g, '').toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push(line);
  };

  const blocks = src.split(/\n(?=## )/);
  const hasSlideBlocks = blocks.length > 1 && /^## /.test(blocks[0].trimStart());
  if (hasSlideBlocks) {
    for (const block of blocks) {
      const lines = block.split('\n').slice(1); // 헤더(## 슬라이드 N) 제외
      for (const line of lines) {
        const normalized = normalizeLine(line);
        if (!normalized) continue;
        push(line);
        break; // 블록당 첫 내용 줄 하나만 — 본문까지 훑으면 초점이 아니라 목록이 된다.
      }
      if (found.length >= max) break;
    }
  }

  // 슬라이드 구조가 있으면 "슬라이드당 제목 하나"가 올바른 알갱이다. 여기서 본문까지
  // 훑으면 초점이 아니라 아무 짧은 줄의 목록이 된다(강조 문구·표 머리글이 섞인다).
  // 구조가 없을 때(텍스트 PDF)만 짧고 문장이 아닌 줄을 소제목으로 본다.
  if (found.length === 0) {
    for (const line of src.split('\n')) {
      push(line);
      if (found.length >= max) break;
    }
  }

  return found.slice(0, max);
}

export interface FocusAssignment {
  /** 이 배치가 맡은 초점. 비어 있으면 초점 지시를 하지 않는다. */
  mine: string[];
  /** 다른 배치가 맡은 초점(피할 대상). 프롬프트가 길어지지 않게 잘라서 준다. */
  others: string[];
}

/**
 * 초점 목록을 배치에 겹치지 않게 나눈다(문서 순서대로 연속 배분).
 *
 * 배치보다 초점이 적으면 **아무에게도 배정하지 않는다** — 일부 배치만 초점을 받으면
 * 나머지 배치가 그 초점까지 포함한 전체에서 자유롭게 골라 같은 증례를 또 만든다.
 * (초점 배정의 목적은 "겹치지 않게"이지 "일부를 좁히기"가 아니다.)
 */
export function assignFocus(
  topics: readonly string[],
  batchIndex: number,
  batchCount: number,
  options: { maxOthers?: number } = {},
): FocusAssignment {
  const maxOthers = options.maxOthers ?? 8;
  if (batchCount <= 1 || topics.length < batchCount) return { mine: [], others: [] };

  const per = Math.floor(topics.length / batchCount);
  const remainder = topics.length % batchCount;
  // 앞쪽 배치가 나머지를 하나씩 더 가져간다 — 경계가 결정론적이어야 재실행이 같은 배정을 준다.
  const start = batchIndex * per + Math.min(batchIndex, remainder);
  const size = per + (batchIndex < remainder ? 1 : 0);
  const mine = topics.slice(start, start + size);
  const others = topics.filter((_, i) => i < start || i >= start + size).slice(0, maxOthers);
  return { mine, others };
}

/**
 * 배치 지시문에 붙일 초점 문단. 배정이 비어 있으면 빈 문자열(종전 지시를 그대로 쓴다).
 *
 * "피할 것"을 함께 적는 이유: 맡은 것만 알려 주면 모델은 그것을 **추가로** 다룰 뿐
 * 나머지를 그만두지 않는다. 실제로 배치들이 같은 증례를 만든 것도 "우선하라"는 말만
 * 들었기 때문이다(P7 에서 확인된 것과 같은 실패 — 우선순위는 배제가 아니다).
 */
export function buildFocusDirective(assignment: FocusAssignment): string {
  if (assignment.mine.length === 0) return '';
  const lines = [
    '',
    '',
    '## 이번 묶음이 맡은 내용',
    `- 이번 묶음은 다음 주제에서만 출제한다: ${assignment.mine.join(' / ')}`,
  ];
  if (assignment.others.length > 0) {
    lines.push(
      `- 다음 주제는 **다른 묶음이 맡았으므로 출제하지 않는다**: ${assignment.others.join(' / ')}`,
    );
  }
  lines.push(
    '- 임상 증례를 만들 때 **증례의 주 증상·질환은 맡은 주제에서 고른다.** 다른 묶음과 같은 환자·같은 주 증상으로 시작하지 않는다.',
  );
  return lines.join('\n');
}

/** 세션 간 중복 방지에 쓸 이전 발문 수. 프롬프트 길이와 효과의 절충. */
export const PRIOR_STEM_LIMIT = 30;
/** 발문은 앞부분만 준다 — 전문을 실으면 그 문항을 그대로 베낄 근거가 된다. */
export const PRIOR_STEM_CHARS = 60;

/**
 * 같은 자료를 다시 올렸을 때 붙일 "이미 출제된 문항" 문단 (P11 · 세션 간).
 *
 * 운영 전체에서 발문이 **완전히 동일한** 문항이 37건 있었다 — 같은 파일을 다시 올린
 * 결과다. 임베딩 유사도로 막을 수도 있지만 Voyage 임베딩이 2026-07-21 이후 죽어 있어
 * 그 경로는 지금 존재하지 않는다. 발문 앞부분을 그대로 보여 주고 피하게 하는 편이
 * 의존이 없고 즉시 동작한다.
 *
 * 발문 **전문**이 아니라 앞 60자만 주는 이유: 전문을 주면 "피하라"가 아니라
 * "이렇게 쓰라"는 예시로 읽힐 위험이 있다(few-shot 이 지시를 이긴 사례가 이미 두 번 있었다).
 */
export function buildPriorStemsDirective(stems: readonly string[]): string {
  const cleaned = stems
    .map((s) => String(s ?? '').replace(/\s+/g, ' ').trim())
    .filter((s) => s.length > 0)
    .slice(0, PRIOR_STEM_LIMIT)
    .map((s) => (s.length > PRIOR_STEM_CHARS ? `${s.slice(0, PRIOR_STEM_CHARS)}…` : s));
  if (cleaned.length === 0) return '';
  return [
    '',
    '',
    '## 이미 출제된 문항 (같은 자료로 만든 것 — 발문 앞부분만)',
    ...cleaned.map((s) => `- ${s}`),
    '',
    '위 문항과 **같은 것을 묻지 않는다.** 같은 발문, 같은 증례, 같은 정답 조합을 다시 만들지 말고,',
    '자료에서 아직 다루지 않은 내용으로 출제한다.',
  ].join('\n');
}
