#!/usr/bin/env node
/**
 * 문항 유형 배분 계획 회귀 검사 — lib/ai/type-plan.ts
 *
 * 왜 있는가 (2026-08-27 실측, 업로드 effbfdf0)
 *  지식형·이미지형 10문항 요청이 8:2 로 나왔다. 종전 배분은 전역 목표 없이 묶음별 "최소 1"만
 *  있었고, 유형 수로 나눈 몫을 묶음 예약과 묶음 안 쿼터에서 두 번 적용해 이미지형 몫이 두 번
 *  깎였다(설계상 최대 3/10). 이 검사는 "전역 목표의 합 = 요청 수, 묶음 쿼터의 합 = 목표"를
 *  고정한다 — 여기서 깨지면 같은 사고가 재발한다.
 *
 *   npm run check:type-plan   (네트워크 불필요)
 */
import {
  planBatchQuotas,
  planFillQuotas,
  planTypeRepair,
  planTypeTargets,
  spillImageShortfall,
  typeDeficits,
} from '../lib/ai/type-plan.ts';

let failures = 0;
function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
}
const sum = (qs, k) => qs.reduce((n, q) => n + q[k], 0);
const fmt = (o) => JSON.stringify(o);

console.log('① 전역 목표 — 거의 같은 수로 나눈다');
{
  const t = planTypeTargets(10, ['지식형', '이미지형']);
  check('10문항 2유형 → 5:5', t.knowledge === 5 && t.image === 5, fmt(t));
  const t3 = planTypeTargets(10, ['지식형', '임상형', '이미지형']);
  check('10문항 3유형 → 3:4:3(임상형이 4)', t3.knowledge === 3 && t3.clinical === 4 && t3.image === 3, fmt(t3));
  const t11 = planTypeTargets(11, ['지식형', '임상형', '이미지형']);
  check('11문항 3유형 → 4:4:3(이미지형은 마지막)', t11.knowledge === 4 && t11.clinical === 4 && t11.image === 3, fmt(t11));
  const tk = planTypeTargets(7, ['임상형', '지식형']);
  check('7문항 2유형 → 임상 4 · 지식 3', tk.clinical === 4 && tk.knowledge === 3, fmt(tk));
  const single = planTypeTargets(10, ['이미지형']);
  check('단독 선택이면 전부 그 유형', single.image === 10 && single.free === 0, fmt(single));
  const none = planTypeTargets(10, []);
  check('선택 없음이면 전부 free(제약 없음)', none.free === 10, fmt(none));
  const bogus = planTypeTargets(10, ['지식형', '기타', '지식형']);
  check('알 수 없는 값·중복은 무시', bogus.knowledge === 10, fmt(bogus));
  check('합은 언제나 요청 수', [t, t3, t11, tk, single, none, bogus].every((x) => x.knowledge + x.clinical + x.image + x.free === (x === tk ? 7 : x === t11 ? 11 : 10)));
}

console.log('\n② 이미지 공급 상한 — 넘치는 몫은 다른 유형으로');
{
  const t = planTypeTargets(10, ['지식형', '이미지형'], 3);
  check('공급 3장분이면 이미지 3 · 지식 7', t.image === 3 && t.knowledge === 7, fmt(t));
  const t3 = planTypeTargets(10, ['지식형', '임상형', '이미지형'], 1);
  check('3유형에서 이미지 1이면 나머지 2를 임상·지식에 고르게', t3.image === 1 && t3.clinical === 5 && t3.knowledge === 4, fmt(t3));
  const only = planTypeTargets(10, ['이미지형'], 4);
  check('이미지형 단독에 공급 4면 나머지는 free', only.image === 4 && only.free === 6, fmt(only));
  const zero = planTypeTargets(10, ['지식형', '이미지형'], 0);
  check('공급 0이면 이미지 0 · 지식 10', zero.image === 0 && zero.knowledge === 10, fmt(zero));
}

