/**
 * 참고 자료(족보·기출)의 **형식 프로파일** (P7).
 *
 * 왜 필요한가 (2026-08-18 감사)
 * ────────────────────────────
 * 참고 자료는 지금까지 **이미지 6장(PDF 앞 3쪽 렌더)** 이 전부였다.
 *  - 텍스트를 아예 추출하지 않아 20쪽짜리 족보를 올려도 앞 3쪽 사진만 봤다.
 *  - PPTX·DOCX 는 **무경고로 무시**됐다(P8 에서 경고만 붙였고, 반영은 여기서 한다).
 *  - 그 6장을 **배치마다 다시 전송**했다(캐시 없음) — 배치 5개면 30장 분량이 오간다.
 *  - 가이드 문구는 "형식과 난이도를 반영"이라 했지만 난이도 지시는 코드에 없었다.
 *
 * 내신의 본질은 **학교마다 다른 족보 스타일**이다. 그걸 반영하려면 그림 몇 장이 아니라
 * "이 학교는 발문을 어떻게 끝내고, 선지를 어떤 형식으로 쓰며, 부정형을 얼마나 쓰는가"를
 * 뽑아야 한다. 그래서 텍스트를 읽어 **한 번** 요약하고, 그 요약을 시스템 프롬프트에 붙인다
 * (시스템은 캐시 대상이라 배치가 늘어도 비용이 늘지 않는다).
 *
 * 내용 유출 방지
 * ─────────────
 * 프로파일은 **형식만** 담는다. 질환명·수치·정답은 담지 않는다 — 담으면 "기출 내용을
 * 출제 근거로 쓰지 말라"는 절대 원칙 5·6 을 프로파일이 우회하게 된다. 예시 발문도
 * 의학 명사를 지운 골격만 남긴다.
 */

/** 모델이 채우는 형식 프로파일. 값은 전부 '형식'이며 의학 내용을 담지 않는다. */
export interface ReferenceFormatProfile {
  /** 발문이 끝나는 형태 상위 3개(예: "옳은 것은?", "진단은?"). */
  ask_endings: string[];
  /** 선지 형식. */
  choice_style: '명사구' | '문장' | '혼합';
  /** 지문 평균 길이(자). 증례형이면 길고 개념형이면 짧다. */
  avg_stem_chars: number;
  /** 부정형("옳지 않은", "아닌") 비율 0~1. */
  negative_ratio: number;
  /** ㄱ/ㄴ/ㄷ 조합형을 쓰는가. */
  combo_used: boolean;
  /** 환자 증례로 시작하는 문항 비율 0~1. */
  vignette_ratio: number;
  /** 의학 명사를 지운 발문 골격 예시(최대 3개). */
  sample_ask_shapes: string[];
  /** 분석에 실제로 쓰인 문항 수(0이면 형식을 못 읽은 것). */
  observed_questions: number;
}

export const REFERENCE_PROFILE_TOOL = {
  name: 'summarize_reference_format',
  description:
    '기출·족보 자료에서 **문항의 형식만** 뽑아 요약한다. 의학 내용(질환명·수치·정답)은 담지 않는다.',
  input_schema: {
    type: 'object',
    properties: {
      ask_endings: {
        type: 'array',
        items: { type: 'string' },
        description:
          '발문이 끝나는 형태를 많이 쓰인 순으로 최대 3개. 예: "옳은 것은?", "진단은?", "옳지 않은 것은?". 질환명을 붙이지 말고 종결 형태만 적는다.',
      },
      choice_style: {
        type: 'string',
        enum: ['명사구', '문장', '혼합'],
        description: '선지가 명사구인지("심근경색"), 문장인지("~을 투여한다"), 섞여 있는지.',
      },
      avg_stem_chars: {
        type: 'integer',
        description: '지문(발문 포함) 평균 길이(자). 대략치로 충분하다.',
      },
      negative_ratio: {
        type: 'number',
        description: '부정형 발문("옳지 않은", "아닌", "거리가 먼")의 비율 0~1.',
      },
      combo_used: {
        type: 'boolean',
        description: 'ㄱ/ㄴ/ㄷ 보기를 묶어 고르는 조합형이 쓰였는가.',
      },
      vignette_ratio: {
        type: 'number',
        description: '환자 증례("[N]세 남자가 …")로 시작하는 문항의 비율 0~1.',
      },
      sample_ask_shapes: {
        type: 'array',
        items: { type: 'string' },
        description:
          '발문 골격 예시 최대 3개. **의학 명사를 반드시 지운다** — "이 환자의 진단은?", "…에 대한 설명으로 옳은 것은?" 처럼 형태만 남긴다. 질환명·약물명·수치를 그대로 옮기지 않는다.',
      },
      observed_questions: {
        type: 'integer',
        description: '형식을 읽어낸 문항 수. 문항 형태가 없으면 0.',
      },
    },
    required: [
      'ask_endings',
      'choice_style',
      'avg_stem_chars',
      'negative_ratio',
      'combo_used',
      'vignette_ratio',
      'sample_ask_shapes',
      'observed_questions',
    ],
  },
} as const;

