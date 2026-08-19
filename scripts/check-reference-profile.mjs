#!/usr/bin/env node
/**
 * 참고 자료 형식 프로파일 검사 — P7.
 *
 * 실행: npm run check:reference   (네트워크 불필요)
 *
 * 왜 있는가 (2026-08-18 감사)
 *  - 참고 자료는 **이미지 6장(PDF 앞 3쪽)** 이 전부였고, PPTX·DOCX 는 무경고로 무시됐다.
 *    그 6장을 배치마다 다시 보내면서도(캐시 없음) 정작 자료의 앞부분만 본 셈이었다.
 *  - 내신의 본질은 학교마다 다른 족보 스타일인데, 그 스타일을 담을 그릇이 없었다.
 *
 * 이 검사가 지키는 결정 (2026-08-19)
 *  - **참고 자료 형식이 기본 규격(K/C)보다 우선**한다. 학생은 자기 학교 형식으로 풀려고 올린다.
 *  - **단 안전 규칙은 예외**다 — 선지 5개·정답 누출 금지·오답 성립성·이미지 규칙은 그대로.
 *  - 프로파일은 **형식만** 담는다. 의학 내용이 들어가면 "기출 내용을 출제 근거로 쓰지 말라"는
 *    절대 원칙을 프로파일이 우회하게 된다.
 */
import {
  REFERENCE_PROFILE_SYSTEM_PROMPT,
  REFERENCE_PROFILE_TOOL,
  buildReferenceProfileUserMessage,
  buildReferenceProfileSection,
  isUsableProfile,
  sanitizeProfile,
} from '../lib/ai/reference-profile.ts';
import { readFileSync } from 'node:fs';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const genSrc = readFileSync(new URL('../lib/ai/private-generation.ts', import.meta.url), 'utf8');
const genCode = genSrc
  .split('\n')
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

const profile = {
  ask_endings: ['옳은 것은?', '진단은?', '옳지 않은 것은?'],
  choice_style: '명사구',
  avg_stem_chars: 140,
  negative_ratio: 0.25,
  combo_used: true,
  vignette_ratio: 0.6,
  sample_ask_shapes: ['이 환자의 진단은?', '…에 대한 설명으로 옳은 것은?'],
  observed_questions: 24,
};

console.log('프로파일 스키마');
for (const f of [
  'ask_endings',
  'choice_style',
  'avg_stem_chars',
  'negative_ratio',
  'combo_used',
  'vignette_ratio',
  'sample_ask_shapes',
  'observed_questions',
]) {
  check(`${f} 가 required 다`, REFERENCE_PROFILE_TOOL.input_schema.required.includes(f));
}
check(
  '예시 발문에서 의학 명사를 지우라고 지시한다',
  /의학 명사를 반드시 지운다|의학 명사를 지우고/.test(
    JSON.stringify(REFERENCE_PROFILE_TOOL) + REFERENCE_PROFILE_SYSTEM_PROMPT,
  ),
);
check(
  '시스템 프롬프트가 질환명·수치·정답을 옮기지 말라고 못박는다',
  /질환명·약물명·검사 수치·정답은 어느 필드에도 쓰지 않습니다/.test(REFERENCE_PROFILE_SYSTEM_PROMPT),
);
check(
  '문항 형태가 없으면 0 으로 두라고 한다(없는 형식을 지어내지 않게)',
  /observed_questions 를 0 으로 두고/.test(REFERENCE_PROFILE_SYSTEM_PROMPT),
);

console.log('\n쓸 만한 프로파일 판정');
check('문항을 읽었으면 쓴다', isUsableProfile(profile));
check('문항 0 이면 쓰지 않는다', !isUsableProfile({ ...profile, observed_questions: 0 }));
check('발문 종결을 못 뽑았으면 쓰지 않는다', !isUsableProfile({ ...profile, ask_endings: [] }));
check('null 이면 쓰지 않는다', !isUsableProfile(null));

