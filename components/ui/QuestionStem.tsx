/**
 * 문항 발문 렌더러.
 *
 * 조합형 문항("옳은 것을 모두 고른 것은?" + ㄱ/ㄴ/ㄷ 보기)에서 보기 항목이 한 줄로
 * 뭉쳐 보이는 문제를 해결한다. 생성 결과에는 이미 `\nㄱ. …\nㄴ. …` 처럼 줄바꿈이
 * 들어 있지만, 일반 div/p 로 렌더하면 HTML 이 줄바꿈을 공백으로 합쳐버린다.
 *
 * 규칙(사용자 요구):
 *  - ㄱ/ㄴ/ㄷ 보기는 각각 자기 줄에 표시한다.
 *  - 박스(테두리)는 만들지 않는다. 줄 구분과 표식 정렬만으로 구분한다.
 */

export interface StemParts {
  /** 보기 앞의 발문 본문. */
  lead: string;
  /** ㄱ/ㄴ/ㄷ 보기 항목. 조합형이 아니면 빈 배열. */
  items: { marker: string; text: string }[];
  /** 보기 뒤에 남은 문장(있는 경우). */
  tail: string;
}

/** 보기 표식: 줄머리/공백/괄호 뒤의 자모 1개 + `.` 또는 `)`. */
const ITEM_MARKER_RE = /(?:^|[\s(])([ㄱ-ㅎ])\s*[.)]\s*/g;

/**
 * 발문을 (본문 / ㄱㄴㄷ 보기 / 꼬리) 로 분해한다.
 * 표식이 2개 미만이면 조합형으로 보지 않는다(본문에 자모가 한 번 등장하는 경우 오탐 방지).
 */
export function splitStemItems(raw: string): StemParts {
  const text = String(raw ?? '');
  const hits: { marker: string; markerAt: number; contentAt: number }[] = [];
  ITEM_MARKER_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ITEM_MARKER_RE.exec(text)) !== null) {
    const markerAt = m.index + m[0].indexOf(m[1]);
    hits.push({ marker: m[1], markerAt, contentAt: m.index + m[0].length });
    // 표식이 붙어 있는 경우에도 다음 표식을 놓치지 않도록 커서를 되돌린다.
    ITEM_MARKER_RE.lastIndex = m.index + m[0].length;
  }
  if (hits.length < 2) return { lead: text.trim(), items: [], tail: '' };

  const lead = text.slice(0, hits[0].markerAt).trim();
  const items: { marker: string; text: string }[] = [];
  let tail = '';
  hits.forEach((hit, i) => {
    const end = i + 1 < hits.length ? hits[i + 1].markerAt : text.length;
    const body = text.slice(hit.contentAt, end);
    // 보기는 줄 단위로 생성되므로, 항목 안의 줄바꿈 이후는 보기가 아니라 뒤따르는 문장이다.
    const br = body.indexOf('\n');
    if (br >= 0) {
      items.push({ marker: hit.marker, text: body.slice(0, br).trim() });
      const rest = body.slice(br).trim();
      if (rest) tail = tail ? `${tail}\n${rest}` : rest;
    } else {
      items.push({ marker: hit.marker, text: body.trim() });
    }
  });
  return { lead, items, tail: tail.trim() };
}

export function QuestionStem({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const { lead, items, tail } = splitStemItems(text);

  if (items.length === 0) {
    // 조합형이 아니면 원문 그대로. 발문 안의 다른 줄바꿈도 살린다.
    return <div className={className} style={{ whiteSpace: 'pre-line' }}>{lead}</div>;
  }

  return (
    <div className={className}>
      {lead && <div style={{ whiteSpace: 'pre-line' }}>{lead}</div>}
      {/* 박스 없이 줄 구분 + 표식 정렬(행잉 인덴트) */}
      <div className="mt-2 mb-1 space-y-1">
        {items.map((item, i) => (
          <div key={`${item.marker}-${i}`} className="flex gap-2">
            <span className="shrink-0 font-semibold tabular-nums">{item.marker}.</span>
            <span className="flex-1">{item.text}</span>
          </div>
        ))}
      </div>
      {tail && <div style={{ whiteSpace: 'pre-line' }}>{tail}</div>}
    </div>
  );
}