export const REFERENCE_PROFILE_SYSTEM_PROMPT = `
당신은 한국 의과대학 시험지(기출·족보)의 **형식**을 분석하는 보조자입니다.

주어진 텍스트에서 문항의 겉모습만 관찰해 summarize_reference_format 도구로 답합니다.

## 반드시 지킬 것

1. **의학 내용을 옮기지 않습니다.** 질환명·약물명·검사 수치·정답은 어느 필드에도 쓰지 않습니다.
   예시 발문을 적을 때도 의학 명사를 지우고 골격만 남깁니다.
   ✗ "급성 심근경색 환자에게 가장 먼저 시행할 검사는?"
   ○ "이 환자에게 가장 먼저 시행할 검사는?"
2. 문항 형태가 보이지 않으면(강의록·요약본 등) observed_questions 를 0 으로 두고
   나머지는 기본값으로 채웁니다. 없는 형식을 지어내지 않습니다.
3. 비율은 눈대중이어도 됩니다. 정확한 수보다 경향이 중요합니다.
`.trim();

export function buildReferenceProfileUserMessage(text: string, maxChars = 24_000): string {
  return `
다음은 기출·족보 자료에서 추출한 텍스트입니다. 문항의 **형식**만 관찰해 요약하세요.

${text.slice(0, maxChars)}

summarize_reference_format 도구로 답하세요.
`.trim();
}

/**
 * 의미 있는 형식 정보인지 — 문장부호·공백만 남은 값을 걸러낸다.
 *
 * 2026-08-19 실측: 영문 시험지를 참고 자료로 주니 모델이 `ask_endings: ["?"]`,
 * `sample_ask_shapes: ["?"]` 를 돌려줬다. 한국어 종결 형태를 뽑는 필드에 영문 자료를
 * 넣었으니 뽑을 게 없었던 것이다. 문제는 그 값이 그대로 프롬프트에 실려
 * "발문 종결: "?"" 라는 무의미한 지시가 되고, 그것이 **규격보다 우선**한다는 점이다.
 */
function isMeaningfulShape(v: string): boolean {
  // 한글·영문·숫자가 2자 이상 남아야 형식이라고 볼 수 있다.
  return v.replace(/[^0-9A-Za-z가-힣]/g, '').length >= 2;
}

/**
 * 모델 응답을 프롬프트에 싣기 전에 다듬는다.
 *
 * 못 믿을 값은 **버린다**(0/빈 배열). 프로파일은 규격을 이기는 지시라, 틀린 값이 실리면
 * 규격이 지켜 주던 것까지 무너진다. 모르면 말하지 않는 편이 낫다.
 */
export function sanitizeProfile(p: ReferenceFormatProfile): ReferenceFormatProfile {
  const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
  return {
    ...p,
    ask_endings: p.ask_endings.filter(isMeaningfulShape).slice(0, 3),
    sample_ask_shapes: p.sample_ask_shapes.filter(isMeaningfulShape).slice(0, 3),
    // 30자 미만은 지문 길이로 성립하지 않는다(발문 하나도 그보다 길다) — 모름(0)으로 둔다.
    avg_stem_chars:
      Number.isFinite(p.avg_stem_chars) && p.avg_stem_chars >= 30 && p.avg_stem_chars <= 2000
        ? Math.round(p.avg_stem_chars)
        : 0,
    negative_ratio: clamp01(p.negative_ratio),
    vignette_ratio: clamp01(p.vignette_ratio),
  };
}

