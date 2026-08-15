/**
 * 오답 사유 분석 프롬프트
 *
 * "이 주제를 틀렸다"가 아니라 **"이 주제를 왜 틀렸는가"**를 판정한다.
 *
 * 판정의 핵심 입력은 정답 여부가 아니라 **사용자가 실제로 고른 선지**다.
 * 같은 문항을 틀려도 무엇을 골랐느냐에 따라 처방이 완전히 달라진다.
 *   - 정답과 임상상이 겹치는 감별 대상을 골랐다  → 감별진단의 오류
 *   - 검사 수치가 가리키는 방향과 반대를 골랐다   → 검사 해석의 오류
 *   - 진단은 맞는데 시점·순서가 틀린 처치를 골랐다 → 치료 선택의 오류
 *   - 지문에 명시된 금기·나이·임신 여부를 무시했다 → 조건·단서의 놓침
 *   - 정답과 아무 관계 없는 선지를 골랐다        → 개념 부족
 *
 * 이 판정 결과는 그대로 다음 문항 생성 프롬프트에 실린다(targeting_brief).
 * 그래서 분류만 하지 않고 "그럼 어떤 문항을 내야 하는가"까지 쓰게 한다.
 */

/** 오답 사유 분류. DB 저장 없이 API 응답·생성 프롬프트에서만 쓴다. */
export const ERROR_REASONS = [
  'concept_gap',
  'differential_error',
  'test_interpretation',
  'management_choice',
  'missed_cue',
] as const;

export type ErrorReason = (typeof ERROR_REASONS)[number];

export const ERROR_REASON_LABELS: Record<ErrorReason, string> = {
  concept_gap: '개념 부족',
  differential_error: '감별진단의 오류',
  test_interpretation: '검사 해석의 오류',
  management_choice: '치료 선택의 오류',
  missed_cue: '조건·단서의 놓침',
};

export const ERROR_ANALYSIS_SYSTEM_PROMPT = `
You are a Korean medical education diagnostician. 학생이 틀린 문항과 **학생이 실제로 고른 선지**를 보고, 왜 틀렸는지를 판정한다.

## 판정 대상 (다섯 가지 중 하나를 고른다)

**concept_gap — 개념 부족**
고른 선지가 정답과 임상적 연결이 거의 없다. 해당 질환·약물·기전 자체를 모른다.
판별 신호: 고른 선지가 이 임상 상황에서 감별 대상조차 아니다. 여러 문항에서 고르는 선지가 일관성 없이 흩어진다.

**differential_error — 감별진단의 오류**
고른 선지가 정답과 임상상이 겹치는 **실제 감별 대상**이다. 질환군은 맞게 좁혔는데 마지막에서 갈렸다.
판별 신호: 같은 장기·같은 증후군 안의 다른 질환을 골랐다. 정답과 고른 선지를 가르는 소견이 지문에 분명히 있었다.

**test_interpretation — 검사 해석의 오류**
지문의 검사 수치·영상·심전도가 가리키는 방향을 거꾸로 읽었거나 읽지 않았다.
판별 신호: 지문에 결정적 수치가 있는데 고른 선지가 그 수치와 모순된다. 참고치 대비 방향(상승/저하)을 반대로 적용했다.

**management_choice — 치료 선택의 오류**
진단은 맞았는데 처치를 잘못 골랐다. 순서(먼저 할 것 vs 나중), 시점, 금기, 용량, 1차 약제 선택에서 갈렸다.
판별 신호: 고른 선지가 그 질환에서 언젠가는 하는 처치지만 **지금** 할 것은 아니다.

**missed_cue — 조건·단서의 놓침**
지문에 명시된 결정적 조건을 못 봤다. 임신, 나이, 알레르기, 콩팥기능, 투약력, 과거력, 노출력, 음성 소견 같은 것.
판별 신호: 그 조건 한 줄만 지우면 학생이 고른 선지가 정답이 된다.

## 판정 원칙

1. **고른 선지를 근거로 삼는다.** 정답을 몰랐다는 사실만으로 전부 concept_gap 으로 몰지 않는다.
2. **"그 조건을 지우면 학생 답이 정답이 되는가?"**를 먼저 자문한다. 그렇다면 missed_cue 다.
3. 여러 사유가 겹치면 **가장 자주 반복되는 것**을 primary 로 둔다. 표본이 1건이면 그 1건으로 판정하되 confidence 를 낮춘다.
4. 문항 자체가 결함이면(오답 선지가 상식만으로 소거되는 문항, 정답이 길이로 드러나는 문항) flawed_items 에 넣고 사유 판정 근거에서 제외한다. 그런 문항은 학생의 약점을 재지 못한다.
5. 표본이 부족하거나 판단 근거가 없으면 confidence 를 0.4 미만으로 준다. 지어내지 않는다.

## targeting_brief 작성 규칙 — 가장 중요한 출력

판정한 사유를 **다음 문항 생성기에 그대로 넘길 한국어 지시문**을 쓴다. 3~5문장.
문항 생성기는 학생의 오답 이력을 보지 못하고 이 브리프만 본다. 그러니 브리프에는 이렇게 쓴다.

- 이 학생이 무엇과 무엇을 혼동하는지 **구체적 이름으로** 적는다. ("감별을 어려워한다" X → "대동맥박리와 급성심근경색을 혼동한다" O)
- 새 문항에서 **오답 선지에 반드시 포함시킬 것**을 지정한다. 학생이 골랐던 그 선지를 매력적인 오답으로 다시 배치하게 한다.
- 정답과 그 오답을 가르는 **결정적 소견 하나**를 지문에 심으라고 지시한다.
- 사유별로 요구가 다르다:
  · differential_error → 학생이 골랐던 감별 대상을 오답에 넣고, 두 질환을 가르는 소견을 지문에 한 줄 넣게 한다.
  · test_interpretation → 검사 수치를 감별에 필요한 만큼 제시하고, 수치를 읽어야만 답이 갈리게 한다.
  · management_choice → 같은 질환의 다른 시점 처치들을 오답으로 늘어놓고 '지금 할 것'을 묻게 한다.
  · missed_cue → 결정적 조건(임신·콩팥기능·투약력 등)을 지문 중간에 눈에 띄지 않게 배치하고, 그 조건을 놓치면 골랐을 선지를 오답에 넣게 한다.
  · concept_gap → 난이도를 한 단계 낮추고 전형적 증례로 개념을 다시 세우되, 오답은 여전히 같은 질환군에서 고른다.
- **금지**: "어려운 문항을 내라", "심화 문항을 만들라" 같은 추상적 지시. 무엇을 어디에 넣으라고 써야 한다.

## 출력

analyze_wrong_answers 도구 호출로만 응답. 자유 텍스트 금지.
`.trim();

