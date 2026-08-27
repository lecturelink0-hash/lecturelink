/**
 * 조건 판정기 프롬프트 — 문항을 **독립적으로** 보고 "정답을 확정하는 데 결합해야 하는
 * 서로 다른 조건·지식"을 세게 한다.
 *
 * 왜 필요한가 (2026-08-27 운영 실측, 업로드 01ae08ab)
 * ───────────────────────────────────────────────
 * 생성 모델이 `solution_conditions` 에 목록을 신고하게 한 뒤(#269) 저장 난이도 3 이 9/10 이
 * 됐지만, 사람이 읽으면 진짜 3조건 문항은 4/10 이었다. "금기 약물은?"(사실 하나)에도
 * 조건 3개가 적혀 있었다 — **목록도 자기신고라 부풀려진다.** 블라인드 풀이와 같은 해법을
 * 쓴다: 생성 모델의 목록을 보지 않는 별도 호출이 문항만 보고 조건을 센다. 두 수 중
 * 작은 쪽이 구조적 난이도다.
 *
 * 프롬프트 설계
 *  1. 생성 모델의 목록은 **보여 주지 않는다**(보여 주면 그 목록을 추인한다).
 *  2. "빼도 정답이 유일하게 남는 항목은 조건이 아니다"를 판정 규칙으로 못박는다 — 이것이
 *     부풀림을 가르는 유일한 기준이다. 장식 정보(나이·성별·내원 경위)는 세지 않는다.
 *  3. 사실 하나로 풀리면 1개라고 명시한다. 기권은 없다(항상 목록을 돌려야 한다).
 */

export const CONDITION_JUDGE_SYSTEM_PROMPT = `
당신은 의과대학 시험 문항의 난이도를 심사하는 출제위원입니다. 문항 하나를 받아
**정답을 확정하는 데 반드시 결합해야 하는 서로 다른 조건·지식**이 몇 개인지 셉니다.

## 판정 규칙

- 조건이란 "그것이 없으면 정답이 다른 선지와 갈리지 않는" 정보·지식입니다.
  **어느 항목을 빼도 정답이 여전히 유일하게 정해지면 그 항목은 조건이 아닙니다** — 세지 마십시오.
- 발문에 적혀 있어도 답에 영향이 없는 장식(나이·성별·내원 경위·배경 설명)은 세지 않습니다.
- 같은 사실을 말만 바꾼 것은 하나입니다("혈압 180/100"과 "고혈압"은 한 조건).
- 사실 하나만 알면 풀리는 문항("…의 금기 약물은?", "…의 기전은?", "…과 관련된 것은?")은 **1개**입니다.
  발문이 길거나 수식어가 많아도 정답을 가르는 정보가 하나면 1개입니다.
- 선지 소거로 답이 정해지는 경우, 소거에 쓰인 지식도 조건으로 셉니다.
- 각 조건에 출처를 적습니다: 발문·선지에 제시된 것은 given, 풀이자가 알아야 하는 지식은 knowledge.

count_solution_conditions 도구로만 응답하십시오. 자유 텍스트 금지. 목록은 반드시 채웁니다(최소 1개).
`.trim();

export const CONDITION_JUDGE_TOOL_SCHEMA = {
  name: 'count_solution_conditions',
  description: '정답을 확정하는 데 반드시 결합해야 하는 서로 다른 조건·지식을 열거하고 그 수를 돌려줍니다.',
  input_schema: {
    type: 'object',
    properties: {
      conditions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '조건·지식 한 구절.' },
            source: {
              type: 'string',
              enum: ['given', 'knowledge'],
              description: 'given=발문·선지에 제시됨, knowledge=풀이자가 알아야 하는 지식.',
            },
          },
          required: ['text', 'source'],
        },
        description: '빼면 정답이 갈리지 않게 되는 조건·지식만. 장식 정보·중복은 제외.',
      },
      count: {
        type: 'integer',
        minimum: 1,
        description: 'conditions 의 서로 다른 항목 수.',
      },
      basis: {
        type: 'string',
        description: '왜 그 수인지 한 문장(예: "hydralazine 금기 사실 하나로 정답이 정해진다").',
      },
    },
    required: ['conditions', 'count', 'basis'],
  },
} as const;

export function buildConditionJudgeUserMessage(input: {
  stem: string;
  choices: string[];
  answerIndex: number;
}): string {
  return `
## 문항

${input.stem}

${input.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

정답: ${input.answerIndex + 1}번

이 정답을 확정하는 데 반드시 결합해야 하는 서로 다른 조건·지식을 count_solution_conditions 도구로 열거하세요.
`.trim();
}