/**
 * 프로파일이 쓸 만한지 — 문항을 읽었고, **의미 있는 발문 종결이 하나라도** 남아야 한다.
 * 종결을 못 뽑았으면 형식을 안다고 말할 수 없으므로 붙이지 않는다(종전에는 `["?"]` 도 통과했다).
 */
export function isUsableProfile(p: ReferenceFormatProfile | null): p is ReferenceFormatProfile {
  if (!p || p.observed_questions <= 0) return false;
  return p.ask_endings.some(isMeaningfulShape);
}

/**
 * 시스템 프롬프트에 붙일 절.
 *
 * **우선순위**: 참고 자료의 형식이 기본 규격(K/C 의 발문 형태·길이·부정형 비율)보다 **우선**한다
 * (사용자 결정 2026-08-19). 학생이 자기 학교 족보를 올린 이유가 그 스타일로 풀어보기 위해서다.
 * 다만 **안전 규칙은 예외**다 — 정답 누출(F17 계열)·오답 성립성·선지 5개·이미지 규칙은
 * 족보가 어떻든 그대로 지킨다. 족보가 "가장 적절한"을 쓴다고 해서 정답이 길이로 드러나도
 * 된다는 뜻은 아니다.
 */
export function buildReferenceProfileSection(p: ReferenceFormatProfile): string {
  const q = sanitizeProfile(p);
  const endings = q.ask_endings.map((e) => `"${e}"`).join(', ');
  const shapes = q.sample_ask_shapes.map((s) => `  · ${s}`).join('\n');
  const pct = (v: number) => `${Math.round(v * 100)} %`;
  // 모르는 값은 줄 자체를 뺀다 — 빈칸을 채우려고 틀린 숫자를 적으면 그 숫자가 규격을 이긴다.
  const lines = [
    `- 발문 종결: ${endings}`,
    `- 선지 형식: ${q.choice_style}`,
    q.avg_stem_chars > 0 ? `- 지문 평균 길이: 약 ${q.avg_stem_chars}자` : null,
    `- 부정형("옳지 않은") 비율: ${pct(q.negative_ratio)}`,
    `- 조합형(ㄱ/ㄴ/ㄷ): ${q.combo_used ? '사용함' : '사용 안 함'}`,
    `- 증례형 비율: ${pct(q.vignette_ratio)}`,
  ].filter(Boolean);
  return `
## 참고 자료 형식 프로파일 (이번 요청)

학생이 올린 기출·족보 ${q.observed_questions}문항에서 뽑은 **형식**이다. 내용이 아니라 겉모습이다.

${lines.join('\n')}
${shapes ? `- 발문 골격 예시(의학 명사는 지워져 있다):\n${shapes}` : ''}

### 이 프로파일을 어떻게 쓰는가

- **형식은 이 프로파일을 우선한다.** 위 규격(K·C)의 발문 형태·지문 길이·부정형 비율과
  어긋나면 **프로파일을 따른다.** 학생은 자기 학교 시험 형식으로 연습하려고 이 자료를 올렸다.
- **다만 아래는 프로파일보다 우선하는 안전 규칙이다.** 족보가 어떻게 쓰든 반드시 지킨다.
  1. 선지는 정확히 5개, 중복 없음.
  2. 정답이 길이·형식으로 드러나지 않게 한다(정답만 길게 쓰지 않는다).
  3. 오답 4개는 그 상황에서 실제로 고려될 수 있는 것이어야 한다(상식으로 지워지는 선지 금지).
  4. 이미지 규칙(그림 없이 그림을 가리키지 않기)과 해설 원칙은 그대로 지킨다.
- **내용은 절대 가져오지 않는다.** 프로파일에는 의학 내용이 없고, 있어서도 안 된다.
  출제 근거는 오직 필수 업로드 자료다.
`.trim();
}