console.log('\n퇴화된 프로파일 방어 (2026-08-19 실측 대응)');
// 영문 시험지를 참고 자료로 줬더니 ask_endings=["?"], avg_stem_chars=25 가 돌아왔다.
// 그 값이 그대로 실리면 "발문 종결: "?"" 라는 무의미한 지시가 **규격을 이긴다**.
{
  const degenerate = { ...profile, ask_endings: ['?'], sample_ask_shapes: ['?'], avg_stem_chars: 25 };
  check('문장부호만 남은 종결은 쓸 수 없다고 판정', !isUsableProfile(degenerate));
  const cleaned = sanitizeProfile(degenerate);
  check('의미 없는 종결을 버린다', cleaned.ask_endings.length === 0);
  check('의미 없는 예시를 버린다', cleaned.sample_ask_shapes.length === 0);
  check('말이 안 되는 평균 길이는 0(모름)으로 둔다', cleaned.avg_stem_chars === 0);
  const sec = buildReferenceProfileSection({ ...profile, avg_stem_chars: 25 });
  check('모르는 길이는 줄 자체를 빼고 출력한다', !/지문 평균 길이/.test(sec));
  const ok = sanitizeProfile(profile);
  check('정상 프로파일은 그대로 둔다', ok.ask_endings.length === 3 && ok.avg_stem_chars === 140);
  check('비율은 0~1 로 조인다', sanitizeProfile({ ...profile, negative_ratio: 3 }).negative_ratio === 1);
}

console.log('\n프롬프트 절 — 형식 우선, 안전 규칙 예외 (결정 사항)');
{
  const sec = buildReferenceProfileSection(profile);
  check('관찰 문항 수를 밝힌다', sec.includes('24문항'));
  check('발문 종결을 싣는다', sec.includes('옳은 것은?'));
  check('비율을 퍼센트로 보여준다', /25 %/.test(sec) && /60 %/.test(sec));
  check('조합형 사용 여부를 말한다', /조합형.*사용함/.test(sec));
  check(
    '**형식은 프로파일 우선**이라고 명시한다',
    /형식은 이 프로파일을 우선한다/.test(sec) && /프로파일을 따른다/.test(sec),
  );
  check('안전 규칙 예외를 열거한다', /안전 규칙/.test(sec) && /선지는 정확히 5개/.test(sec));
  check('정답 누출 금지가 예외에 있다', /정답이 길이·형식으로 드러나지 않게/.test(sec));
  check('오답 성립성이 예외에 있다', /상식으로 지워지는 선지 금지/.test(sec));
  check('내용은 가져오지 말라고 재차 말한다', /내용은 절대 가져오지 않는다/.test(sec));
  check(
    '프로파일 절에 의학 명사가 섞이지 않는다(입력 예시 기준)',
    !/심근경색|당뇨|폐렴|고혈압/.test(sec),
  );
}

