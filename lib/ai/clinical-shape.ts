/**
 * '임상형' 문항인지 결정론적으로 판정한다.
 *
 * 왜 코드로 세는가
 * ───────────────
 * 임상형은 프롬프트로만 요구하면 조용히 지식형으로 돌아간다(2026-08-16 실측: 임상형만
 * 골라 뽑은 10문항이 전부 지식형이었다). 그런데 그 실패는 로그에 아무 흔적을 남기지
 * 않는다 — 저장은 정상이고 문항 수도 맞다. 화면을 사람이 보기 전에는 아무도 모른다.
 *
 * 그래서 "임상형 요청에서 실제로 임상 증례형이 몇 개 나왔는지"를 저장 직전에 센다.
 * 세지 못하면 회귀했을 때 또 사용자가 먼저 발견하게 된다.
 *
 * 판정은 **고치지 않고 세기만 한다.** 지문을 자동으로 증례로 바꾸는 것은 의학 내용을
 * 발명하는 일이라 코드가 할 수 없다. 미달은 경고와 진단 기록으로 남긴다.
 *
 * 오탐/미탐 기준
 * ─────────────
 * 이 판정은 "문항을 버릴지"가 아니라 "몇 개인지"에만 쓰이므로, 애매한 것은 임상형이
 * 아닌 쪽으로 센다(과소 보고). 지식형을 임상형으로 잘못 세면 미달을 놓쳐 회귀를
 * 그대로 통과시키기 때문이다.
 */

export interface ClinicalLintIssue {
  rule: string;
  message: string;
}

/**
 * C1 도입 문형 — 환자 한 명이 특정되는가.
 *
 * "[N]세 남자/여자"가 기본형이고, 소아·신생아·산과는 국시 관례상 다른 형태를 쓴다.
 * 이 중 하나도 없으면 증례가 아니다.
 */
const PATIENT_INTRO_PATTERNS: RegExp[] = [
  /\d+\s*세\s*(?:[^.?!\n]{0,30}?)?(?:남자|여자|남아|여아)/, // 62세 남자 / 36세 산과력 0-0-0-0인 여자
  /생후\s*\d+\s*(?:일|주|개월|년)/, // 생후 5일째
  /임신(?:나이)?\s*\d+\s*주/, // 임신 35주인 / 임신나이 39주
  /\d+\s*개월\s*된\s*(?:남아|여아|영아)/, // 18개월 된 남아
];

/**
 * 증례가 실제로 임상 정보를 담고 있는지 — 도입 한 줄짜리 껍데기를 거른다.
 *
 * **"병원에 왔다"는 여기 넣지 않는다.** 그건 도입 문형(C1)의 일부라서, 넣으면
 * "62세 남자가 병원에 왔다. 별아교세포의 기능은?" 같은 껍데기가 임상형으로 세어진다
 * (자기 검사에서 실제로 걸렸다). 도입 뒤에 **새로 붙은 임상 정보**만 센다.
 */
const CLINICAL_DETAIL_PATTERNS: RegExp[] = [
  /혈압\s*\d+\/\d+|맥박\s*\d+|체온\s*\d+|호흡\s*\d+/,
  /진찰(?:에서|상)|청진(?:에서|상)|촉진(?:에서|상)|시진(?:에서|상)/,
  /검사\s*결과|검사에서|영상에서|사진에서|소견(?:이|은|을|에서)/,
  /(?:하|되|있|없|보이|들리)(?:였|었)다고?\s*한다/, // 전언
  /에서\s*[^.?!\n]{0,40}?(?:보인다|관찰된다|들린다|만져진다|나타난다|측정된다)/, // 검사·진찰 소견
  /\d+\s*(?:분|시간|일|주|개월|년)\s*(?:전|째|동안|간)/, // 증상 경과
];

/**
 * 임상형으로 **세기 위한** 서술 길이 하한(공백 제외, 자).
 *
 * lintClinicalStem 의 C4 하한(80자)보다 낮다. 세는 것과 품질을 보는 것은 목적이 다르다 —
 * 60자짜리 얇은 증례도 증례이므로 쿼터에는 세고, 린트는 "더 써라"고 지적한다.
 */
const MIN_NARRATIVE_CHARS = 55;

/**
 * 지식형 문두 — 이게 붙으면 앞에 환자가 있어도 임상 판단을 묻는 문항이 아니다.
 *
 * "…에 대한 설명으로 옳은 것은?"이 대표적이다. 실측 10문항 전부가 이 형태였다.
 */
