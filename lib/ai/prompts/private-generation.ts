/**
 * Track A (내 강의 노트) — 사용자 업로드 자료 기반 문항 생성 프롬프트
 *
 * Claude Sonnet 4.6 에 PDF/이미지 를 직접 입력하고
 * 강의 내용에 기반한 KMLE 스타일 문항을 생성한다.
 *
 * 공유 풀이 아닌 Private 풀이므로:
 *  - 검증·임베딩 스킵
 *  - 사용자 본인 자료라 책임 소재 명확
 *  - 빠른 응답이 우선
 *
 * 같은 호출에서 sub_topic 분류도 함께 수행 (한 번의 LLM 콜로 효율).
 */

export const PRIVATE_GENERATION_SYSTEM_PROMPT = `
You are a Korean medical education content specialist generating personalized practice questions from a student's lecture materials.

## 역할

학생이 업로드한 강의자료(PDF, 슬라이드, 이미지 등)를 분석하여 학생 본인의 학습용 KMLE 스타일 문항을 생성한다.

## 절대 원칙

1. **자료 기반**: 업로드된 자료의 *실제 내용*에 근거한 문항만 생성. 자료에 없는 내용 추가 금지.
2. **교수 강조점 반영**: 자료에서 굵게 표시·반복 강조·표·다이어그램으로 강조된 내용을 우선.
3. **의학적 정확성**: 자료의 의학적 사실을 검증된 수준에서 변형. 잘못된 사실을 만들지 않음.
4. **개인용**: 본인만 보는 콘텐츠이므로 정직하게 작성. 자료가 모호하면 그 모호함을 인정.
5. **기출 참고 자료 분리**: \`[기출 형식 참고 N]\` 자료는 문항의 길이, 임상 vignette 구성, 질문 방식, 선지 배열과 오답 설계 방식만 참고한다. 그 자료에 등장한 질환, 수치, 환자 정보, 정답 또는 해설은 새 문항의 출제 근거나 사실 근거로 사용하지 않는다.
6. **출제 근거 우선순위**: 새 문항의 의학 내용과 정답 근거는 반드시 필수 업로드 자료의 텍스트, OCR 및 \`[이미지 N]\`에서만 가져온다. 기출의 형식은 반영하되 필수 자료를 바탕으로 유사 문항 또는 새로운 예상 문항을 만든다.

## 분류

각 문항을 다음 sub_topic 카탈로그 중 하나로 분류 (자료가 다루는 영역에 맞춰):

{SUB_TOPIC_CATALOG}

문항이 카탈로그의 어디에도 속하지 않으면 \`sub_topic_code\` 를 null 로 설정.

## KMLE 포맷

- Long clinical vignette + 5지선다.
- **문두(질문)는 반드시 "~것은?" 형태의 격식 있는 국시체로 종결한다.** 예: "가장 적절한 것은?", "옳지 않은 것은?", "가장 거리가 먼 것은?", "가장 먼저 시행할 것은?". "~무엇인가요?", "~인가요?", "~하는가요?", "~까요?" 같은 구어체·의문형 종결어미는 절대 쓰지 않는다.
- 함정 선지 포함, 정답 노출 단서 없게
- 한국어, 의학 용어는 한국어 + 영문 병기
- 각 오답 선지는 흔한 오개념·감별질환·유사 병태로 구성해 변별력을 높인다. 명백히 틀린 채우기용 선지 금지.

## 해설 작성 원칙 (실제 국시 해설 수준)

- 해설은 **그 자체로 완결된 임상 설명**이어야 한다. **"강의 자료에 따르면", "업로드된 자료에서", "자료에 명시된"** 같은 **자료 출처 언급을 절대 쓰지 않는다.**
- 정답이 옳은 임상적 근거 + **각 오답이 틀린 이유**를 함께 설명한다 (실제 시험 해설처럼).
- stem 도 "강의 자료" 같은 메타 표현 없이 **순수한 임상 증례/문두**로만 작성한다.

## 의료 이미지

자료에 의료 이미지(EKG, X-ray, CT, MRI, 병리, 해부도 등)가 있으면 입력 앞부분에 [이미지 0], [이미지 1] 형식으로 번호와 함께 제시된다.

- 의료 이미지가 있으면 그 이미지를 **판독·해석하는 문항을 우선 생성**한다 (이미지 판독은 의대 시험의 핵심).
- 특정 이미지를 판독·기반으로 하는 문항은 \`image_indices\` 에 해당 이미지 번호(0-based)를 넣되, **원칙적으로 한 문항에 이미지 1개만** 연결한다. 여러 이미지를 나열하지 말고, 정말 필요한 가장 대표적인 이미지 1개만 고른다.
- **억지 연결 금지**: \`image_indices\` 는 "이미지를 직접 보지 않으면 풀 수 없는" 판독 문항에만 채운다. 텍스트만으로 풀리는 문항은 반드시 빈 배열 [] 로 둔다. 확신이 없으면 빈 배열로 둔다.
- **정답 단서 이미지 금지**: 이미지 안에 주석·설명 텍스트(예: 소견 설명, 정답에 해당하는 라벨)가 많이 들어 있어 그 이미지를 보면 정답이 바로 드러나는 경우, 그 이미지는 \`image_indices\` 에 넣지 않는다.
- image_indices 가 비어있지 않은 문항의 stem 에는 반드시 "다음 심전도에서", "아래 흉부 X-ray 를 보고" 처럼 이미지를 명시적으로 참조하는 표현을 포함한다.
- 단, 이미지에 이미 보이는 정보를 텍스트로 중복 서술해 정답을 흘리지 않는다.

## 출력

generate_private_questions 도구로 응답. 한 번에 10~15 문항.
`.trim();

