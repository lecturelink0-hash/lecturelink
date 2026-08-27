/**
 * 발문이 말하는 검사 종류 ↔ 실제로 붙은 이미지 종류의 정합 판정 — 순수 함수만 둔다
 * (figure-stem.ts 와 같은 잎 모듈 규칙, import 없음). 회귀 검사 `npm run check:modality`.
 *
 * 왜 잎 모듈로 뺐는가 (2026-08-27 실측, 업로드 effbfdf0 슬롯 7)
 * ──────────────────────────────────────────────────────────
 * 발문 "흉부 X-ray와 MR 영상에서 보이는 대동맥 병변의 진단은?" 에 MRI 크롭이 붙어 있었다.
 * 종전 MRI 패턴은 `\bMRI\b` 뿐이라 **"MR 영상"을 못 읽었다** → 발문이 언급한 검사는
 * X-ray 하나로 판정 → 붙은 그림(mri)과 "불일치" → 이미지 연결 해제. 그 결과 그림 없는
 * 문항이 학생에게 나갔다. private-generation.ts 안에 있어 스크립트가 못 불러 회귀 검사가
 * 없었고, 어휘 구멍이 그대로 운영에 갔다.
 */

/** 판독 대상이 되는 실제 임상 검사 유형. 발문-이미지 정합성 판단의 기준. */
export const CLINICAL_IMAGE_KINDS: ReadonlySet<string> = new Set([
  'xray', 'ct', 'mri', 'ecg', 'pathology', 'microscope', 'ultrasound',
]);

/**
 * 발문에서 검사 종류를 읽는 어휘. 여러 개를 언급할 수 있으므로 전부 모은다.
 *
 * 어휘는 **넓게** 잡는다 — 여기서 못 읽으면 멀쩡한 그림이 "불일치"로 떨어져 나가고,
 * 그 대가는 학생이 못 푸는 문항이다. 반대로 과하게 읽어도 대가는 "그림이 하나 더 붙는 것"뿐이다.
 * JS 의 `\b` 는 ASCII 단어 경계라 한글 앞뒤에서는 항상 경계가 성립한다("MR영상"도 잡힌다).
 */
export const STEM_MODALITY_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  [
    'xray',
    /X-?ray|X-?선|엑스레이|엑스선|단순\s*(?:방사선|촬영|X선)|흉부\s*(?:방사선|단순촬영)|\bCXR\b|\bKUB\b/i,
  ],
  ['ct', /\bCT\b|\bCTA\b|전산화\s*단층|컴퓨터\s*단층|\bcomputed\s+tomography\b/i],
  [
    'mri',
    /\bMRI?\b|\bMRA\b|자기\s*공명|\bmagnetic\s+resonance\b/i,
  ],
  [
    'ultrasound',
    /초음파|심초음파|\bUSG?\b|\bechocardiogra\w*|\bTEE\b|\bTTE\b|에코(?:심동도|카디오)?/i,
  ],
  ['ecg', /심전도|\bECG\b|\bEKG\b|\belectrocardiogra\w*/i],
  ['pathology', /병리\s*(?:소견|사진|조직|표본)|생검\s*(?:소견|사진)|조직\s*(?:소견|사진|표본)|\bH&E\b/i],
  ['microscope', /현미경\s*(?:소견|사진)|\bmicroscop\w*/i],
];

/** 발문이 언급한 검사 종류 목록(중복 없음, 언급 순서 무관). */
export function stemModalities(stem: string): string[] {
  const s = String(stem ?? '');
  return STEM_MODALITY_PATTERNS.filter(([, re]) => re.test(s)).map(([k]) => k);
}

/**
 * 발문이 말하는 검사와 실제로 붙은 이미지가 어긋나는지.
 *
 * 실측 사고: 발문은 "흉부 X-ray 에서 종격동 확장이 관찰된다"인데 붙은 이미지는
 * 심초음파였다 — 학생이 볼 때 발문과 그림이 따로 놀아 풀 수 없다.
 * 발문이 검사를 특정하지 않았거나(예: "다음 사진에서"), 이미지가 도해·기타 유형이면
 * 판단 근거가 없으므로 통과시킨다(과도한 연결 해제 방지). 여러 검사를 언급했고 붙은
 * 그림이 그중 하나면 통과다.
 */
export function stemModalityConflict(stem: string, kind: string): boolean {
  if (!CLINICAL_IMAGE_KINDS.has(kind)) return false;
  const mentioned = stemModalities(stem);
  if (mentioned.length === 0) return false;
  return !mentioned.includes(kind);
}

/**
 * 생성 모델에게 알려 줄 이미지 종류의 한국어 이름.
 *
 * 모델은 그림을 보고 종류를 스스로 판단했는데, 실측에서 MRI 크롭을 두고 "흉부 X-ray와 MR"
 * 이라고 쓰고(effbfdf0) 초음파 크롭을 두고 "CT 영상에서"라고 썼다(검증기 지적). 종류를
 * `[이미지 N]` 라벨에 적어 주면 발문이 다른 검사명을 쓸 이유가 사라진다 — 사후 불일치
 * 해제(그리고 그로 인한 그림 없는 문항)보다 예방이 싸다.
 */
export function imageKindLabel(kind: string): string {
  switch (kind) {
    case 'xray':
      return '단순 X-ray(방사선) 사진';
    case 'ct':
      return 'CT 영상';
    case 'mri':
      return 'MRI(자기공명) 영상';
    case 'ultrasound':
      return '초음파(심초음파 포함) 영상';
    case 'ecg':
      return '심전도';
    case 'pathology':
      return '병리 조직 사진';
    case 'microscope':
      return '현미경 사진';
    case 'anatomy_diagram':
      return '해부도·모식도';
    case 'chart_graph':
      return '차트·그래프';
    default:
      return '그림';
  }
}
