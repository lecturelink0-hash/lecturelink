/**
 * 그림 지칭 발문 판정 회귀 검사 — lib/ai/figure-stem.ts
 *
 * 왜 이 검사가 필요한가
 * ─────────────────────
 * 이 판정이 조용히 실패하면 **학생이 못 푸는 문항**이 저장된다. 발문은 "제시된 MRI 영상은 …"
 * 인데 화면에는 그림이 없다. 저장은 정상이고 문항 수도 맞아서 로그에는 흔적이 없다 —
 * 사람이 화면을 보기 전에는 아무도 모른다. 실제로 두 번 났다.
 *
 *   ① "다음은 복부 초음파 소견이다"      — 그림 명사와 서술어 사이 꼬리 명사를 못 넘음
 *   ② "제시된 MRI Tractography 영상은 …" — 꼬리 조사에 은/는 이 없고, 괄호 원어가 서술어를 끊음
 *
 * ②는 2026-08-22 프로덕션 실측(업로드 da95eb64, 이미지형 10문항)에서 나온 **실물 발문**이다.
 * 그때 이미지 없이 그림을 가리킨 문항 4건 중 stemDeclaresFigure 가 잡은 것은 0건이었다.
 * 아래 mustMatch 는 그 4건을 그대로 박아 둔 것이라, 판정식을 건드려 회귀하면 여기서 깨진다.
 *
 * 읽기만 하며 DB·네트워크를 쓰지 않는다.
 *
 *   npm run check:figure
 */

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

console.log('');
if (failures === 0) {
  console.log('✅ 전부 통과');
  process.exit(0);
}
console.log(`❌ ${failures}건 실패`);
process.exit(1);