const KNOWLEDGE_ASK_PATTERNS: RegExp[] = [
  /설명으로\s*(?:옳은|맞는|적절한)/,
  /(?:종류|기능|특징|분류|구조)(?:와|과|에)\s*[^.?!\n]{0,20}(?:설명|것은)/,
  /다음\s*중\s*[^.?!\n]{0,30}(?:옳은|맞는)\s*것은/,
];

/** 지문의 마지막 물음표 문장(발문)만 잘라낸다. */
export function extractAsk(stem: string): string {
  const flat = String(stem ?? '').replace(/\s+/g, ' ').trim();
  const match = flat.match(/[^.?!]*\?\s*$/);
  return (match ? match[0] : flat.slice(-40)).trim();
}

/** C1 — 환자 한 명이 특정되는 도입 문형이 있는가. */
export function hasPatientIntro(stem: string): boolean {
  const s = String(stem ?? '');
  return PATIENT_INTRO_PATTERNS.some((re) => re.test(s));
}

/**
 * 임상 증례형 문항인지.
 *
 * 세 조건을 모두 만족해야 한다.
 *  1) 환자 한 명이 특정되는 도입 문형이 있다 (C1)
 *  2) 도입 뒤에 임상 정보가 실제로 붙어 있다 (C4 — 도입 한 줄 껍데기 배제)
 *  3) 서술이 최소 길이를 넘는다 (2 와 함께 봐야 "3일 전부터 …로 왔다. 개념은?"을 거른다)
 *  4) 발문이 지식형 문두("~에 대한 설명으로 옳은 것은?")가 아니다 (C9)
 */
export function isClinicalVignette(stem: string): boolean {
  const s = String(stem ?? '');
  if (!hasPatientIntro(s)) return false;
  if (!CLINICAL_DETAIL_PATTERNS.some((re) => re.test(s))) return false;
  // 검사 블록(줄바꿈 뒤 수치 나열)로 길이를 채운 것을 통과시키지 않으려고 첫 줄로 잰다.
  const narrative = s.split('\n')[0] ?? s;
  if (narrative.replace(/\s/g, '').length < MIN_NARRATIVE_CHARS) return false;
  const ask = extractAsk(s);
  if (KNOWLEDGE_ASK_PATTERNS.some((re) => re.test(ask))) return false;
  return true;
}

/**
 * C1 — 지문에 쓰면 안 되는 표현.
 *
 * "남성호르몬" 같은 복합어는 잡지 않되 **"45세 남성이"는 반드시 잡아야 한다.**
 * 단순히 뒤에 한글이 오면 제외하는 방식(`남성(?![가-힣])`)은 조사가 붙은 형태를 통째로
 * 놓친다 — 실제로 자기 검사에서 "45세 남성이 …"가 통과했다. 그래서 "경계이거나 조사가
 * 붙은 경우"를 명시적으로 허용한다.
 */
const JOSA = '(?:이|가|은|는|을|를|의|도|만|과|와|에게|으로)';
const FORBIDDEN_STEM_PATTERNS: Array<[RegExp, string]> = [
  [
    new RegExp(`(?<![가-힣])남성(?:(?![가-힣])|(?=${JOSA}(?![가-힣])))`),
    'C1: "남성" 대신 "남자"를 쓴다',
  ],
  [
    new RegExp(`(?<![가-힣])여성(?:(?![가-힣])|(?=${JOSA}(?![가-힣])))`),
    'C1: "여성" 대신 "여자"를 쓴다',
  ],
  [/내원(?:하였|했)다/, 'C1: "내원하였다" 대신 "병원에 왔다"를 쓴다'],
  [/방문(?:하였|했)다/, 'C1: "방문하였다" 대신 "병원에 왔다"를 쓴다'],
];

/** C9 — 임상형 발문에 쓰면 안 되는 표현. */
const FORBIDDEN_ASK_PATTERNS: Array<[RegExp, string]> = [
  [/설명으로\s*(?:옳은|맞는|적절한)/, 'C9: "~에 대한 설명으로 옳은 것은?"은 임상형 발문이 아니다'],
  [/가장/, 'C9: "가장 적절한" 같은 표현을 쓰지 않는다'],
  [/다음\s*중/, 'C9: "다음 중"을 쓰지 않는다'],
  [/무엇인가/, 'C9: "~은 무엇인가?" 대신 "진단은?" 형태로 쓴다'],
  [/접근은\s*\?/, 'C9: "접근은?"은 임상 결정을 묻는 발문이 아니다'],
  [/원칙은\s*\?/, 'C9: "평가 원칙은?"은 임상 결정을 묻는 발문이 아니다'],
  [/단계는\s*\?/, 'C9: "다음 단계는?" 대신 "처치는?" "검사는?"을 쓴다'],
];

