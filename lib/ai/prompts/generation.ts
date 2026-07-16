/**
 * 문항 생성 시스템 프롬프트
 *
 * KMLE(한국 의사 국가시험) 스타일의 5지선다 문항을 생성한다.
 *
 * 핵심 제약:
 *  - 의학적 정확성을 환자 안전 기준으로 검증
 *  - KMLE 출제 가이드라인 + 표준 의학 교과서 기반
 *  - 기종평·임종평·내신 기출 데이터는 절대 사용 X (환각·표절 방지)
 *  - 위험 영역(약물 용량·금기·응급)은 더 보수적
 *
 * 시스템 프롬프트는 prompt caching 으로 토큰 비용을 줄인다.
 */

export const GENERATION_SYSTEM_PROMPT = `
You are a Korean medical education content specialist. Your task is to generate KMLE(한국 의사 국가시험)-style multiple-choice questions for Korean medical students.

## 절대 원칙 (Hard Constraints)

1. **의학적 정확성 최우선**: 모든 의학 정보는 표준 교과서(Harrison's, Robbins, Goodman & Gilman 등)와 대한의학회 임상 진료지침에 부합해야 한다.
2. **환자 안전 우선**: 약물 용량, 금기, 응급 처치 우선순위 등은 절대 부정확하게 작성하지 않는다. 확신이 없으면 보수적으로 작성한다.
3. **기종평·임종평 데이터 절대 사용 금지**: 학교 내부 평가 자료는 어떤 형태로도 참조하지 않는다.
4. **저작권 회피**: 특정 시험 문항을 그대로 복제하지 않는다. KMLE 기출은 스타일 참조용으로만 활용한다.
5. **한국어로 작성**: 의학 용어는 한국어 표준 용어를 사용하되 필요 시 영문 병기.

## KMLE 문항 포맷

- **임상 vignette**: 환자 나이·성별·주증상·과거력·활력징후·검사 결과를 임상적 상황으로 제시
- **이미지 활용 시**: CT, X-ray, ECG, Pathology slide 등의 판독 능력을 평가
- **5지선다**: 정확히 5개 선지, 1개 정답
- **질문 형태**: "가장 적절한 [진단·치료·검사]는?" 형식이 표준
- **선지 길이 균형**: 모든 선지가 비슷한 길이와 구체성을 가져야 함 (정답 단서 노출 방지)
- **함정 선지(distractor)**: 임상적으로 그럴듯하지만 정답이 아닌 선지를 포함

## 난이도 (1-3)

- **1 (易)**: 개념 확인 — 기본 정의·기전·표준 진단/치료
- **2 (中)**: 임상 적용 — 활력징후·검사 결과 종합 판단
- **3 (難)**: 감별 진단 — 미묘한 임상 차이로 감별, 함정 요소 포함

## 위험 영역 (Risk Category) 추가 제약

해당 sub_topic 이 위험 영역이면 더 보수적으로 작성:

- **약물 용량**: 표준 용량만 사용. mg/kg, 소아 용량은 보수적으로.
- **금기/부작용**: 명확히 표시된 표준 금기만 사용. 모호한 상호작용은 피함.
- **응급 처치 우선순위**: ACLS, ATLS 등 공식 가이드라인 순서 준수.
- **소아·임산부 처방**: 카테고리 A·B 약물 위주, 카테고리 D·X 는 명확한 금기 학습에만 사용.

## 해설 작성 가이드

- 정답이 왜 정답인지 의학적 근거 명시
- 다른 선지가 왜 오답인지 간단히 (감별 포인트)
- 참조 가이드라인 또는 교과서 출처 표기 시도

## 출력 형식

JSON 도구 호출로만 응답. 자유 텍스트 금지.
`.trim();

/**
 * 문항 생성용 사용자 메시지 빌더
 */
export function buildGenerationUserMessage(input: {
  subjectName: string;
  subTopicName: string;
  examRelevance: 1 | 2 | 3;
  isRiskCategory: boolean;
  difficulty: 1 | 2 | 3;
  style: 'kmle' | 'professor' | 'internal';
  examples?: Array<{ stem: string; choices: string[]; explanation: string }>;
  count: number;
}): string {
  const styleDesc =
    input.style === 'kmle'
      ? 'KMLE(국가고시) 스타일 — 표준 임상 vignette + 5지선다'
      : input.style === 'professor'
        ? '대학 교수 출제 스타일 — 강의 내용 기반, 개념 심화'
        : '내신 시험 스타일 — 학교 정기시험 수준';

  const fewShot = input.examples?.length
    ? `\n\n## 참고 예시 (스타일 학습용)\n\n${input.examples
        .map(
          (ex, i) => `### 예시 ${i + 1}
**문제**: ${ex.stem}
**선지**: ${ex.choices.map((c, j) => `${j + 1}. ${c}`).join(' / ')}
**해설**: ${ex.explanation}`,
        )
        .join('\n\n')}`
    : '';

  return `
다음 조건으로 ${input.count}개의 의학 문항을 생성하세요.

## 영역
- 과목: ${input.subjectName}
- Sub-topic: ${input.subTopicName}
- KMLE 빈출도: ${'★'.repeat(input.examRelevance)}
- 위험 영역 여부: ${input.isRiskCategory ? '★★★ 예 (보수적 작성 필수)' : '아니오'}
- 목표 난이도: ${input.difficulty} / 3

## 스타일
${styleDesc}
${fewShot}

## 요구사항
- ${input.count}개의 서로 다른 임상 시나리오 (환자 정보·검사 결과·증상 다양화)
- 같은 sub-topic이지만 평가 포인트가 겹치지 않도록
- 각 문항은 독립적으로 풀 수 있어야 함 (의존 관계 X)

generate_questions 도구로 응답하세요.
`.trim();
}

/**
 * Tool schema — 문항 생성의 구조화된 출력 강제
 */
export const GENERATION_TOOL_SCHEMA = {
  name: 'generate_questions',
  description: '의학 문항 배열을 생성하여 반환합니다.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            stem: {
              type: 'string',
              description: '문제 본문 (임상 vignette). 한국어, 200-500자 권장.',
            },
            choices: {
              type: 'array',
              items: { type: 'string' },
              minItems: 5,
              maxItems: 5,
              description: '5개의 선지. 각 선지는 비슷한 길이와 구체성을 가져야 함.',
            },
            answer_index: {
              type: 'integer',
              minimum: 0,
              maximum: 4,
              description: '정답 선지의 인덱스 (0-base).',
            },
            explanation: {
              type: 'string',
              description: '해설: 정답 근거 + 오답 감별 포인트. 한국어.',
            },
            concepts: {
              type: 'array',
              items: { type: 'string' },
              description:
                '다루는 의학 개념 태그 (예: ["COPD", "FEV1/FVC", "기관지확장제"])',
            },
            difficulty: {
              type: 'integer',
              minimum: 1,
              maximum: 3,
              description: '실제 난이도 (요청한 목표 난이도와 일치해야 함)',
            },
          },
          required: ['stem', 'choices', 'answer_index', 'explanation', 'concepts', 'difficulty'],
        },
      },
    },
    required: ['questions'],
  },
} as const;
