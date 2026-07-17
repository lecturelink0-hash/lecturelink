"""§4.8 산식 단위 테스트 — Phase 4 완료 조건의 경계값 케이스."""
import json
from pathlib import Path

from scoring import score_session

RUBRIC = json.loads(
    (Path(__file__).resolve().parent.parent / 'data/cpx/common/canonical_rubric.sleep.json').read_text()
)

ALL_ITEM_IDS = [i['id'] for s in RUBRIC['sections'] if s['type'] != 'deduction' for i in s['items']]
DATA_DIR = Path(__file__).resolve().parent.parent / 'data/cpx/common'
SYNCOPE_RUBRIC = json.loads((DATA_DIR / 'canonical_rubric.syncope.json').read_text())
MEMORY_RUBRIC = json.loads((DATA_DIR / 'canonical_rubric.memory_loss.json').read_text())


def judg(satisfied_ids, violations=()):
    return {
        'items': {i: {'satisfied': i in satisfied_ids} for i in ALL_ITEM_IDS},
        'violations': list(violations),
    }


def section(result, sid):
    return next(s for s in result['sections'] if s['id'] == sid)


def all_met_judgments(rubric, except_ids=()):
    item_ids = [i['id'] for s in rubric['sections'] if s['type'] != 'deduction' for i in s['items']]
    return {
        'items': {
            item_id: {
                'status': 'not_met' if item_id in except_ids else 'met',
                'satisfied': item_id not in except_ids,
            }
            for item_id in item_ids
        },
        'violations': [],
    }


