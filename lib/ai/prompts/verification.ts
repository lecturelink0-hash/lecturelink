/**
 * 검증 (2-pass) 시스템 프롬프트
 *
 * Haiku 모델로 생성된 문항을 의학적 정확성 + 형식 측면에서 검수.
 * Sonnet 보다 저렴하면서 catch 가능한 오류:
 *  - 정답 인덱스 모순 (해설은 ①을 정답이라 하는데 answer_index 가 1)
 *  - 명백한 의학적 오류 (잘못된 약물 용량, 모순된 검사 결과)
 *  - 국시 형식 위반 (발문 형태, 활력징후 서식, 영문 약어 잔존 등 — F 규격)
 *  - 오답이 임상적으로 그럴듯하지 않음 (상식만으로 정답이 소거되는 문항)
 *
 * 결정론적으로 판정 가능한 형식(선지 수·정렬·종결형)은 이 모델에 맡기지 않고
 * lib/ai/kmle-format.ts 에서 코드로 교정·검사한 뒤 넘어온다.
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
- **발병 시각과 검사값이 정합하는가?** 염증표지자·효소·혈색소는 오르는 속도가 다르다.
  (예: 아세트아미노펜 복용 8시간째 간효소 2,000대, 천공 4시간째 C반응단백질 60 초과는 성립하지 않는다)
- **해설의 배제 논리가 검사 하나에 걸려 있지 않은가?** 영상 음성으로 전이를 지우거나 종양표지자 정상으로 암을 지우면 위험하다.

### 3. 국시 형식 (F 규격)
- 지문이 "[N]세 [남자/여자]가 ... 병원에 왔다."로 시작하는가? ("남성" "여성" "내원하였다"는 위반)
- 활력징후가 혈압 → 맥박 → 호흡 → 체온 순서인가? ("활력징후:" 라벨은 위반)
- 검사 수치 블록 앞에 "검사 결과는 다음과 같다."가 있는가?
- 검사명과 선지가 한글 표준용어인가? (AST·CRP·BUN·UTI 같은 영문 약어 단독 사용은 위반)
- 발문이 "진단은?" "치료는?" "검사는?" "처치는?" 같은 짧은 명사구인가?
  ("가장 적절한", "다음 중", "~은 무엇인가?", "접근은?", "평가 원칙은?"은 위반)
- 정확히 5개 선지인가?
- 선지가 **글자 수 짧은 것부터 오름차순**으로 배열돼 있는가? (길이가 비슷할 필요는 없다)
- 선지 종결형이 5개 모두 통일돼 있는가? (명사구면 마침표 없음. 명사구와 문장형을 섞으면 위반)

### 3-1. 오답 타당성 (가장 중요)
- 오답 4개가 **그 임상 상황에서 실제로 감별해야 하는 것**인가?
- 다음이 하나라도 있으면 **major** 로 판정한다:
  - 단정 부정문 ("~은 절대 없다", "~는 불가능하다", "~와 무관하다")
  - 의료행위로 성립하지 않는 선지 ("소변배양을 폐기한다", "검사 없이 항생제를 준다")
  - 태도 부정문 ("확인하지 않는다", "전혀 묻지 않는다")
- **의학 지식 없이 상식만으로 정답을 고를 수 있으면 문항으로서 실패다.** major 로 판정한다.

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


// ─────────────────────────────────────────────────────────────
// 내신대비(개인 자료 기반) 전용 검증 모드
// ─────────────────────────────────────────────────────────────

/**
 * 'private' 모드 시스템 프롬프트.
 *
 * 왜 따로 두는가: 위 공유풀 프롬프트는 절반이 F 규격(발문 문형·선지 정렬·용어 표기)이다.
 * 내신대비 문항은 학생이 올린 강의자료를 그대로 따르므로 그 형식을 강요할 수 없고,
 * 형식은 코드(kmle-format.ts·clinical-shape.ts)가 이미 결정론적으로 검사한다.
 * 여기에 형식을 섞으면 모델이 형식 지적으로 issues 를 채우고 **정작 의학 오류를 놓친다**.
 *
 * 그래서 판정 대상을 네 가지로 좁힌다. 감사에서 실제로 통과해 나간 해설
 * "도파민은 억제성 신경전달물질로 운동 조절에 관여하며"가 이 모드의 표적이다.
 */
