"""적신호 안전 게이트 회귀 테스트 (2026-08-18 감사 P0-2).

게이트는 총점 상한까지 걸기 때문에 잘못 걸리면 학생 점수를 부당하게 깎는다.
그래서 두 방향을 모두 본다 — 놓쳤을 때 확실히 걸리는가, 다 했을 때 안 걸리는가.
"""
from __future__ import annotations

import glob
import json
import os

import evaluate as ev
import prompt as pm
import scoring

COMMON = os.path.join(os.path.dirname(__file__), '..', 'data', 'cpx', 'common')


def _judgments(rubric, context, *, met_all=True, force=None):
    """전 항목 충족(또는 미충족) 판정을 만든다. force 로 개별 항목을 덮어쓴다."""
    items = {}
    for section in rubric['sections']:
        if section['type'] == 'deduction':
            continue
        for item in section['items']:
            status = 'met' if met_all else 'not_met'
            items[item['id']] = {
                'satisfied': status == 'met', 'status': status,
                'evidence': ['L001 의사: (테스트)'] if status != 'not_met' else [],
                'confidence': 'high',
            }
    for item_id, status in (force or {}).items():
        items[item_id] = {
            'satisfied': status == 'met', 'status': status,
            'evidence': ['L001 의사: (테스트)'] if status != 'not_met' else [],
            'confidence': 'high',
        }
    return {'items': items, 'violations': [], 'phases': []}


def test_gate_definitions_are_valid() -> None:
    """모든 게이트가 실제 존재하는 항목·케이스를 가리키는지 — 새 게이트의 오타를 잡는다."""
    problems: list[str] = []
    gate_count = 0
    for path in sorted(glob.glob(os.path.join(COMMON, 'canonical_rubric.*.json'))):
        rubric = json.loads(open(path, encoding='utf-8').read())
        lookup = {i['id'] for s in rubric['sections'] if s['type'] != 'deduction' for i in s['items']}
        for gate in rubric.get('safetyGates', []):
            gate_count += 1
            name = f"{os.path.basename(path)}:{gate.get('id')}"
            if not gate.get('caseIds'):
                problems.append(f'{name}: caseIds 가 비어 있다')
            if not gate.get('requiredItemIds'):
                problems.append(f'{name}: requiredItemIds 가 비어 있다')
            if gate.get('maxOverallGrade') not in (0, 1):
                problems.append(f"{name}: maxOverallGrade={gate.get('maxOverallGrade')}")
            for item_id in gate.get('requiredItemIds', []):
                if item_id not in lookup:
                    problems.append(f'{name}: 항목 {item_id} 가 이 루브릭에 없다')
            for case_id in gate.get('caseIds', []):
                try:
                    case = pm.load_case(case_id)
                except KeyError:
                    problems.append(f'{name}: 케이스 {case_id} 없음')
                    continue
                if ev.load_rubric(case)['id'] != rubric['id']:
                    problems.append(f'{name}: {case_id} 는 이 루브릭을 쓰지 않는다')
    assert not problems, '안전 게이트 정의 오류:\n' + '\n'.join(problems)
    assert gate_count >= 30, f'게이트가 {gate_count}개뿐 — 적신호 증례 커버리지가 줄었다'
    print(f'  게이트 정의 {gate_count}개 검증 통과')


def test_gate_caps_total_and_grade() -> None:
    """놓치면 총점까지 깎이는가 — 등급만 낮추면 '92점 / 미흡' 화면이 나온다."""
    case = pm.load_case('acute_mi_rule')
    rubric = ev.load_rubric(case)
    context = ev.build_context(case, {'gender': '남성'})

    full = scoring.score_session(rubric, _judgments(rubric, context), context)
    assert full['safetyGate']['passed'], '전 항목을 충족했는데 게이트가 걸렸다'
    assert full['totalScore'] == 100.0, full['totalScore']
    assert 'rawTotalScore' not in full

    # 심전도(pe06)만 빠뜨린 경우 — 나머지는 만점
    missed = scoring.score_session(rubric, _judgments(rubric, context, force={'pe06': 'not_met'}), context)
    assert not missed['safetyGate']['passed'], '심전도 누락인데 게이트가 안 걸렸다'
    assert missed['totalScore'] <= 49.0, f"총점 상한 미적용: {missed['totalScore']}"
    assert missed['overallGradeLabel'] == '미흡', missed['overallGradeLabel']
    assert missed['rawTotalScore'] > missed['totalScore'], '게이트 적용 전 점수가 남지 않았다'
    gate = missed['safetyGate']['triggered'][0]
    assert gate['missingItemIds'] == ['pe06'], gate
    print(f"  게이트 작동 — {missed['rawTotalScore']}점 -> {missed['totalScore']}점 ({missed['overallGradeLabel']})")