console.log('\n호출·주입 방식');
check('프로파일은 1회만 뽑는다(배치 루프 밖)', /const referenceProfile = await summarizeReferenceFormat/.test(genCode));
check(
  '시스템 프롬프트에 붙인다(캐시 대상)',
  /systemPrompt \+= `\\n\\n\$\{buildReferenceProfileSection/.test(genCode),
);
{
  // import 위치가 아니라 **조립 지점**을 비교해야 한다 — 첫 판에서 import 줄을 재는 바람에
  // 검사가 실제 순서와 무관한 것을 보고 있었다.
  const kIdx = genCode.indexOf('systemPrompt += `\\n\\n${KNOWLEDGE_RULES}`');
  const cIdx = genCode.indexOf('systemPrompt += `\\n\\n${CLINICAL_VIGNETTE_RULES}`');
  const pIdx = genCode.indexOf('systemPrompt += `\\n\\n${buildReferenceProfileSection');
  check(
    '규격(K/C) 조립 뒤에 프로파일을 붙인다(뒤가 앞을 덮는다)',
    kIdx > 0 && cIdx > 0 && pIdx > 0 && kIdx < pIdx && cIdx < pIdx,
    `C=${cIdx} K=${kIdx} P=${pIdx}`,
  );
}
check(
  '프로파일이 있으면 배치마다 그림을 재전송하지 않는다',
  /isUsableProfile\(referenceProfile\) \? \[\] : referenceImages/.test(genCode),
);
check('진단에 프로파일을 남긴다', /diag\.generation\.referenceProfile/.test(genCode));
check(
  '프로파일을 못 쓴 사유를 경고에 남긴다',
  /발문 종결을 뽑지 못함/.test(genCode) && /문항 형태가 없음/.test(genCode),
);

console.log('\n형식 우선이 쿼터에도 적용되는가 (2026-08-19 재실측 대응)');
// 재실측에서 프로파일이 negative_ratio 0.4 였는데 생성은 부정형 0/4 였다.
// 원인은 부정형 허용 묶음을 정하는 코드가 프로파일을 안 보고 기본 20 % 로 눌렀던 것.
// 배치 지시는 시스템 프롬프트보다 뒤·구체적이라 실제로는 배치 지시가 이긴다.
check(
  '부정형 쿼터가 프로파일 비율을 따른다',
  /negativeQuota = isUsableProfile\(referenceProfile\)/.test(genCode) &&
    /referenceProfile\.negative_ratio \* desiredCount/.test(genCode),
);
check(
  '조합형 쿼터가 프로파일의 사용 여부를 따른다',
  /comboQuota = isUsableProfile\(referenceProfile\)/.test(genCode) &&
    /referenceProfile\.combo_used/.test(genCode),
);
check(
  '참고 자료가 없으면 종전 기본값을 쓴다',
  /Math\.max\(1, Math\.round\(desiredCount \/ 10\) \* 2\)/.test(genCode) &&
    /Math\.floor\(desiredCount \/ 10\)/.test(genCode),
);
check(
  '허용 묶음 수는 배치 수를 넘지 않는다',
  /Math\.min\(batchSizes\.length, Math\.round\(referenceProfile\.negative_ratio/.test(genCode),
);
// vignette_ratio 는 일부러 반영하지 않는다 — 사용자가 고른 문항 유형을 프로파일이 뒤집으면
// 요청 위반이다(지식형을 골랐는데 증례가 나오는 것).
check(
  '증례 비율은 쿼터에 반영하지 않는다(사용자가 고른 유형이 우선)',
  !/vignette_ratio \*/.test(genCode) && !/clinicalQuota[^\n]*vignette_ratio/.test(genCode),
);
{
  // 계산 재현: 프로파일 0.4 · 10문항 · 배치 5개 → 허용 묶음 4개(문항 기준 40 %).
  const batches = 5;
  const q = Math.min(batches, Math.round(0.4 * 10));
  check('0.4 × 10문항 → 허용 묶음 4개', q === 4, `${q}`);
  const none = Math.min(batches, Math.round(0 * 10));
  check('부정형을 안 쓰는 학교면 허용 묶음 0개', none === 0);
}

console.log('\n텍스트 추출 범위');
check('PDF 텍스트를 읽는다', /REFERENCE_PDF_MAX_PAGES/.test(genCode));
check('PPTX 를 읽는다', /parsePptx\(buffer\)[\s\S]{0,120}slides/.test(genCode));
check('DOCX 를 읽는다(Office 변환 재사용)', /convertOfficeToPdfBuffer\(buffer, 'docx'\)/.test(genCode));
check('스캔본은 종전대로 그림으로 넘긴다', /MIN_REFERENCE_TEXT/.test(genCode) && /renderPdfPages/.test(genCode));
check('자료당 텍스트 상한이 있다', /MAX_REFERENCE_TEXT_CHARS/.test(genCode));

console.log('\n사용자 메시지 길이 상한');
{
  const long = 'ㄱ'.repeat(50_000);
  const msg = buildReferenceProfileUserMessage(long);
  check('입력을 상한으로 자른다', msg.length < 30_000, `${msg.length}자`);
}

if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log('\n전부 통과');
