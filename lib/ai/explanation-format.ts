/**
 * 해설 규격 (P12) — 어미 통일·분량 계측·오답 언급 검사. 순수 함수만 둔다.
 *
 * 왜 필요한가 (2026-08-18 감사 · 2026-08-19 실측)
 * ──────────────────────────────────────────
 *  - 프롬프트는 "350자 이내"라고 적어 두었는데 운영 최대 4,191자, 실측 10문항 중 2문항이
 *    424·441자였다. 지시만으로는 안 지켜진다.
 *  - 존댓말 147문장 vs 평서 634문장이 **한 세트 안에서** 섞였다. 배치가 병렬·독립이라
 *    묶음마다 톤이 달라진다. 한 화면에 두 톤이 나오면 학생은 그것부터 본다.
 *  - 해설이 오답 사유를 아예 안 다루는 실물이 있었다(정답만 설명하고 끝).
 *
 * 왜 코드가 어미를 고치는가 — 그리고 왜 "전부 아니면 전무"인가
 * ────────────────────────────────────────────────────────
 * 톤은 의미가 아니라 형태라서 결정론적으로 고칠 수 있다. 다만 **부분 변환은 원본보다
 * 나쁘다** — "…있다. …보입니다." 처럼 한 해설 안에서 톤이 갈리면 통일 안 한 것만 못하다.
 * 그래서 이 모듈은 존댓말 어미를 **전부 변환할 수 있을 때만** 변환하고, 모르는 어미가
 * 하나라도 있으면 원문을 그대로 두고 사실만 보고한다. 사람이 그 어미를 보고 표를 늘린다.
 *
 * 형용사인지 동사인지는 코드가 알 수 없다
 * ─────────────────────────────────
 * 높습니다→높다(형용사) 인데 먹습니다→먹는다(동사)다. 어미만 보고는 못 가른다.
 * 그래서 규칙으로 풀리는 것(과거 ~았/었/였습니다, 모음 어간 ~ㅂ니다)만 규칙으로 풀고
 * 나머지는 표로 둔다. 표에 없으면 **포기**한다 — 잘못 바꾼 어미는 안 바꾼 어미보다 나쁘다.
 *
 * 분량은 왜 자르지 않는가
 * ─────────────────────
 * 의학 해설을 코드가 글자 수로 자르면 "…따라서 금기는" 에서 끊긴다. 자르는 것은 틀린
 * 문항을 만드는 일이다. 길이는 **재기만** 하고 줄이는 일은 프롬프트가 한다.
 *
 * 검증(P1) 프롬프트에는 길이·문체를 넣지 않는다
 * ────────────────────────────────────────
 * private 검증 프롬프트는 "문체·어미·분량은 절대 지적하지 마십시오"를 명시한다 —
 * 형식 지적으로 issues 를 채우면 의학 오류를 놓치기 때문이다. 거기에 "350자 초과는
 * major" 를 넣으면 같은 프롬프트가 서로 반대되는 말을 하게 된다(P3 에서 확인된 실패:
 * 더 구체적인 지시가 이기고, 어느 쪽이 이길지는 모델이 정한다). 길이는 코드가 세는 쪽이
 * 정확하고 공짜다.
 */

/** 프롬프트가 지시하는 해설 길이 상한(자). */
export const EXPLANATION_TARGET_CHARS = 350;
/**
 * 경고를 내는 길이(자). 지시(350)보다 조금 높게 둔다 — 351자를 경고로 세면 경고가
 * 상시 켜져 아무도 안 본다. 경고는 "명백히 길다"에만 붙인다.
 */
export const EXPLANATION_SOFT_LIMIT_CHARS = 400;
/** 오답 4개 중 이만큼은 해설에 나와야 한다(P9·P12 공유 기준). */
export const MIN_DISTRACTORS_MENTIONED = 3;

// ── 한글 음절 분해/조합 ────────────────────────────────────────────────
const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const JONG_COUNT = 28;
/** 종성 인덱스: 없음=0, ㄴ=4, ㅂ=17, ㅆ=20 */
const JONG_NONE = 0;
const JONG_N = 4;
const JONG_B = 17;
const JONG_SS = 20;