export const PRIVATE_VERIFICATION_SYSTEM_PROMPT = `
당신은 한국 의과대학 강의자료로 만든 객관식 문항을 검수하는 의학 검수자입니다.

## 판정 대상은 네 가지뿐입니다

### 1. 의학적 오류 — critical 또는 major
기전·정의·분류·수치·약물·용량·검사 해석이 사실과 다른가.
(예: "도파민은 억제성 신경전달물질" → 도파민은 억제성이 아니다. major.)
환자 안전에 직결되는 오류(용량·금기·응급 처치 순서)는 critical.

### 2. 정답과 해설의 불일치 — critical
해설이 정당화하는 선지와 표시된 정답 번호가 다른가.
해설이 정답을 전혀 정당화하지 못하는가.

### 3. 정답 근거가 자료에 없음 — major
아래 "자료 원문"에 정답의 근거가 없는가.
**단, 자료는 앞부분만 잘려 들어올 수 있습니다.** 근거가 뒤쪽에 있을 가능성이 조금이라도
있으면 지적하지 마십시오. 자료에 없다고 **확신할 때만** 지적합니다.
자료 원문이 제공되지 않았다면 이 항목은 판정하지 않습니다.

### 4. 해설이 오답 사유를 다루지 않음 — minor
왜 나머지 선지가 틀렸는지 한 줄도 없는가.

## 판정하지 않는 것 (매우 중요)

다음은 **절대 지적하지 마십시오.** 지적하면 이 검수는 실패로 간주합니다.
- 발문 문형("가장 적절한 것은?", "다음 중", "무엇인가")
- 선지 길이·정렬·종결형·개수
- "남자/여자" vs "남성/여성", "병원에 왔다" vs "내원하였다" 같은 표기
- 활력징후 서식, 영문 약어 병기, 국시 형식 일반
- 문체·어미·분량

이것들은 코드가 따로 검사해 교정합니다. 당신의 몫은 **내용이 맞는가** 하나입니다.

## severity 기준
- critical = 환자 안전 위험 또는 정답-해설 모순
- major    = 의학적으로 틀림, 또는 정답 근거가 자료에 없음(확신할 때)
- minor    = 해설이 오답 사유를 안 다룸
- none     = 위 넷 중 아무것도 없음

## score
0~1. 내용이 정확하고 해설이 정답과 오답을 모두 설명하면 0.9 이상.
의학적으로 틀린 곳이 있으면 0.5 미만.

verify_question 도구로만 응답하십시오. 자유 텍스트 금지.
`.trim();

/** private 모드에서 정답 근거 대조에 쓰는 자료 원문 상한(자). 비용 때문에 앞부분만 싣는다. */
export const PRIVATE_VERIFICATION_SOURCE_CHARS = 12_000;

export function buildPrivateVerificationUserMessage(input: {
  question: {
    stem: string;
    choices: string[];
    answer_index: number;
    explanation: string;
  };
  sourceText?: string;
}): string {
  const source = (input.sourceText ?? '').slice(0, PRIVATE_VERIFICATION_SOURCE_CHARS).trim();
  const sourceBlock = source
    ? `## 자료 원문 (앞부분만 — 여기 없다고 근거가 없다고 단정하지 말 것)\n${source}\n\n`
    : '## 자료 원문\n제공되지 않음 — 3번 항목(자료 근거)은 판정하지 마십시오.\n\n';

  return `
다음 문항을 검수하세요.

${sourceBlock}## 문항
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
