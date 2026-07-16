/**
 * 검증 (2-pass) 시스템 프롬프트
 *
 * Haiku 모델로 생성된 문항을 의학적 정확성 + 형식 측면에서 검수.
 * Sonnet 보다 저렴하면서 catch 가능한 오류:
 *  - 정답 인덱스 모순 (해설은 ①을 정답이라 하는데 answer_index 가 1)
 *  - 명백한 의학적 오류 (잘못된 약물 용량, 모순된 검사 결과)
 *  - 선지 길이 불균형 (정답 단서 노출)
 *  - 형식 위반 (5지선다 아님, 중복 선지 등)
 *
 * Catch 불가 (사람·교수 검수 필요):
 *  - 미묘한 의학적 부정확성
 *  - 최신 가이드라인 반영 누락
 *  - 임상적 흔치 않은 예외 사례
 */

export const VERIFICATION_SYSTEM_PROMPT = `
You are a Korean medical content reviewer. Your task is to verify generated medical multiple-choice questions for accuracy and format compliance.

## 검수 체크리스트

각 문항에 대해 다음을 확인:

### 1. 의학적 정확성 (Critical)
- 임상 시나리오의 활력징후·검사 결과가 진단과 일치하는가?
- 약물·용량이 표준 가이드라인에 부합하는가?
- 응급 처치 우선순위가 ACLS/ATLS 등 공식 순서와 일치하는가?
- 정답이 진짜 정답인가? (해설과 모순 없음)

### 2. 내부 일관성
- answer_index 와 explanation 이 일치하는가?
- 선지 간 의미 중복이 없는가?
- 임상 정보가 자기모순적이지 않은가?

### 3. 형식
- 정확히 5개 선지인가?
- 선지 길이가 비슷한가? (정답 단서 노출 방지)
- 한국어 의학 용어가 표준에 부합하는가?

### 4. 위험 영역 추가 점검 (해당 시)
- 약물 용량이 안전 범위 내인가?
- 금기 사항이 정확히 명시되어 있는가?
- 소아·임산부 카테고리가 올바른가?

## 판정 기준

- **passed: true** + score > 0.85 → 풀에 즉시 admission
- **passed: true** + score 0.6~0.85 → 사람 검수 큐로
- **passed: false** + score < 0.6 → reject, 재생성 권장

## 출력

verify_question 도구로만 응답. 자유 텍스트 금지.
`.trim();

export function buildVerificationUserMessage(input: {
  subjectName: string;
  subTopicName: string;
  isRiskCategory: boolean;
  question: {
    stem: string;
    choices: string[];
    answer_index: number;
    explanation: string;
  };
}): string {
  return `
다음 문항을 검수하세요.

## 컨텍스트
- 과목: ${input.subjectName}
- Sub-topic: ${input.subTopicName}
- 위험 영역: ${input.isRiskCategory ? '예 (보수적 검수)' : '아니오'}

## 문항
**문제**: ${input.question.stem}

**선지**:
${input.question.choices.map((c, i) => `${i + 1}. ${c}`).join('\n')}

**모델이 표시한 정답**: ${input.question.answer_index + 1}번

**해설**: ${input.question.explanation}

verify_question 도구로 응답하세요.
`.trim();
}

export const VERIFICATION_TOOL_SCHEMA = {
  name: 'verify_question',
  description: '문항 검수 결과를 반환합니다.',
  input_schema: {
    type: 'object',
    properties: {
      passed: {
        type: 'boolean',
        description: '풀에 admission 가능한지 여부',
      },
      score: {
        type: 'number',
        minimum: 0,
        maximum: 1,
        description: '0~1 사이의 품질 점수. > 0.85 자동 admission, 0.6~0.85 사람 검수, < 0.6 reject',
      },
      issues: {
        type: 'array',
        items: { type: 'string' },
        description: '발견된 문제점 목록. 없으면 빈 배열.',
      },
      suggested_fixes: {
        type: 'array',
        items: { type: 'string' },
        description: '권장 수정사항. 자동 재생성 시 참고용.',
      },
      severity: {
        type: 'string',
        enum: ['none', 'minor', 'major', 'critical'],
        description: 'critical = 환자 안전 위험, major = 의학적 부정확, minor = 형식·표현, none = 통과',
      },
    },
    required: ['passed', 'score', 'issues', 'severity'],
  },
} as const;
