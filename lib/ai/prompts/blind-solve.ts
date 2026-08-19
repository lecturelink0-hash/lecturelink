/**
 * 블라인드 풀이 프롬프트 (P9) — 이미지형 문항을 **그림 없이** 풀려 본다.
 *
 * 이 프롬프트의 목적은 정답을 맞히는 것이 아니라 "그림이 없어도 답이 정해지는가"를
 * 재는 것이다. 그래서 일반적인 응시 프롬프트와 두 곳이 다르다.
 *
 *  1. **모른다고 답할 길을 주지 않는다.** 기권을 허용하면 모델이 "그림이 없어 알 수
 *     없습니다"로 도망가 검사가 항상 통과한다(모델 자기점검의 통과율이 100 %가 된 것과
 *     같은 실패). 반드시 하나를 고르게 하고, 우연 정답은 시도 횟수(BLIND_ATTEMPTS)로 건다.
 *  2. **추론 근거를 한 줄 받는다.** 폐기를 사람이 다시 볼 때 "선지 4개가 터무니없어서
 *     소거로 풀렸다"와 "발문이 소견을 그대로 적어 놨다"를 구별해야 하기 때문이다.
 *     실측 후 프롬프트를 어디로 고칠지가 이 한 줄에서 갈린다.
 */

export const BLIND_SOLVE_SYSTEM_PROMPT = `
당신은 한국 의과대학 본과생입니다. 지금 시험을 보고 있습니다.

## 상황

아래 문항은 원래 **사진·영상·그림과 함께** 출제된 문항인데, 지금 당신에게는 그림이 없습니다.
발문에 "다음 심전도에서", "아래 사진의" 같은 표현이 있어도 그 그림은 볼 수 없습니다.

## 지시

- 그림 없이, **발문과 선지만 보고** 답을 하나 고르십시오.
- **반드시 하나를 고릅니다.** "그림이 없어 알 수 없다", "판단 불가" 같은 답은 허용하지 않습니다.
  확신이 없으면 가장 그럴듯한 것을 고르십시오.
- 선지를 소거해서 좁힐 수 있으면 소거하십시오. 발문에 소견·수치·병력이 이미 적혀 있으면 그것을 쓰십시오.
- 근거(basis)에는 **무엇을 보고 골랐는지** 한 문장으로 적으십시오.
  예: "발문에 ST 분절 상승이라고 적혀 있어 그림 없이 결정됨", "나머지 4개가 해당 장기와 무관해 소거됨",
  "단서가 없어 임의로 선택함".

solve_without_image 도구로만 응답하십시오. 자유 텍스트 금지.
`.trim();

export const BLIND_SOLVE_TOOL_SCHEMA = {
  name: 'solve_without_image',
  description: '그림 없이 발문과 선지만 보고 답을 하나 고릅니다.',
  input_schema: {
    type: 'object',
    properties: {
      answer_index: {
        type: 'integer',
        minimum: 0,
        maximum: 4,
        description: '고른 선지의 0-based 번호. 반드시 하나를 고른다(기권 없음).',
      },
      basis: {
        type: 'string',
        description:
          '무엇을 보고 골랐는지 한 문장. 단서가 전혀 없어 찍었다면 그렇게 적는다.',
      },
    },
    required: ['answer_index', 'basis'],
  },
} as const;

export function buildBlindSolveUserMessage(input: {
  stem: string;
  choices: string[];
}): string {
  return `
## 문항 (그림 없음)

${input.stem}

${input.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

solve_without_image 도구로 답하세요.
`.trim();
}
