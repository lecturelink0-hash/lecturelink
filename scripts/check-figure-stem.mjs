/**
 * 그림 지칭 발문 판정 회귀 검사 — lib/ai/figure-stem.ts
 *
 * 왜 이 검사가 필요한가
 * ─────────────────────
 * 이 판정이 조용히 실패하면 **학생이 못 푸는 문항**이 저장된다. 발문은 "제시된 MRI 영상은 …"
 * 인데 화면에는 그림이 없다. 저장은 정상이고 문항 수도 맞아서 로그에는 흔적이 없다 —
 * 사람이 화면을 보기 전에는 아무도 모른다. 실제로 **세 번** 났다.
 *
 *   ① "다음은 복부 초음파 소견이다"      — 그림 명사와 서술어 사이 꼬리 명사를 못 넘음
 *   ② "제시된 MRI Tractography 영상은 …" — 꼬리 조사에 은/는 이 없고, 괄호 원어가 서술어를 끊음
 *   ③ "다음 그림은 이 질환의 병태생리를 …" — ②를 고치며 '다음'을 지시어에서 뺐더니
 *      가장 흔한 형태가 통째로 빠졌다(업로드 c2150150, 스크린샷 신고)
 *
 * 교훈: 오탐이 무서워 **지시어를 빼는** 방식은 두 번 다 실패했다. 구분점은 지시어가 아니라
 * **서술어**다 — 그림 지칭은 "…이다/…는?", 본문 서술은 "…정상이었다"로 끝난다.
 *
 * ②는 2026-08-22 프로덕션 실측(업로드 da95eb64, 이미지형 10문항)에서 나온 **실물 발문**이다.
 * 그때 이미지 없이 그림을 가리킨 문항 4건 중 stemDeclaresFigure 가 잡은 것은 0건이었다.
 * 아래 mustMatch 는 그 4건을 그대로 박아 둔 것이라, 판정식을 건드려 회귀하면 여기서 깨진다.
 *
 * 읽기만 하며 DB·네트워크를 쓰지 않는다.
 *
 *   npm run check:figure
 */

import { readFileSync } from 'node:fs';
import { stemDeclaresFigureText, stemDependsOnImageText } from '../lib/ai/figure-stem.ts';

let failures = 0;
function check(label, ok) {
  console.log(`  ${ok ? '✅' : '❌'} ${label}`);
  if (!ok) failures += 1;
}

console.log('① 그림을 가리키는데 이미지가 없으면 반드시 폐기 — 2026-08-22 실측 발문');
const measured = [
  '제시된 MRI Tractography 영상은 뇌의 신경 연결망을 시각화한 것이다. 이 영상에서 색깔이 의미하는 것은?',
  '제시된 전자현미경 사진은 신경세포의 세포체(Neuronal cell body)를 보여준다. 이 세포체가 담당하는 주요 기능으로 옳은 것은?',
  '다음은 뇌의 신경 섬유 연결망을 시각화한 확산 스펙트럼 영상(Diffusion Spectrum Imaging)이다. 이 영상에서 흰색 물질(white matter)의 기능에 대한 설명으로 옳은 것은?',
  '아래 그림은 골격근 운동 신경 축을 나타낸다. 여기서 소뇌(Cerebellum)의 기능으로 옳은 것은?',
];
for (const stem of measured) {
  check(`declares: ${stem.slice(0, 34)}…`, stemDeclaresFigureText(stem));
}

console.log("\n①-2 2차 실측(c2150150) — '다음' 지시어 형태. 여기서 회귀하면 스크린샷 사고 재발");
for (const stem of [
  // 스크린샷으로 신고된 바로 그 문항.
  '60세 남자가 갑작스러운 흉통으로 응급실에 내원하였다. 흉부 CT 결과, 내막 파열(intimal tear)이 관찰되었고 혈관벽 내 혈액이 차 있는 소견이 확인되었다. 다음 그림은 이 질환의 병태생리를 모식적으로 보여준다.',
  '다음 그림은 대동맥의 병변을 보여준다. 이 병변에 대한 설명으로 옳은 것은?',
  '다음 혈관조영술(aortography) 영상에서 보이는 대동맥의 병변 진단은?',
  // 국시 기본형 — '다음' 을 지시어에서 뺐던 규칙에서는 이것도 놓쳤다.
  '다음 환자의 흉부 X-ray는?',
  '다음 심전도에서 관찰되는 소견은?',
]) {
  check(`declares: ${stem.slice(0, 34)}…`, stemDeclaresFigureText(stem));
}