def test_partial_does_not_satisfy_gate() -> None:
    """안전 행동은 '절반만'이 통하지 않는다."""
    case = pm.load_case('thunderclap_sah_rule')
    rubric = ev.load_rubric(case)
    context = ev.build_context(case, {'gender': '여성'})
    partial = scoring.score_session(rubric, _judgments(rubric, context, force={'ed02': 'partial'}), context)
    assert not partial['safetyGate']['passed'], 'partial 이 안전 항목을 통과시켰다'
    print('  partial 은 안전 항목을 충족하지 않음 확인')


def test_gate_respects_conditional_items() -> None:
    """조건부로 빠진 항목은 요구하지 않는다 — 남성 환자에게 임신 확인을 요구하면 영구 미흡."""
    case = pm.load_case('ectopic_pregnancy_rule')
    rubric = ev.load_rubric(case)

    female = ev.build_context(case, {'gender': '여성'})
    assert 'ht11b' in scoring.applicable_item_ids(rubric, female)
    male = ev.build_context(case, {'gender': '남성'})
    assert 'ht11b' not in scoring.applicable_item_ids(rubric, male)

    # 여성: 임신 확인을 놓치면 걸린다
    miss_f = scoring.score_session(rubric, _judgments(rubric, female, force={'ht11b': 'not_met'}), female)
    assert not miss_f['safetyGate']['passed']
    # 남성: 같은 항목이 채점 대상이 아니므로 요구에서 빠지고, 나머지를 다 했으면 통과
    ok_m = scoring.score_session(rubric, _judgments(rubric, male), male)
    assert ok_m['safetyGate']['passed'], '조건부 제외 항목이 게이트를 영구히 잠근다'
    print('  조건부 항목 처리 확인 (여성 요구 / 남성 제외)')


def test_every_gated_case_is_reachable() -> None:
    """게이트가 걸린 증례를 전부 실제로 채점해 본다 — 만점이면 통과, 요구 항목을 빼면 걸린다."""
    checked = 0
    for path in sorted(glob.glob(os.path.join(COMMON, 'canonical_rubric.*.json'))):
        rubric = json.loads(open(path, encoding='utf-8').read())
        for gate in rubric.get('safetyGates', []):
            for case_id in gate['caseIds']:
                case = pm.load_case(case_id)
                context = ev.build_context(case, pm.resolve_persona(case, 'gate-test'))
                required = [i for i in gate['requiredItemIds']
                            if i in scoring.applicable_item_ids(rubric, context)]
                if not required:
                    continue
                ok = scoring.score_session(rubric, _judgments(rubric, context), context)
                assert not any(g['id'] == gate['id'] for g in ok['safetyGate']['triggered']), \
                    f"{case_id}/{gate['id']}: 전 항목 충족인데 걸렸다"
                bad = scoring.score_session(
                    rubric, _judgments(rubric, context, force={required[0]: 'not_met'}), context)
                assert any(g['id'] == gate['id'] for g in bad['safetyGate']['triggered']), \
                    f"{case_id}/{gate['id']}: {required[0]} 를 빼도 안 걸린다"
                assert bad['totalScore'] <= (49.0 if gate['maxOverallGrade'] == 0 else 79.0)
                checked += 1
    print(f'  게이트가 걸린 증례 {checked}건 양방향 확인')


def main() -> None:
    test_gate_definitions_are_valid()
    test_gate_caps_total_and_grade()
    test_partial_does_not_satisfy_gate()
    test_gate_respects_conditional_items()
    test_every_gated_case_is_reachable()
    print('안전 게이트 회귀 테스트 통과')


if __name__ == '__main__':
    main()