def run():
    ctx_dep = {'depressionRelated': True}
    ctx_plain = {'depressionRelated': False}

    # 1. 전 항목 충족 + 위반 0 → 100점, 전 영역 우수
    r = score_session(RUBRIC, judg(set(ALL_ITEM_IDS)), ctx_dep)
    assert r['totalScore'] == 100.0, r['totalScore']
    assert all(s['grade'] == 2 for s in r['sections'])

    # 2. 전 항목 미충족 + 위반 0 → 임상예의 10점만 (감점 없음)
    r = score_session(RUBRIC, judg(set()), ctx_dep)
    assert r['totalScore'] == 10.0, r['totalScore']
    assert section(r, 'etiquette')['grade'] == 2

    # 3. 임상예의 감점 하한: 위반 6회 → 10-12 → 0점 (floor)
    r = score_session(RUBRIC, judg(set(), [{'type': 'et02'}] * 6), ctx_dep)
    assert section(r, 'etiquette')['score'] == 0.0
    assert section(r, 'etiquette')['grade'] == 0
    assert r['totalScore'] == 0.0

    # 4. 절대 예외(§4.4-4): exempt 위반은 감점 제외
    r = score_session(RUBRIC, judg(set(), [{'type': 'et01', 'exempt': True}, {'type': 'et02'}]), ctx_dep)
    assert section(r, 'etiquette')['violationCount'] == 1
    assert section(r, 'etiquette')['score'] == 8.0

    # 5. 병력청취 부분점수·컷오프: 9/12 충족 → 26.3점(35×9/12), 등급 우수
    ht9 = {f'ht{i:02d}' for i in range(1, 10)}
    r = score_session(RUBRIC, judg(ht9), ctx_dep)
    s = section(r, 'history_taking')
    assert s['score'] == 26.3 and s['grade'] == 2, s
    # 8/12 → 보통, 4/12 → 미흡
    assert section(score_session(RUBRIC, judg({f'ht{i:02d}' for i in range(1, 9)}), ctx_dep), 'history_taking')['grade'] == 1
    assert section(score_session(RUBRIC, judg({f'ht{i:02d}' for i in range(1, 5)}), ctx_dep), 'history_taking')['grade'] == 0

    # 6. 환자교육 조건부 분기(§4.4-5): 우울 연관 아니면 ed05 제외 → 분모 5
    ed_all_but_05 = {'ed01', 'ed02', 'ed03', 'ed04', 'ed06'}
    r_plain = score_session(RUBRIC, judg(ed_all_but_05), ctx_plain)
    s = section(r_plain, 'patient_education')
    assert s['applicableCount'] == 5 and s['score'] == 15.0 and s['grade'] == 2, s
    # 같은 판정을 우울 연관 증례로 채점하면 분모 6 → 12.5점, 5/6은 우수(≥4)
    r_dep = score_session(RUBRIC, judg(ed_all_but_05), ctx_dep)
    s = section(r_dep, 'patient_education')
    assert s['applicableCount'] == 6 and s['score'] == 12.5 and s['grade'] == 2, s
    # 비우울 5항목 기준 컷오프: 3개 충족 → 우수(≥3), 2개 → 보통
    assert section(score_session(RUBRIC, judg({'ed01', 'ed02', 'ed04'}), ctx_plain), 'patient_education')['grade'] == 2
    assert section(score_session(RUBRIC, judg({'ed01', 'ed02'}), ctx_plain), 'patient_education')['grade'] == 1
    # ed05는 비우울 증례에서 판정이 와도 무시됨
    r = score_session(RUBRIC, judg({'ed05'}), ctx_plain)
    assert section(r, 'patient_education')['satisfiedCount'] == 0

    # 7. PPI 컷오프: 4/5 우수, 3/5 보통, 1/5 미흡
    assert section(score_session(RUBRIC, judg({'ppi01', 'ppi02', 'ppi03', 'ppi04'}), ctx_dep), 'ppi')['grade'] == 2
    assert section(score_session(RUBRIC, judg({'ppi01', 'ppi02', 'ppi03'}), ctx_dep), 'ppi')['grade'] == 1
    assert section(score_session(RUBRIC, judg({'ppi01'}), ctx_dep), 'ppi')['grade'] == 0

    # 8. 신체진찰: 4/6 우수 10점, 2/6 보통 5점
    pe4 = {'pe01', 'pe02', 'pe03', 'pe04'}
    s = section(score_session(RUBRIC, judg(pe4), ctx_dep), 'physical_exam')
    assert s['score'] == 10.0 and s['grade'] == 2, s

    # 9. 재현성: 동일 입력 → 동일 출력
    a = score_session(RUBRIC, judg(ht9, [{'type': 'et03'}]), ctx_dep)
    b = score_session(RUBRIC, judg(ht9, [{'type': 'et03'}]), ctx_dep)
    assert a == b

    # 10. 3상태 판정: 부분 수행은 0.5점, 목록과 피드백용 ID에 따로 남는다.
    partial_judgments = judg({'ht01'})
    partial_judgments['items']['ht02'] = {'status': 'partial', 'satisfied': False}
    s = section(score_session(RUBRIC, partial_judgments, ctx_dep), 'history_taking')
    assert s['earnedItemUnits'] == 1.5 and s['partialIds'] == ['ht02'], s

    # 11. 고위험 실신: 총점이 높아도 필수 응급행동 누락 시 전체 등급은 미흡으로 제한된다.
    r = score_session(
        SYNCOPE_RUBRIC,
        all_met_judgments(SYNCOPE_RUBRIC, {'ed06'}),
        {'caseId': 'cardiac_syncope_rule', 'depressionRelated': False},
    )
    assert r['totalScore'] >= 90 and r['overallGradeLabel'] == '미흡', r
    assert r['safetyGate']['triggered'][0]['missingItemIds'] == ['ed06'], r['safetyGate']

    # 12. 우울증 관련 인지저하: 자살위험 안전안내 누락도 동일하게 차단한다.
    r = score_session(
        MEMORY_RUBRIC,
        all_met_judgments(MEMORY_RUBRIC, {'ed05'}),
        {'caseId': 'pseudodementia_rule', 'depressionRelated': True},
    )
    assert r['overallGradeLabel'] == '미흡', r
    assert r['safetyGate']['triggered'][0]['missingItemIds'] == ['ed05'], r['safetyGate']

    print('전체', 12, '개 테스트 그룹 통과 ✅')


if __name__ == '__main__':
    run()
