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
 *      F08/F14 영문 약어 잔존, F12 발문 형태, F13 선지 수, F16 종결형 혼용,
 *      F17 오답 성립성, F17-L 정답 길이 누출
 *
 * 근거: 국시원 공개 기출(제90회) 55문항 정독 + 임종평 164문항 실측.
 *
 * F17 계열이 나중에 추가된 이유(2026-08-16 운영 DB 전수 실측):
 *   active 1,318문항에서 정답이 1번인 비율 52.3 %, 정답이 '가장 긴 선지'인 비율
 *   57.2 % 였다(균등 기대는 각각 20 %). AI 생성분 1,073문항만 보면 59.9 % / 62.2 %.
 *   의학 지식 없이 "제일 긴 선지"만 찍어도 60 % 가까이 맞는 상태였다.
 *   실제로 마르판 증후군 문항의 선지는 [운동 / 항생제 / 혈압 방치 / 흡연 지속 /
 *   정기 대동맥 영상 추적]이었다 — 정답만 유일하게 의료행위이고 유일하게 길다.
 *   F17 은 프롬프트에 있었지만 코드로 검사하지 않아 아무도 막지 못했다.
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

/**
 * F17 — 오답으로 성립하지 않는 선지.
 *
 * 여기 걸리는 선지는 의학을 몰라도 소거된다. 하나라도 있으면 그 문항은 5지선다가
 * 아니라 사실상 4지 이하가 되고, 남은 선지 중 유일하게 '제대로 된 처치'가 정답이
 * 되어 버린다.
 */
const IMPLAUSIBLE_CHOICE_PATTERNS: Array<[RegExp, string]> = [
  [/방치/, '"방치"는 의료행위가 아니다 — 실제로 고려될 수 있는 처치로 바꾼다'],
  [
    /(흡연|음주|비만|고혈압|약물)\s*(지속|유지|계속)/,
    '위해행위를 지속하는 선지는 상식만으로 소거된다',
  ],
  [/하지\s*않(는다|고|음)/, '"~하지 않는다" 형태의 태도 부정문은 상식만으로 소거된다'],
  [/(절대|전혀)\s*\S*\s*없다/, '단정 부정문("절대 ~ 없다")은 오답 선지로 쓰지 않는다'],
  [/불가능하다/, '단정 부정문("~는 불가능하다")은 오답 선지로 쓰지 않는다'],
  [/무관하다/, '단정 부정문("~와 무관하다")은 오답 선지로 쓰지 않는다'],
  [/폐기한다/, '검체·기록을 폐기하는 선지는 의료행위로 성립하지 않는다'],
  [/^(아무것도|치료하지)/, '처치를 하지 않는다는 선지는 상식만으로 소거된다'],
];

/**
 * F17-L — 정답만 유독 긴 '길이 누출'.
 *
 * F15 가 선지를 길이 오름차순으로 세우므로, 정답만 길게 쓰면 정답은 언제나 마지막
 * 칸에 온다. 즉 길이 편중은 그 자체로 정답 위치까지 알려준다. 두 조건을 함께 보는
 * 이유는 짧은 선지들끼리는 1~2자 차이로도 배율이 커지기 때문이다.
 */
const ANSWER_LENGTH_RATIO = 1.6;
const ANSWER_LENGTH_MARGIN = 4;

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

  issues.push(...lintChoiceLeakage(question));

  return issues;
}

/**
 * F17 계열 — 정답이 지식 없이 드러나는지 본다.
 *
 * lintKmleQuestion() 안에서 호출되지만, 기존 문항 감사처럼 형식 위반과 분리해
 * 정답 누출만 세고 싶을 때가 있어 따로 내보낸다.
 */