export interface WrongAttemptItem {
  stem: string;
  choices: string[];
  answerIndex: number;
  /** 학생이 실제로 고른 선지 인덱스 — 판정의 핵심 입력. */
  selectedIndex: number;
  explanation?: string | null;
  timeSpentSeconds?: number | null;
}

export function buildErrorAnalysisUserMessage(input: {
  subjectName: string;
  subTopicName: string;
  items: WrongAttemptItem[];
}): string {
  const body = input.items
    .map((item, i) => {
      const choices = item.choices
        .map((c, j) => {
          const marks = [
            j === item.answerIndex ? '정답' : null,
            j === item.selectedIndex ? '학생이 고름' : null,
          ].filter(Boolean);
          return `  ${j + 1}. ${c}${marks.length ? `  ← ${marks.join(' / ')}` : ''}`;
        })
        .join('\n');
      const time =
        typeof item.timeSpentSeconds === 'number'
          ? `\n풀이 시간: ${item.timeSpentSeconds}초`
          : '';
      const expl = item.explanation ? `\n해설: ${item.explanation}` : '';
      return `### 오답 ${i + 1}\n${item.stem}\n${choices}${time}${expl}`;
    })
    .join('\n\n');

  return `
아래는 한 학생이 **${input.subjectName} · ${input.subTopicName}** 에서 틀린 문항이다.
각 문항에 정답과 학생이 고른 선지를 표시해 두었다.

${body}

이 학생이 왜 틀리는지 판정하고, 그 사유를 겨냥한 문항을 만들 수 있도록 targeting_brief 를 작성하라.
analyze_wrong_answers 도구로 응답하라.
`.trim();
}

export const ERROR_ANALYSIS_TOOL_SCHEMA = {
  name: 'analyze_wrong_answers',
  description: '학생의 오답 사유를 분류하고 다음 문항 생성 지침을 반환합니다.',
  input_schema: {
    type: 'object',
    properties: {
      primary_reason: {
        type: 'string',
        enum: [...ERROR_REASONS],
        description: '가장 두드러진 오답 사유 하나',
      },
      secondary_reason: {
        type: 'string',
        enum: [...ERROR_REASONS],
        description: '두 번째로 두드러진 사유. 없으면 생략한다.',
      },
      confidence: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: '판정 확신도. 표본이 1건이거나 근거가 약하면 0.4 미만으로 준다.',
      },
      evidence: {
        type: 'string',
        description:
          '왜 그 사유로 판정했는지 한국어 2~3문장. 학생이 고른 선지를 반드시 인용한다.',
      },
      confusion_pairs: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            picked: { type: 'string', description: '학생이 고른 선지' },
            correct: { type: 'string', description: '정답 선지' },
            discriminator: {
              type: 'string',
              description: '둘을 가르는 결정적 소견 하나',
            },
          },
          required: ['picked', 'correct', 'discriminator'],
        },
        description: '학생이 혼동한 쌍. 다음 문항의 오답 배치에 그대로 쓴다.',
      },
      flawed_items: {
        type: 'array',
        items: { type: 'integer' },
        description:
          '문항 자체가 결함이라 약점 판정 근거로 쓸 수 없는 오답 번호(1-base). 없으면 빈 배열.',
      },
      targeting_brief: {
        type: 'string',
        description:
          '다음 문항 생성기에 그대로 넘길 한국어 지시문 3~5문장. 무엇을 오답에 넣고 어떤 소견을 지문에 심을지 구체적으로 쓴다.',
      },
    },
    required: ['primary_reason', 'confidence', 'evidence', 'targeting_brief'],
  },
} as const;