console.log('\n② 종전에 잡히던 선언형 — 회귀하지 않아야 한다');
for (const stem of [
  '다음은 대동맥 박리의 발생 기전에 대한 모식도이다. 이 기전으로 옳은 것은?',
  '다음은 복부 초음파 소견이다. 진단은?',
  '아래 흉부 X-ray 를 보고 진단을 고르시오.',
]) {
  check(`declares: ${stem.slice(0, 34)}…`, stemDeclaresFigureText(stem));
}

console.log('\n③ 그림을 안 가리키는 발문은 절대 잡으면 안 된다(오탐이면 멀쩡한 문항이 삭제된다)');
for (const stem of [
  '다음 환자의 심전도 소견은 정상이었다. 이 환자에서 가장 먼저 확인할 것은?',
  '심전도 소견은 정상이었다.',
  '초음파 검사의 원리로 옳은 것은?',
  '신경세포에서 신경전달물질을 방출하는 데 관여하는 기전으로 옳은 것은?',
  '도파민(Dopamine) 과잉 또는 부족 시 발생할 수 있는 질환의 연결이 옳은 것은?',
]) {
  check(`declares 아님: ${stem.slice(0, 30)}…`, !stemDeclaresFigureText(stem));
}

console.log('\n④ 느슨한 판정(stemDependsOnImage)은 엄격한 판정을 포함해야 한다');
for (const stem of [...measured, '다음은 복부 초음파 소견이다. 진단은?']) {
  check(`depends: ${stem.slice(0, 34)}…`, stemDependsOnImageText(stem));
}

// 표식 문항("A로 표시된 …") 판정은 이 모듈이 아니라 annotate-markers.ts 의 몫이고
// check:markers 가 이미 덮는다. 결합(OR)은 private-generation.ts 호출부에서 한다.

// ⑤ 배선 — 판정이 맞아도 **호출되는 자리**가 틀리면 같은 사고가 난다.
//    실측에서 청소가 `imagesOffered > 0` 일 때만 돌아 마지막 보충 라운드 산출물이
//    그대로 저장됐다. 그 구조 결정을 소스에서 고정한다.
console.log('\n⑤ 배선 — 깨진 그림 참조를 막는 자리');
const gen = readFileSync(
  new URL('../lib/ai/private-generation.ts', import.meta.url),
  'utf8',
);
check(
  '저장 전 가드가 있다(이미지 없는 그림 지칭 문항을 insert 전에 폐기)',
  /bumpGenDiag\('figureRefWithoutImage'\)/.test(gen),
);
check(
  '보충 라운드마다 청소를 무조건 실행한다(imagesOffered 조건 제거)',
  !/if \(imagesOffered > 0\) \{\s*await enforceImageReuseCap/.test(gen),
);
check(
  '청소가 만든 빈 슬롯을 채울 라운드가 남아 있다(GEN_BACKFILL_ROUNDS ≥ 3)',
  (() => {
    const m = gen.match(/const GEN_BACKFILL_ROUNDS = (\d+)/);
    return !!m && Number(m[1]) >= 3;
  })(),
);
check(
  '이미지 쿼터 미준수를 계측한다',
  /bumpGenDiag\('imageQuotaShortfall'\)/.test(gen) && /batchDiag\.imageAttached\b/.test(gen),
);
check(
  '이미지 쿼터가 모자라면 1회 교정 재생성한다',
  /bumpGenDiag\('imageQuotaFixed'\)/.test(gen),
);

console.log('');
if (failures === 0) {
  console.log('✅ 전부 통과');
  process.exit(0);
}
console.log(`❌ ${failures}건 실패`);
process.exit(1);