export function lintChoiceLeakage(question: KmleQuestionShape): KmleLintIssue[] {
  const issues: KmleLintIssue[] = [];
  const choices = (Array.isArray(question.choices) ? question.choices : []).map((c) =>
    String(c ?? '').trim(),
  );
  if (choices.length < 2) return issues;

  // F17 — 오답으로 성립하지 않는 선지
  for (const [pattern, message] of IMPLAUSIBLE_CHOICE_PATTERNS) {
    const hits = choices.filter((c) => pattern.test(c));
    if (hits.length > 0) {
      issues.push({ rule: 'F17', message: `${message} (해당 선지: ${hits.join(', ')})` });
    }
  }

  const lengths = choices.map((c) => c.length);

  // F17-L — 정답만 유독 긴 길이 누출
  //
  // '선지 길이 산포' 자체는 규칙으로 삼지 않는다. 운영 1,318문항에 적용해 보니
  // [천식 / 만성폐쇄성폐질환 / 폐색전증 / 심부전 / 기관지확장증] 처럼 병명 길이가
  // 자연히 갈리는 정상 진단 문항이 대량으로 걸렸다(2자 vs 8자). 한국어 병명은 길이가
  // 제각각이라 산포만으로는 누출을 못 가른다.
  //
  // 실제로 답을 알려주는 것은 **정답이 길이 극단에 홀로 서 있는 경우**다. 시험 요령에서
  // '가장 긴 선지를 고르라'가 통하는 이유가 그것이고, 운영 풀에서 정답이 최장인 비율이
  // 57 % 였던 것도 그것이다. 그래서 정답 기준 상대 길이만 본다.
  const answerIndex = question.answer_index;
  if (Number.isInteger(answerIndex) && answerIndex >= 0 && answerIndex < choices.length) {
    const answerLen = lengths[answerIndex];
    const maxOther = Math.max(...lengths.filter((_, i) => i !== answerIndex));
    if (answerLen > maxOther * ANSWER_LENGTH_RATIO && answerLen - maxOther >= ANSWER_LENGTH_MARGIN) {
      issues.push({
        rule: 'F17-L',
        message: `정답 선지(${answerLen}자)가 나머지 최장 선지(${maxOther}자)보다 유독 길다 — 길이만으로 정답이 드러난다`,
      });
    }
  }

  return issues;
}

/**
 * 순서가 의미를 갖는 라벨형 선지 묶음인지 — 조합형("ㄱ", "ㄱ, ㄴ", "ㄱ, ㄴ, ㄷ"), 표식 라벨
 * ("A"~"E"), 원문자("①"~"⑤"). 이런 선지는 관례 순서로 놓여야 자연스러우므로 섞지 않는다.
 */
export function isOrderedLabelChoiceSet(choices: string[]): boolean {
  if (choices.length === 0) return false;
  const combo = /^[ㄱ-ㅎ](\s*,\s*[ㄱ-ㅎ])*$/;
  const letter = /^[A-Ea-e]$/;
  const circled = /^[①-⑤]$/;
  return (
    choices.every((c) => combo.test(c.trim())) ||
    choices.every((c) => letter.test(c.trim())) ||
    choices.every((c) => circled.test(c.trim()))
  );
}

/**
 * 정답 위치를 코드에서 균등하게 섞는다(Fisher–Yates) — 결정론적 후처리.
 *
 * 내신대비 운영 987문항 실측(2026-08-18): 정답이 3번인 비율 30.7 %, 1번 9.9 %(균등 기대 20 %).
 * 모델에게 "골고루 배치하라"고 시키는 것은 확률적 방어라 저장 직전에 코드로 섞는다.
 * 정답 텍스트를 따라가 answer_index 를 다시 계산하므로 채점은 흔들리지 않는다.
 * 라벨형 선지(조합형·A~E·원문자)는 관례 순서를 유지한다.
 */
export function shuffleChoices(
  choices: string[],
  answerIndex: number,
  random: () => number = Math.random,
): { choices: string[]; answerIndex: number } {
  if (isOrderedLabelChoiceSet(choices)) return { choices, answerIndex };
  if (!Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= choices.length) {
    return { choices, answerIndex };
  }
  const answerText = choices[answerIndex];
  const shuffled = [...choices];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  const nextIndex = shuffled.indexOf(answerText);
  // 같은 배열을 섞었으므로 못 찾을 일은 없지만, 방어적으로 원본을 돌려준다.
  if (nextIndex < 0) return { choices, answerIndex };
  return { choices: shuffled, answerIndex: nextIndex };
}
