/**
 * 국시형 문항 형식 후처리·검사
 *
 * 생성 프롬프트(lib/ai/prompts/generation.ts)의 F01~F17 중 일부는 결정론적으로
 * 판정할 수 있다. 그런 규칙은 모델의 준수에만 맡기지 않고 여기서 한 번 더 교정하거나
 * 검사한다.
 *
 *  - normalizeKmleQuestion(): 안전하게 자동 교정 가능한 것만 고친다.
 *      F15 선지 길이 오름차순 정렬 + answer_index 재계산
 *      F16 명사구 선지의 불필요한 마침표 제거
 *    특히 F15 는 정렬 후 answer_index 를 다시 계산하지 않으면 정답이 조용히
 *    틀어지는 사고로 이어진다. 화면상으로는 멀쩡해 보이고 채점만 잘못되므로
 *    사람 눈으로 잡기 어렵다. 그래서 코드로 강제한다.
 *
 *  - lintKmleQuestion(): 자동 교정이 위험한 것은 고치지 않고 지적만 한다.
 *      F01 금지 표현, F05 활력징후 서식, F06 검사 블록 도입문,
 *      F08/F14 영문 약어 잔존, F12 발문 형태, F13 선지 수, F16 종결형 혼용
 *
 * 근거: 국시원 공개 기출(제90회) 55문항 정독 + 임종평 164문항 실측.
 */

export interface KmleQuestionShape {
  stem: string;
  choices: string[];
  answer_index: number;
}

export interface KmleLintIssue {
  rule: string;
  message: string;
}

/** 선지가 문장형(~다.)인지. 문장형이면 마침표를 유지한다. */
function isSentenceChoice(text: string): boolean {
  return /다\.?$/.test(text.trim());
}

/**
 * 안전하게 자동 교정 가능한 형식만 고친다.
 *
 * 선지 문자열이 서로 같아도 안전하도록 값이 아니라 원래 인덱스를 추적한다.
 * answer_index 가 범위를 벗어나면 손대지 않고 그대로 돌려준다.
 */
export function normalizeKmleQuestion<T extends KmleQuestionShape>(question: T): T {
  const { choices, answer_index } = question;

  if (!Array.isArray(choices) || choices.length === 0) return question;
  if (!Number.isInteger(answer_index)) return question;
  if (answer_index < 0 || answer_index >= choices.length) return question;

  // F16 — 명사구 선지의 마침표 제거. 문장형(~다.)은 그대로 둔다.
  const trimmed = choices.map((c) => {
    const t = String(c).trim();
    return t.endsWith('.') && !isSentenceChoice(t) ? t.slice(0, -1).trim() : t;
  });

  // F15 — 길이 오름차순 정렬. 같은 길이는 원래 순서를 유지(안정 정렬).
  const indexed = trimmed.map((text, originalIndex) => ({ text, originalIndex }));
  indexed.sort(
    (a, b) => a.text.length - b.text.length || a.originalIndex - b.originalIndex,
  );

  const nextAnswerIndex = indexed.findIndex((x) => x.originalIndex === answer_index);
  // 이론상 -1 이 나올 수 없지만, 나오면 정답이 유실되므로 원본을 유지한다.
  if (nextAnswerIndex < 0) return question;

  return {
    ...question,
    stem: String(question.stem).trim(),
    choices: indexed.map((x) => x.text),
    answer_index: nextAnswerIndex,
  };
}

/** F01 — 지문에 쓰면 안 되는 표현. 뒤에 한글이 붙는 복합어(남성호르몬 등)는 제외. */
const FORBIDDEN_STEM_PATTERNS: Array<[RegExp, string]> = [
  [/(?<![가-힣])남성(?![가-힣])/, '"남성" 대신 "남자"를 쓴다'],
  [/(?<![가-힣])여성(?![가-힣])/, '"여성" 대신 "여자"를 쓴다'],
  [/내원(하였|했)다/, '"내원하였다" 대신 "병원에 왔다"를 쓴다'],
  [/방문(하였|했)다/, '"방문하였다" 대신 "병원에 왔다"를 쓴다'],
];

/**
 * F08·F14 — 한글 표준용어로 바꿔야 하는 영문 표기.
 *
 * 병기가 허용된 것(CA 19-9, IgG, INR, T3/T4, BI-RADS, 핵형)과 단위(mmHg, mg/dL,
 * meq/L)는 넣지 않는다. 대소문자를 구분하지 않고 찾으므로 약어와 소문자 영문
 * 검사명을 함께 잡는다.
 */
const FORBIDDEN_ABBREVIATIONS = [
  // 약어
  'AST', 'ALT', 'ALP', 'CRP', 'BUN', 'WBC', 'RBC', 'ESR', 'LDH', 'TSH',
  'BNP', 'eGFR', 'HbA1c', 'UTI', 'COPD', 'DKA', 'RTA', 'CKD', 'AKI', 'CHF',
  // 소문자로 자주 남는 영문 검사명
  'nitrite', 'glucose', 'albumin', 'amylase', 'lipase', 'bilirubin',
  'creatinine', 'hemoglobin', 'sodium', 'potassium', 'chloride', 'ketone',
];