function jongseong(ch: string): number | null {
  const code = ch.charCodeAt(0);
  if (code < HANGUL_BASE || code > HANGUL_LAST) return null;
  return (code - HANGUL_BASE) % JONG_COUNT;
}

function withJongseong(ch: string, jong: number): string {
  const code = ch.charCodeAt(0);
  if (code < HANGUL_BASE || code > HANGUL_LAST) return ch;
  return String.fromCharCode(code - ((code - HANGUL_BASE) % JONG_COUNT) + jong);
}

// ── 어미 변환표 ───────────────────────────────────────────────────────

/** 자음 어간 형용사: 어간 + 다 (…습니다 → …다) */
const ADJ_CONSONANT_STEMS = new Set([
  '있', '없', '높', '낮', '많', '적', '좋', '같', '옳', '작', '짧', '길', '넓', '깊',
  '얕', '굵', '맞', '괜찮', '쉽', '어렵', '늦', '잦', '드물', '가늘', '좁', '붉', '검',
  '얇', '두껍', '무겁', '가볍', '뜨겁', '차갑',
]);

/** 자음 어간 동사: 어간 + 는다 (…습니다 → …는다) */
const VERB_CONSONANT_STEMS = new Set([
  '먹', '받', '막', '넣', '얻', '갖', '읽', '닫', '찾', '잡', '앉', '남', '죽', '살',
  '벗', '씻', '싣', '묻', '뽑', '접', '겪', '늘', '줄', '녹', '섞', '뚫', '뻗', '걷',
  '듣', '붙', '끊', '씹', '덮', '앓', '낫', '붓', '굳', '굽', '뱉', '참', '헐', '깎',
]);

/**
 * 하다형 **형용사** 어간(…합니다 → …하다). 여기 없으면 동사로 보고 …한다 로 바꾼다.
 * 의학 해설에서 실제로 자주 나오는 것만 담았다 — 표를 늘릴 때는 반드시
 * `npm run check:explanation` 에 사례를 함께 추가한다.
 */
const ADJ_HADA_STEMS = [
  '필요', '중요', '가능', '불가능', '적절', '부적절', '유사', '동일', '상이', '명확',
  '불명확', '다양', '심각', '경미', '우세', '저명', '현저', '특이', '비특이', '정확',
  '부정확', '충분', '불충분', '유용', '무용', '안전', '위험', '간단', '복잡', '뚜렷',
  '적합', '부적합', '타당', '미미', '급격', '완만', '양호', '불량', '무관', '흔',
  '용이', '곤란', '취약', '흡사', '유의', '무의미', '동등', '우월', '열등', '탁월',
  '희귀', '광범위', '전형적', '비전형적', '특징적', '일반적', '흔', '중대', '경미',
];

/** 모음 어간 형용사(…ㅂ니다 → 어간 + 다). */
const ADJ_VOWEL_STEMS = new Set([
  '크', '빠르', '느리', '다르', '나쁘', '바쁘', '흐리', '고르', '이르', '무르', '푸르',
  '기쁘', '슬프', '아프',
]);

/**
 * 어간이 '이'로 끝나는 **동사**(…ㅂ니다 → …ㄴ다). 여기 없으면 "명사 + 이다"로 본다.
 * 보입니다→보인다 vs 물질입니다→물질이다 를 가르는 유일한 근거다.
 */
const VERB_I_STEMS = new Set([
  '보이', '쓰이', '놓이', '섞이', '쌓이', '모이', '줄이', '늘이', '벌이', '먹이',
  '죽이', '높이', '기울이', '움직이', '떨어뜨리', '보태',
]);

/** 규칙으로도 표로도 안 풀리는 존댓말(있으면 변환을 통째로 포기한다). */
const UNRESOLVABLE_POLITE = /(습니까|십니다|십시오|하세요|해요|세요|네요|군요|는데요|거든요)/;

/** 그 단어가 실제 존댓말 어미인가. "아니다"·"기다" 같은 평서형을 걸러낸다. */
function isPoliteWord(word: string): boolean {
  if (!word.endsWith('니다')) return false;
  const base = word.slice(0, -2);
  if (base.length === 0) return false;
  if (base.endsWith('습')) return true;
  return jongseong(base[base.length - 1]) === JONG_B;
}

