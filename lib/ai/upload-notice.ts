/**
 * 생성 결과에서 **사용자에게 알려야 할 사실**만 골라 담는다 (P8).
 *
 * 왜 필요한가 (2026-08-18 감사 · 2026-08-19 실측)
 * ────────────────────────────────────────────
 * 생성기는 warnings 를 49곳에서 push 하지만 전부 `ai_cost_log.metadata` 의 진단 JSON 에만
 * 남는다. 사용자는 무엇이 어긋났는지 모른 채 "완성됐어요"를 본다. 실제로 벌어진 일:
 *
 *  - 10문항을 요청했는데 8문항만 저장됐다(누출 폐기 2건 + 보충 2회가 Gemini 429 로 실패).
 *    화면에는 문항 수만 적혀 있고 **왜 모자란지는 어디에도 없었다.**
 *  - 이미지형을 골랐는데 자료에 쓸 만한 그림이 없으면 조용히 텍스트 문항으로 대체된다.
 *  - 본문이 15만 자를 넘으면 뒷부분이 출제 근거에서 잘리는데 아무 표시가 없다.
 *
 * 왜 문자열 태깅이 아니라 사실 조립인가
 * ──────────────────────────────────
 * warnings 문자열에 `user:` 접두를 붙이는 방식도 생각했지만, 문구는 리팩터마다 바뀌고
 * 새 경고가 추가될 때 태그를 빠뜨리면 조용히 사라진다. 대신 **완료 시점에 이미 확정된
 * 사실**(저장 수, 이미지 장수, 절삭 길이, 폐기 카운터, 배치 실패 사유)에서 조립한다.
 * 같은 이유로 P2 의 계측도 문자열이 아니라 카운터에서 뽑는다.
 *
 * 무엇을 넣지 않는가
 * ────────────────
 * **의학 검증(P1) 플래그는 넣지 않는다.** 현재 warn 모드의 플래그율이 50 %이고 그중
 * 자가당착 판정(오탐)이 이미 확인됐다 — "검토가 필요한 문항 N개"를 띄우면 멀쩡한 문항까지
 * 의심하게 만들어 신뢰를 깎는다. 사람 검토로 오탐률을 낮춘 뒤에 다시 판단한다.
 */

/** 사용자에게 보여줄 알림 코드. 화면 문구는 클라이언트가 이 코드로 만든다. */
export type UploadNoticeCode =
  /** 요청한 문항 수를 채우지 못했다. */
  | 'shortfall'
  /** 이미지형을 골랐지만 쓸 수 있는 의료 이미지가 없어 텍스트 문항으로 만들었다. */
  | 'no_image'
  /** 본문이 상한을 넘어 앞부분만 출제 근거로 썼다. */
  | 'text_truncated'
  /** 참고 자료 중 형식을 읽지 못해 반영하지 못한 것이 있다. */
  | 'reference_ignored'
  /** 일시적 오류(요청 한도·API 오류)로 일부 묶음을 만들지 못했다. */
  | 'transient_error';

export interface UploadNotice {
  code: UploadNoticeCode;
  /** 관련 개수(문항 수·파일 수 등). 0 이면 생략. */
  count?: number;
  /** 사용자에게 보여도 되는 짧은 부연(원인 등). 내부 스택·키는 넣지 않는다. */
  detail?: string;
}

export interface BuildNoticeInput {
  desiredCount: number;
  savedCount: number;
  /** 사용자가 '이미지형'을 골랐는지. */
  wantsImages: boolean;
  /** 실제로 문항에 쓸 수 있게 확보된 이미지 장수. */
  featuredImageCount: number;
  /** 상한을 넘겨 잘라낸 본문 글자 수(0 이면 절삭 없음). */
  truncatedChars: number;
  /** 형식을 읽지 못해 무시한 참고 자료 수. */
  referenceSkipped: number;
  /** 배치 실패 사유 원문(사용자에게 그대로 보여주지 않는다 — 분류에만 쓴다). */
  batchFailureReasons: string[];
  /** 정답 길이 누출로 폐기된 문항 수. */
  leakageDiscarded: number;
  /** 검증 폐기 수(discard 모드에서만 0 이 아니다). */
  verifyRejected: number;
}

/** 사용자에게 노출해도 되는 수준으로 실패 사유를 뭉뚱그린다. */
function classifyFailure(reasons: string[]): 'rate_limit' | 'api_error' | null {
  if (reasons.length === 0) return null;
  const joined = reasons.join(' ');
  if (/429|quota|rate limit|exceeded your current quota/i.test(joined)) return 'rate_limit';
  return 'api_error';
}

/**
 * 완료 시점의 사실에서 사용자 알림을 만든다. 알릴 것이 없으면 빈 배열.
 *
 * 부족분의 사유는 겹칠 수 있으므로(누출 폐기 + 429) 가장 큰 원인 하나만 detail 에 담는다 —
 * 여러 줄로 늘어놓으면 사용자가 읽지 않는다.
 */
export function buildUploadNotices(input: BuildNoticeInput): UploadNotice[] {
  const notices: UploadNotice[] = [];

  if (input.savedCount < input.desiredCount) {
    const missing = input.desiredCount - input.savedCount;
    const failure = classifyFailure(input.batchFailureReasons);
    const detail =
      failure === 'rate_limit'
        ? '요청이 한꺼번에 몰려 일부 묶음을 만들지 못했어요. 잠시 후 다시 생성하면 채워집니다.'
        : failure === 'api_error'
          ? '생성 중 일시적인 오류가 있었어요. 다시 생성하면 채워집니다.'
          : input.leakageDiscarded + input.verifyRejected > 0
            // "검토가 필요한 문항"처럼 검증을 연상시키는 말은 쓰지 않는다 — 학생이 받은
            // 문항까지 의심하게 만든다(검증 플래그 미노출 결정). 걸러낸 사실만 담담히 적는다.
            ? '정답이 드러나거나 품질 기준에 못 미친 문항을 걸러내면서 수가 줄었어요.'
            : undefined;
    notices.push({ code: 'shortfall', count: missing, detail });
  }

  if (input.wantsImages && input.featuredImageCount === 0) {
    notices.push({
      code: 'no_image',
      detail: '자료에서 문항에 쓸 만한 의료 이미지를 찾지 못해 텍스트 문항으로 만들었어요.',
    });
  }

  if (input.truncatedChars > 0) {
    notices.push({
      code: 'text_truncated',
      count: input.truncatedChars,
      detail: '자료가 길어 앞부분을 중심으로 출제했어요.',
    });
  }

  if (input.referenceSkipped > 0) {
    notices.push({
      code: 'reference_ignored',
      count: input.referenceSkipped,
      detail: 'PDF·이미지 형식의 참고 자료만 형식 참고에 반영돼요.',
    });
  }

  // 부족분이 없어도 배치가 실패했다면(보충이 메꾼 경우) 알려 준다 — 다음 생성이 느릴 수 있다.
  if (input.savedCount >= input.desiredCount && input.batchFailureReasons.length > 0) {
    const failure = classifyFailure(input.batchFailureReasons);
    notices.push({
      code: 'transient_error',
      count: input.batchFailureReasons.length,
      detail:
        failure === 'rate_limit'
          ? '요청이 몰려 일부 묶음을 다시 만들었어요.'
          : '생성 중 일시적인 오류가 있었지만 요청한 문항 수는 채웠어요.',
    });
  }

  return notices;
}
