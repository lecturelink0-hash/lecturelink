#!/usr/bin/env node
/**
 * 자료 판정(P6) · 출제 초점(P5) 검사.
 *
 * 실행: npm run check:material   (네트워크 불필요)
 *
 * 왜 있는가 (2026-08-18 감사)
 *  - 비의학·기출 필터가 0건이었다. 실증: 비의료 PNG 업로드, 국시 기출 PDF 업로드 →
 *    기출 문항 10개가 그대로 재생성. 추천 API 는 도구 호출 강제 + "가장 그럴듯한 값"
 *    지시라 요리책에도 과목명을 붙였다.
 *  - 화면의 '단원/주제'·'핵심 키워드'가 요청에 실리지 않아 출제에 아무 영향이 없었다.
 *
 * 이 검사가 지키는 결정 (2026-08-19)
 *  - P6 은 **권유+로그**다. 차단하지 않는다 — 오탐으로 정상 강의록을 막는 쪽이 더 나쁘다.
 *  - P5 는 style 을 바꾸지 않는다(현행 professor 고정). topic·keywords 만 반영한다.
 */
import {
  buildPrivateGenerationUserMessage,
} from '../lib/ai/prompts/private-generation.ts';
import { readFileSync } from 'node:fs';

let failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const analyzeSrc = read('../app/api/uploads/analyze/route.ts');
const notesSrc = read('../app/(app)/notes/page.tsx');
const genSrc = read('../lib/ai/private-generation.ts');
const migration = read('../supabase/migrations/00041_naesin_material_verdict_and_topic.sql');

console.log('P6 판정 필드');
for (const f of ['is_medical', 'material_kind', 'confidence']) {
  check(`툴 스키마에 ${f} 가 있다`, new RegExp(`${f}: \\{`).test(analyzeSrc));
  check(`${f} 가 required 다`, new RegExp(`'${f}'`).test(analyzeSrc));
}
check(
  'material_kind 가 기출(exam)을 구분한다',
  /'exam'/.test(analyzeSrc) && /기출·족보|기출/.test(analyzeSrc),
);
check(
  '시스템 프롬프트가 "억지로 과목명을 지어내지 말라"고 말한다',
  /억지로 의학 과목명을 지어내지 마세요/.test(analyzeSrc),
);
check(
  '종전의 "가장 그럴듯한 값" 지시가 사라졌다',
  !/추측이 어려운 필드는 빈 문자열 또는 가장 그럴듯한 값/.test(analyzeSrc),
);

console.log('\nP6 은 차단이 아니라 권유 (결정 사항)');
check(
  '판정 실패·비의학이어도 생성 API 를 막지 않는다(라우트에 차단 코드 없음)',
  !/is_medical\s*===\s*false[^)]*throw|ApiException\([^)]*non_medical/.test(analyzeSrc),
);
check('화면이 confirm 으로 확인만 받는다', /confirm\(/.test(notesSrc) && /그래도 문제를 만들까요/.test(notesSrc));
check('취소하면 생성이 시작되지 않는다(쿼터 미차감)', /if \(!confirm\(message\)\) return;/.test(notesSrc));
check('기출이면 참고 자료로 옮기기를 권유한다', /참고 자료.{0,12}올리면 형식만 참고/.test(notesSrc));
check('기출도 강행할 수 있다', /그래도 이대로 생성할까요/.test(notesSrc));
check('판정 주의는 로그로 남긴다', /자료 판정 주의/.test(analyzeSrc));

console.log('\n표본 추출(앞·중·뒤 3구간)');
check('sampleAcross 가 있다', /function sampleAcross/.test(analyzeSrc));
check('구간 수 상수가 있다', /SAMPLE_SEGMENTS/.test(analyzeSrc));
check('앞부분만 자르던 slice(0, PER_FILE_CHARS) 가 사라졌다', !/slice\(0, PER_FILE_CHARS\)/.test(analyzeSrc));
check('PDF 페이지 상한이 12 보다 커졌다(뒤쪽 구간을 보려면 필요)', /MAX_PDF_PAGES = (?!12\b)\d+/.test(analyzeSrc));

console.log('\nP5 출제 초점 프롬프트');
{
  const withFocus = buildPrivateGenerationUserMessage({
    subTopicCatalog: [],
    desiredCount: 4,
    style: 'professor',
    topic: '대동맥 박리',
    keywords: ['베타차단제', 'Stanford 분류'],
  });
  check('주제를 싣는다', withFocus.includes('대동맥 박리'));
  check('키워드를 싣는다', withFocus.includes('베타차단제') && withFocus.includes('Stanford 분류'));
  check('70 % 규칙을 말한다', /70 % 이상/.test(withFocus));
  check(
    '자료에 없는 초점은 무시하라고 말한다',
    /자료가 다루지 않는 주제·키워드는 무시/.test(withFocus),
  );
  const without = buildPrivateGenerationUserMessage({
    subTopicCatalog: [],
    desiredCount: 4,
    style: 'professor',
  });
  check('초점이 없으면 절을 만들지 않는다', !without.includes('출제 초점'));
  const blank = buildPrivateGenerationUserMessage({
    subTopicCatalog: [],
    desiredCount: 4,
    style: 'professor',
    topic: '   ',
    keywords: ['', '  '],
  });
  check('공백만 있는 초점은 무시한다', !blank.includes('출제 초점'));
}

console.log('\nP5 는 style 을 바꾸지 않는다 (결정 사항)');
check("화면이 여전히 style:'professor' 를 보낸다", /style: 'professor'/.test(notesSrc));
check('style 선택 UI 를 새로 만들지 않았다', !/스타일 선택|styleOptions/.test(notesSrc));

console.log('\n요청값 저장·전달');
check('요청 초점을 DB 에 남긴다', /requested_topic/.test(genSrc) && /requested_keywords/.test(genSrc));
check('마이그레이션이 컬럼 5개를 추가한다', ['is_medical', 'material_kind', 'analyze_confidence', 'requested_topic', 'requested_keywords'].every((c) => migration.includes(c)));
check('마이그레이션이 db push 금지를 명시한다', /db push. 를 쓰지 말 것|db push` 를 쓰지 말 것/.test(migration));
check('컬럼 추가는 멱등하다', (migration.match(/add column if not exists/g) ?? []).length >= 5);

if (failed > 0) {
  console.error(`\n${failed}건 실패`);
  process.exit(1);
}
console.log('\n전부 통과');