/**
 * 존댓말 어미 하나를 평서형으로 바꾼다. 못 바꾸면 null.
 * `word` 는 `…니다` 로 끝나는 한글 덩어리 전체다(예: "나타납니다").
 */
function convertPoliteWord(word: string): string | null {
  if (!isPoliteWord(word)) return null;
  const base = word.slice(0, -2);

  // ① …습니다
  if (base.endsWith('습')) {
    const stem = base.slice(0, -1);
    if (stem.length === 0) return null;
    // 과거·완료: 했/였/었/았 + 습니다 → 했다 … (종성 ㅆ 이면 규칙으로 풀린다)
    if (jongseong(stem[stem.length - 1]) === JONG_SS) return `${stem}다`;
    if (ADJ_CONSONANT_STEMS.has(stem) || ADJ_CONSONANT_STEMS.has(stem.slice(-1))) {
      return `${stem}다`;
    }
    if (VERB_CONSONANT_STEMS.has(stem) || VERB_CONSONANT_STEMS.has(stem.slice(-1))) {
      return `${stem}는다`;
    }
    return null;
  }

  // ② …ㅂ니다 (받침 ㅂ 이 어미다: 합니다 = 하 + ㅂ니다)
  const lastChar = base[base.length - 1];
  const stem = base.slice(0, -1) + withJongseong(lastChar, JONG_NONE);

  // 아니다 — "아닌다" 가 되면 안 된다.
  if (stem.endsWith('아니')) return `${stem}다`;
  if (ADJ_VOWEL_STEMS.has(stem)) return `${stem}다`;
  // …하다: 형용사면 하다, 동사면 한다.
  if (stem.endsWith('하')) {
    const before = stem.slice(0, -1);
    const isAdjective = ADJ_HADA_STEMS.some((s) => before.endsWith(s));
    return isAdjective ? `${stem}다` : `${before}한다`;
  }
  // 어간이 '이'로 끝나면 동사 표에 있을 때만 …ㄴ다, 아니면 "명사 + 이다".
  if (stem.endsWith('이')) {
    if (!VERB_I_STEMS.has(stem)) return `${stem}다`;
  }
  // 그 밖의 모음 어간 동사: 어간 + ㄴ다 (되→된다, 보→본다, 나타나→나타난다, 쓰→쓴다)
  const head = stem.slice(0, -1);
  const tail = stem[stem.length - 1];
  if (jongseong(tail) !== JONG_NONE) return null; // 받침이 남아 있으면 규칙 밖
  return `${head}${withJongseong(tail, JONG_N)}다`;
}

/**
 * 보조용언 "…지 않습니다 / …지 못합니다" 는 앞말이 형용사인지 동사인지에 따라
 * "…지 않다" 와 "…지 않는다" 로 갈린다("명확하지 않다" vs "발생하지 않는다").
 * 단어 하나만 봐서는 못 가르므로 앞말을 함께 보고 먼저 처리한다.
 */
const AUX_NEGATIVE_RE = /([가-힣]+)지\s+(않|못하)습니다/g;

function isAdjectivePhrase(word: string): boolean {
  if (word.endsWith('하')) {
    const before = word.slice(0, -1);
    return ADJ_HADA_STEMS.some((s) => before.endsWith(s));
  }
  return (
    ADJ_CONSONANT_STEMS.has(word) ||
    ADJ_CONSONANT_STEMS.has(word.slice(-1)) ||
    ADJ_VOWEL_STEMS.has(word)
  );
}

/** 해설 안의 "…니다" 덩어리 후보. 실제 존댓말인지는 isPoliteWord 가 가른다. */
const POLITE_WORD_RE = /[가-힣]+니다/g;

export interface ExplanationNormalizeResult {
  /** 변환 결과. 하나라도 못 바꾸면 원문 그대로. */
  text: string;
  /** 실제로 바꿨는지. */
  changed: boolean;
  /** 바꾸지 못한 존댓말 어미(있으면 changed 는 false 다). 표를 늘릴 근거로 남긴다. */
  unresolved: string[];
}