/** F12 — 발문에 쓰면 안 되는 표현. */
const FORBIDDEN_ASK_PATTERNS: Array<[RegExp, string]> = [
  [/가장/, '"가장 적절한" 같은 표현을 쓰지 않는다'],
  [/다음 중/, '"다음 중"을 쓰지 않는다'],
  [/무엇인가/, '"~은 무엇인가?" 대신 "진단은?" 형태로 쓴다'],
  [/접근은\s*\?/, '"접근은?"은 국시에 없는 발문이다'],
  [/원칙은\s*\?/, '"평가 원칙은?"은 국시에 없는 발문이다'],
  [/단계는\s*\?/, '"다음 단계는?" 대신 "처치는?" "검사는?"을 쓴다'],
];

/** 지문 마지막 물음표 문장(발문)만 잘라낸다. */
function extractAsk(stem: string): string {
  const flat = stem.replace(/\s+/g, ' ').trim();
  const match = flat.match(/[^.?!]*\?\s*$/);
  return (match ? match[0] : flat.slice(-40)).trim();
}

/**
 * 자동 교정이 위험한 형식 위반을 찾아낸다. 고치지 않고 목록만 돌려준다.
 * 빈 배열이면 검사한 범위에서는 국시 형식에 맞는다.
 */
export function lintKmleQuestion(question: KmleQuestionShape): KmleLintIssue[] {
  const issues: KmleLintIssue[] = [];
  const stem = String(question.stem ?? '');
  const choices = Array.isArray(question.choices) ? question.choices : [];

  // F01 — 금지 표현
  for (const [pattern, message] of FORBIDDEN_STEM_PATTERNS) {
    if (pattern.test(stem)) issues.push({ rule: 'F01', message });
  }

  // F05 — 활력징후 서식
  if (/활력징후\s*:/.test(stem)) {
    issues.push({ rule: 'F05', message: '"활력징후:" 라벨 없이 문장으로 쓴다' });
  }
  if (/혈압\s*\d+\/\d+/.test(stem)) {
    const order = ['혈압', '맥박', '호흡', '체온']
      .map((k) => stem.indexOf(k))
      .filter((i) => i >= 0);
    const ascending = order.every((v, i) => i === 0 || order[i - 1] < v);
    if (order.length === 4 && !ascending) {
      issues.push({ rule: 'F05', message: '활력징후는 혈압→맥박→호흡→체온 순서로 쓴다' });
    }
    // mmHg·℃ 는 숫자와 띄어 쓴다. 반면 "맥박 72회/분"의 "회/분"은 붙여 쓰므로 제외한다.
    if (/\d(mmHg|℃)/.test(stem)) {
      issues.push({ rule: 'F05', message: 'mmHg·℃ 는 숫자와 한 칸 띄어 쓴다' });
    }
    if (/bpm/i.test(stem)) {
      issues.push({ rule: 'F05', message: '맥박 단위는 bpm 이 아니라 "회/분"이다' });
    }
  }

  // F06 — 검사 블록에 도입문이 없음
  if (stem.includes('\n') && !/결과는 다음과 같다/.test(stem)) {
    issues.push({
      rule: 'F06',
      message: '검사 블록 앞에 "검사 결과는 다음과 같다."를 둔다',
    });
  }

  // F08·F14 — 영문 약어 잔존
  const haystack = [stem, ...choices].join(' ');
  const found = FORBIDDEN_ABBREVIATIONS.filter((abbr) =>
    new RegExp(`(^|[^A-Za-z])${abbr}([^A-Za-z]|$)`, 'i').test(haystack),
  );
  if (found.length > 0) {
    issues.push({
      rule: 'F08',
      message: `영문 약어를 한글 표준용어로 바꾼다: ${found.join(', ')}`,
    });
  }

  // F12 — 발문 형태
  const ask = extractAsk(stem);
  if (!/\?\s*$/.test(stem.trim())) {
    issues.push({ rule: 'F12', message: '지문이 발문(물음표)으로 끝나야 한다' });
  }
  for (const [pattern, message] of FORBIDDEN_ASK_PATTERNS) {
    if (pattern.test(ask)) issues.push({ rule: 'F12', message });
  }

  // F13 — 선지 수
  if (choices.length !== 5) {
    issues.push({ rule: 'F13', message: `선지는 정확히 5개여야 한다 (현재 ${choices.length}개)` });
  }

  // F16 — 종결형 혼용
  if (choices.length > 0) {
    const sentenceCount = choices.filter((c) => isSentenceChoice(String(c))).length;
    if (sentenceCount > 0 && sentenceCount < choices.length) {
      issues.push({
        rule: 'F16',
        message: '한 문항 안에서 명사구 선지와 문장형 선지를 섞지 않는다',
      });
    }
  }

  return issues;
}