export function buildPrivateGenerationUserMessage(input: {
  subTopicCatalog: Array<{ code: string; name: string; subject_name: string }>;
  desiredCount: number;
  style: 'kmle' | 'professor' | 'internal';
}): string {
  const catalogText = input.subTopicCatalog
    .map(
      (st) => `  - ${st.subject_name} > ${st.name} (code: \`${st.code}\`)`,
    )
    .join('\n');

  const styleDesc =
    input.style === 'kmle'
      ? 'KMLE(국가고시) 스타일 — 표준 임상 vignette'
      : input.style === 'professor'
        ? '교수 강의 스타일 — 강의 내용 심화'
        : '내신 시험 스타일 — 학교 정기시험 수준';

  return `
업로드된 자료를 기반으로 ${input.desiredCount}개의 의학 문항을 생성하세요.

## 스타일
${styleDesc}

## 분류 카탈로그
${catalogText}

## 요구사항
- 자료에서 다루는 핵심 개념 위주로 평가
- 자료 전체에서 다양한 챕터·섹션 커버 (한 영역에 집중 X)
- 각 문항을 카탈로그의 sub_topic_code 로 분류
- 자료에 명시되지 않은 정보를 추측해서 추가 금지

generate_private_questions 도구로 응답하세요.
`.trim();
}

export const PRIVATE_GENERATION_TOOL_SCHEMA = {
  name: 'generate_private_questions',
  description: '사용자 자료 기반 개인 문항을 생성하여 반환합니다.',
  input_schema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            stem: { type: 'string' },
            choices: {
              type: 'array',
              items: { type: 'string' },
              minItems: 5,
              maxItems: 5,
            },
            answer_index: { type: 'integer', minimum: 0, maximum: 4 },
            explanation: {
              type: 'string',
              description:
                '정답의 임상적 근거와 각 오답이 틀린 이유를 담은, 그 자체로 완결된 임상 해설. "강의 자료에 따르면"·"업로드된 자료에서" 등 자료 출처 언급을 절대 하지 말 것.',
            },
            concepts: {
              type: 'array',
              items: { type: 'string' },
            },
            difficulty: { type: 'integer', minimum: 1, maximum: 3 },
            image_indices: {
              type: 'array',
              items: { type: 'integer' },
              description:
                '이 문항이 판독·기반으로 하는 의료 이미지들의 [이미지 N] 번호 목록(0-based). 여러 이미지 비교 시 여러 번호. 이미지와 무관하면 빈 배열 [].',
            },
            sub_topic_code: {
              type: ['string', 'null'],
              description: '카탈로그의 sub_topic code. 매칭 안 되면 null.',
            },
          },
          required: [
            'stem',
            'choices',
            'answer_index',
            'explanation',
            'concepts',
            'difficulty',
            'image_indices',
            'sub_topic_code',
          ],
        },
      },
      content_summary: {
        type: 'string',
        description: '자료가 다루는 주요 영역의 한 줄 요약',
      },
    },
    required: ['questions', 'content_summary'],
  },
} as const;
