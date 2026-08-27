#!/usr/bin/env node
/**
 * 발문 검사명 ↔ 이미지 종류 정합 판정 회귀 검사 — lib/ai/stem-modality.ts
 *
 * 왜 있는가 (2026-08-27 실측, 업로드 effbfdf0 슬롯 7)
 *  "흉부 X-ray와 MR 영상에서 보이는 대동맥 병변의 진단은?" 에 MRI 크롭이 붙어 있었는데
 *  MRI 패턴이 `\bMRI\b` 뿐이라 "MR 영상"을 못 읽었다 → X-ray 만 언급한 것으로 판정 →
 *  붙은 그림(mri)과 불일치 → 이미지 연결 해제 → 그림 없는 문항이 학생 화면에 나갔다.
 *  어휘 구멍은 운영에서만 드러나므로 실물 발문을 여기 박아 둔다.
 *
 *   npm run check:modality   (네트워크 불필요)
 */
import { imageKindLabel, stemModalities, stemModalityConflict } from '../lib/ai/stem-modality.ts';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}

console.log('① 실측 발문 — MRI 크롭에 "MR 영상"은 불일치가 아니다');
const measured = '흉부 X-ray와 MR 영상에서 보이는 대동맥 병변의 진단으로 옳은 것은?';
check('언급한 검사에 mri 가 있다', stemModalities(measured).includes('mri'), stemModalities(measured).join(','));
check('mri 크롭과 불일치 아님', !stemModalityConflict(measured, 'mri'));
check('xray 크롭과도 불일치 아님(둘 다 언급)', !stemModalityConflict(measured, 'xray'));
check('ct 크롭과는 불일치', stemModalityConflict(measured, 'ct'));

console.log('\n② 어휘 — 흔한 표기를 전부 읽는다');
const cases = [
  ['다음 MR영상에서 보이는 병변은?', 'mri'],
  ['자기공명영상 소견은?', 'mri'],
  ['MRA 에서 관찰되는 협착 부위는?', 'mri'],
  ['흉부 X선 사진에서 보이는 소견은?', 'xray'],
  ['엑스선 사진 소견은?', 'xray'],
  ['CXR 에서 종격동 확장이 보인다.', 'xray'],
  ['조영증강 CTA 에서 보이는 병변의 진단은?', 'ct'],
  ['전산화단층촬영 소견은?', 'ct'],
  ['경식도 심초음파(TEE)에서 보이는 소견은?', 'ultrasound'],
  ['에코 소견은?', 'ultrasound'],
  ['심전도(EKG)에서 보이는 이상은?', 'ecg'],
  ['조직 표본에서 보이는 소견은?', 'pathology'],
  ['현미경 사진에서 보이는 세포는?', 'microscope'],
];
for (const [stem, kind] of cases) {
  check(`${kind}: ${stem.slice(0, 26)}…`, stemModalities(stem).includes(kind), stemModalities(stem).join(',') || '(없음)');
}

console.log('\n③ 판단 근거가 없으면 통과(과도한 연결 해제 방지)');
check('검사명을 안 쓰면 통과', !stemModalityConflict('다음 사진에서 보이는 병변의 진단은?', 'ct'));
check('도해·기타 유형은 통과', !stemModalityConflict('흉부 X-ray 에서 보이는 병변은?', 'anatomy_diagram'));
check('실제 불일치는 잡는다(발문 X-ray · 그림 초음파)', stemModalityConflict('흉부 X-ray 에서 종격동 확장이 관찰된다.', 'ultrasound'));

console.log('\n④ 라벨 — 모델에게 알려 줄 종류 이름');
check('mri 라벨에 MRI 가 들어간다', imageKindLabel('mri').includes('MRI'));
check('ct 라벨에 CT 가 들어간다', imageKindLabel('ct').includes('CT'));
check('모르는 종류는 "그림"', imageKindLabel('whatever') === '그림');

console.log('');
if (failures === 0) {
  console.log('✅ 전부 통과');
  process.exit(0);
}
console.log(`❌ ${failures}건 실패`);
process.exit(1);
