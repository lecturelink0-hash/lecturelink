/**
 * 메타데이터 태깅 시스템 프롬프트
 *
 * 생성된 문항에서 검색·추천에 사용할 메타데이터를 추출.
 * Haiku 모델 사용 (저렴, 빠름).
 *
 * 출력:
 *  - concepts[]: 의학 개념 태그 (다음 약점 매칭용)
 *  - exam_relevance: KMLE 빈출도 (1-3)
 *  - image_dependency: 이미지가 필수인지 (실수로 텍스트만으로 풀 수 있는지 체크)
 */

export const TAGGING_SYSTEM_PROMPT = `
You are a Korean medical content metadata tagger.

생성된 문항을 분석하여 검색·추천에 사용할 태그를 추출하세요.

## 태그 가이드

### concepts (의학 개념 태그)
- 3~8개의 태그 추출
- 영문 또는 한국어 약자 우선 (검색 효율)
- 예: ["COPD", "FEV1/FVC", "GOLD", "기관지확장제", "ICS"]
- 너무 일반적인 태그 지양 ("질환", "검사" 등)

### exam_relevance (KMLE 빈출도)
- 1: 드물게 출제, 개념 학습 위주
- 2: 자주 출제, 표준 영역
- 3: 매년 출제, 빈출 영역

### image_dependency
- "required": 이미지가 없으면 풀 수 없음 (ECG·X-ray 판독 문항)
- "helpful": 이미지가 있으면 도움되나 텍스트만으로도 풀이 가능
- "none": 이미지 없이 풀이 가능

### clinical_setting
- 임상 시나리오의 배경 (예: "응급실", "외래", "병동", "수술실", "ICU")
- 추후 시나리오별 검색에 활용

tag_question 도구로 응답하세요.
`.trim();

export function buildTaggingUserMessage(input: {
  subjectName: string;
  subTopicName: string;
  question: {
    stem: string;
    choices: string[];
    answer_index: number;
    explanation: string;
  };
}): string {
  return `
다음 문항의 메타데이터를 추출하세요.

## 컨텍스트
- 과목: ${input.subjectName}
- Sub-topic: ${input.subTopicName}

## 문항
**문제**: ${input.question.stem}

**선지**:
${input.question.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

**정답**: ${input.question.answer_index + 1}번
**해설**: ${input.question.explanation}
`.trim();
}

export const TAGGING_TOOL_SCHEMA = {
  name: 'tag_question',
  description: '문항 메타데이터를 반환합니다.',
  input_schema: {
    type: 'object',
    properties: {
      concepts: {
        type: 'array',
        items: { type: 'string' },
        minItems: 3,
        maxItems: 8,
      },
      exam_relevance: {
        type: 'integer',
        minimum: 1,
        maximum: 3,
      },
      image_dependency: {
        type: 'string',
        enum: ['required', 'helpful', 'none'],
      },
      clinical_setting: {
        type: 'string',
        description: '임상 배경 (응급실, 외래, 병동 등)',
      },
    },
    required: ['concepts', 'exam_relevance', 'image_dependency'],
  },
} as const;