console.log('\n③ 묶음 쿼터 — 실측 사고 형태(5묶음 × 2, 선발사 2묶음)');
{
  const sizes = [2, 2, 2, 2, 2];
  const eligible = [false, false, true, true, true];
  const t = planTypeTargets(10, ['지식형', '이미지형']);
  const q = planBatchQuotas(sizes, t, eligible);
  check('이미지 합 = 5(종전 3)', sum(q, 'image') === 5, fmt(q.map((x) => x.image)));
  check('지식 합 = 5(종전 7)', sum(q, 'knowledge') === 5, fmt(q.map((x) => x.knowledge)));
  check('이미지 묶음에 2·2·1 로 고르게', fmt(q.slice(2).map((x) => x.image)) === '[2,2,1]', fmt(q.map((x) => x.image)));
  check('선발사 묶음은 이미지 0', q[0].image === 0 && q[1].image === 0);
  check('묶음마다 합 = 묶음 크기', q.every((x, i) => x.image + x.knowledge + x.clinical + x.free === sizes[i]));
}
{
  const sizes = [2, 2, 2, 2, 2];
  const eligible = [false, false, false, true, true];
  const t = planTypeTargets(10, ['지식형', '임상형', '이미지형']);
  const q = planBatchQuotas(sizes, t, eligible);
  check('3유형: 이미지 3 · 임상 4 · 지식 3', sum(q, 'image') === 3 && sum(q, 'clinical') === 4 && sum(q, 'knowledge') === 3, fmt(q));
  check('텍스트 묶음에 임상·지식이 섞인다', q[0].clinical === 1 && q[0].knowledge === 1, fmt(q[0]));
}
{
  // 자격 묶음 용량이 모자라면 남는 이미지 몫은 텍스트로 옮긴다.
  const q = planBatchQuotas([2, 2], planTypeTargets(4, ['지식형', '이미지형'], 100), [false, true]);
  check('이미지 자격 묶음 1개(용량 2)면 이미지 2 · 지식 2', sum(q, 'image') === 2 && sum(q, 'knowledge') === 2, fmt(q));
}
{
  const q = planBatchQuotas([2, 2, 2], planTypeTargets(6, ['이미지형']), [true, true, true]);
  check('이미지형 단독은 전 묶음 전부 이미지', q.every((x) => x.image === 2), fmt(q));
}

console.log('\n④ 공급 부족 spill — 묶음 크기는 그대로');
{
  const s = spillImageShortfall({ image: 2, knowledge: 0, clinical: 0, free: 0 }, 1, ['지식형', '이미지형']);
  check('이미지 2 계획에 공급 1이면 지식 1로 옮김', s.image === 1 && s.knowledge === 1, fmt(s));
  const s2 = spillImageShortfall({ image: 2, knowledge: 0, clinical: 0, free: 0 }, 0, ['지식형', '임상형', '이미지형']);
  check('두 텍스트 유형이면 번갈아', s2.clinical === 1 && s2.knowledge === 1, fmt(s2));
  const s3 = spillImageShortfall({ image: 2, knowledge: 0, clinical: 0, free: 0 }, 0, ['이미지형']);
  check('이미지형 단독이면 free 로', s3.free === 2, fmt(s3));
  const s4 = spillImageShortfall({ image: 1, knowledge: 1, clinical: 0, free: 0 }, 1, ['지식형', '이미지형']);
  check('공급이 충분하면 그대로', s4.image === 1 && s4.knowledge === 1, fmt(s4));
}

console.log('\n⑤ 부족분 보충·비율 교정 — 실측 8:2 를 5:5 로');
{
  const targets = planTypeTargets(10, ['지식형', '이미지형']);
  const deficits = typeDeficits(targets, { knowledge: 8, clinical: 0, image: 2 });
  check('부족분: 이미지 +3 · 지식 -3', deficits.image === 3 && deficits.knowledge === -3, fmt(deficits));
  const repair = planTypeRepair(deficits, 6, ['지식형', '이미지형']);
  check('이미지 용량 6이면 지식 3 삭제 · 이미지 3 재생성', repair.deleteFrom.knowledge === 3 && repair.regenerate.image === 3, fmt(repair));
  const repairCap = planTypeRepair(deficits, 1, ['지식형', '이미지형']);
  check('이미지 용량 1이면 1개만', repairCap.deleteFrom.knowledge === 1 && repairCap.regenerate.image === 1, fmt(repairCap));
  const none = planTypeRepair(typeDeficits(targets, { knowledge: 5, clinical: 0, image: 5 }), 6, ['지식형', '이미지형']);
  check('목표대로면 아무것도 안 지운다', none.deleteFrom.knowledge === 0 && none.regenerate.image === 0, fmt(none));
  const fill = planFillQuotas([2, 1], deficits, [2, 1], ['지식형', '이미지형']);
  check('보충 3슬롯은 전부 이미지(부족 유형)', sum(fill, 'image') === 3 && sum(fill, 'knowledge') === 0, fmt(fill));
  const fillNoCap = planFillQuotas([2, 1], deficits, [0, 0], ['지식형', '이미지형']);
  check('이미지 용량 0이면 텍스트로(지식형이 선택 유형)', sum(fillNoCap, 'knowledge') === 3, fmt(fillNoCap));
  const fill3 = planFillQuotas([2], { knowledge: 1, clinical: 1, image: 0 }, [0], ['지식형', '임상형', '이미지형']);
  check('임상·지식 부족 1씩이면 1·1', fill3[0].clinical === 1 && fill3[0].knowledge === 1, fmt(fill3));
}

console.log('');
if (failures === 0) {
  console.log('✅ 전부 통과');
  process.exit(0);
}
console.log(`❌ ${failures}건 실패`);
process.exit(1);