/** C4 — 증례 지문 최소 길이(자). 도입 한 줄(40자 남짓)로 끝나는 것을 막는다. */
const MIN_VIGNETTE_CHARS = 80;

/**
 * 임상형으로 만들어진 문항의 형식 위반을 찾는다. 고치지 않고 목록만 돌려준다.
 *
 * 임상형이 **아닌** 문항(지식형·이미지형)에 부르면 C1 위반이 잔뜩 나오므로,
 * 임상형 몫으로 세어진 문항에만 쓴다.
 */
export function lintClinicalStem(stem: string): ClinicalLintIssue[] {
  const issues: ClinicalLintIssue[] = [];
  const s = String(stem ?? '');

  if (!hasPatientIntro(s)) {
    issues.push({ rule: 'C1', message: 'C1: "[N]세 남자/여자가 …" 형태의 환자 도입이 없다' });
  }
  for (const [pattern, message] of FORBIDDEN_STEM_PATTERNS) {
    if (pattern.test(s)) issues.push({ rule: 'C1', message });
  }

  // 검사 블록(줄바꿈)을 뺀 서술 길이로 잰다 — 수치 나열로 길이를 채운 것을 통과시키지 않는다.
  const narrative = s.split('\n')[0] ?? s;
  if (narrative.replace(/\s/g, '').length < MIN_VIGNETTE_CHARS) {
    issues.push({
      rule: 'C4',
      message: `C4: 증례 서술이 ${narrative.replace(/\s/g, '').length}자로 짧다 (최소 ${MIN_VIGNETTE_CHARS}자)`,
    });
  }

  // C5 — 활력징후 서식
  if (/활력징후\s*:/.test(s)) {
    issues.push({ rule: 'C5', message: 'C5: "활력징후:" 라벨 없이 문장으로 쓴다' });
  }
  if (/혈압\s*\d+\/\d+/.test(s)) {
    const order = ['혈압', '맥박', '호흡', '체온'].map((k) => s.indexOf(k)).filter((i) => i >= 0);
    const ascending = order.every((v, i) => i === 0 || order[i - 1] < v);
    if (order.length === 4 && !ascending) {
      issues.push({ rule: 'C5', message: 'C5: 활력징후는 혈압→맥박→호흡→체온 순서로 쓴다' });
    }
    // mmHg·℃ 는 숫자와 띄어 쓴다. "맥박 72회/분"의 "회/분"은 붙여 쓰므로 제외한다.
    if (/\d(?:mmHg|℃)/.test(s)) {
      issues.push({ rule: 'C5', message: 'C5: mmHg·℃ 는 숫자와 한 칸 띄어 쓴다' });
    }
    if (/bpm/i.test(s)) {
      issues.push({ rule: 'C5', message: 'C5: 맥박 단위는 bpm 이 아니라 "회/분"이다' });
    }
  }

  // C6 — 검사 블록에 도입문이 없음
  if (s.includes('\n') && !/결과는 다음과 같다/.test(s)) {
    issues.push({ rule: 'C6', message: 'C6: 검사 블록 앞에 "검사 결과는 다음과 같다."를 둔다' });
  }

  // C9 — 발문 형태
  const ask = extractAsk(s);
  if (!/\?\s*$/.test(s.trim())) {
    issues.push({ rule: 'C9', message: 'C9: 지문이 발문(물음표)으로 끝나야 한다' });
  }
  for (const [pattern, message] of FORBIDDEN_ASK_PATTERNS) {
    if (pattern.test(ask)) issues.push({ rule: 'C9', message });
  }

  return issues;
}

/**
 * 한 배치에서 임상형 목표를 실제로 채웠는지 센다.
 *
 * 반환하는 shortfall 이 0 보다 크면 프롬프트 지시가 먹히지 않은 것이다 —
 * 호출부가 경고·진단으로 남긴다.
 */
export function measureClinicalYield(
  stems: string[],
  quota: number,
): { clinical: number; total: number; shortfall: number } {
  const clinical = stems.filter((s) => isClinicalVignette(s)).length;
  return {
    clinical,
    total: stems.length,
    shortfall: Math.max(0, quota - clinical),
  };
}