/**
 * 해설의 어미를 평서체(~이다/~한다)로 통일한다.
 *
 * 전부 아니면 전무: 하나라도 못 바꾸면 **원문을 그대로 돌려준다.** 반만 바꾼 해설은
 * 한 문단 안에서 톤이 갈려 통일 안 한 것보다 나쁘다.
 */
export function normalizeExplanation(raw: string): ExplanationNormalizeResult {
  const text = String(raw ?? '');
  if (!text.trim()) return { text, changed: false, unresolved: [] };

  const unresolved: string[] = [];
  // 규칙 밖 존댓말(의문형·요청형·주체높임)이 있으면 애초에 손대지 않는다.
  const blocking = text.match(UNRESOLVABLE_POLITE);
  if (blocking) unresolved.push(blocking[0]);

  // ① 보조용언 부정형 — 앞말을 봐야 갈린다.
  let working = text.replace(AUX_NEGATIVE_RE, (_m, prev: string, aux: string) => {
    const plain = isAdjectivePhrase(prev) ? `${aux}다` : `${aux === '않' ? '않는다' : '못한다'}`;
    return `${prev}지 ${plain}`;
  });

  // ② 나머지 존댓말 어미.
  working = working.replace(POLITE_WORD_RE, (word) => {
    if (!isPoliteWord(word)) return word;
    const converted = convertPoliteWord(word);
    if (converted === null) {
      unresolved.push(word);
      return word;
    }
    return converted;
  });

  if (unresolved.length > 0) return { text, changed: false, unresolved };
  return { text: working, changed: working !== text, unresolved: [] };
}

/** 해설에 존댓말 어미가 남아 있는가(계측용). */
export function hasPoliteEnding(text: string): boolean {
  const s = String(text ?? '');
  if (UNRESOLVABLE_POLITE.test(s)) return true;
  return (s.match(POLITE_WORD_RE) ?? []).some((w) => isPoliteWord(w));
}

// ── 오답 언급 검사 ───────────────────────────────────────────────────

/** 선지 번호 표기 — "②는 …" */
const ORDINAL_MARKS = ['①', '②', '③', '④', '⑤'];

/** 선지 텍스트에서 해설에 나타나면 "언급"으로 볼 핵심 토큰을 뽑는다. */
function choiceTokens(choice: string): string[] {
  const cleaned = String(choice ?? '')
    // 영문 병기 괄호는 본문에 그대로 안 나오는 경우가 많아 벗겨서도 본다.
    .replace(/[()[\]{}]/g, ' ')
    .replace(/[,·/]/g, ' ');
  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * 해설이 오답 선지를 실제로 다루는지 센다.
 *
 * "언급"의 기준은 둘 중 하나다.
 *  - 번호 표기(②, 2번, 2))로 지목했다.
 *  - 선지 본문의 핵심 토큰이 해설에 그대로 나온다.
 *
 * 토큰 일치는 느슨한 기준이다(우연히 겹칠 수 있다). 그래도 번호만 세면 "②는 …" 형식을
 * 쓰지 않는 멀쩡한 해설이 전부 위반이 되므로, 느슨한 쪽에서 시작해 **경고로만** 쓴다.
 * 해설을 코드가 고쳐 쓰는 일은 하지 않는다.
 */
export function countDistractorsMentioned(input: {
  explanation: string;
  choices: string[];
  answerIndex: number;
}): { mentioned: number; total: number; missing: number[] } {
  const exp = String(input.explanation ?? '');
  const missing: number[] = [];
  let mentioned = 0;
  let total = 0;

  input.choices.forEach((choice, i) => {
    if (i === input.answerIndex) return;
    total += 1;
    const ordinal = ORDINAL_MARKS[i] ?? '';
    const byNumber =
      (ordinal !== '' && exp.includes(ordinal)) ||
      new RegExp(`(?:^|[^0-9])${i + 1}\\s*(?:번|\\)|\\.)`).test(exp);
    const byText = choiceTokens(choice).some((t) => exp.includes(t));
    if (byNumber || byText) mentioned += 1;
    else missing.push(i + 1);
  });

  return { mentioned, total, missing };
}
