"""§4.8 산식 단위 테스트 — Phase 4 완료 조건의 경계값 케이스."""
import json
from pathlib import Path

from scoring import round1, score_session

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

    # 5. 병력청취 부분점수·컷오프 — 세분화 이후 항목 수가 변할 수 있어 구조 기반으로 검증
    hist = next(s for s in RUBRIC['sections'] if s['id'] == 'history_taking')
    h_ids = [i['id'] for i in hist['items']]
    n_h = len(h_ids)
    h_exc, h_fair = hist['gradeCutoffs']['excellent'], hist['gradeCutoffs']['fairMin']
    ht_exc = set(h_ids[:h_exc])
    r = score_session(RUBRIC, judg(ht_exc), ctx_dep)
    s = section(r, 'history_taking')
    assert s['score'] == round1(hist['weightPercent'] * h_exc / n_h) and s['grade'] == 2, s
    # 우수 미달·보통 이상 → 보통, 보통 미달 → 미흡
    if h_fair <= h_exc - 1:
        assert section(score_session(RUBRIC, judg(set(h_ids[:h_exc - 1])), ctx_dep), 'history_taking')['grade'] == 1
    assert section(score_session(RUBRIC, judg(set(h_ids[:h_fair - 1])), ctx_dep), 'history_taking')['grade'] == 0

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

    # 8. 신체진찰: 우수 컷 충족 수만큼 부분점수 — 구조 기반 검증
    pe_sec = next(s for s in RUBRIC['sections'] if s['id'] == 'physical_exam')
    pe_ids = [i['id'] for i in pe_sec['items']]
    pe_exc = pe_sec['gradeCutoffs']['excellent']
    s = section(score_session(RUBRIC, judg(set(pe_ids[:pe_exc])), ctx_dep), 'physical_exam')
    assert s['score'] == round1(pe_sec['weightPercent'] * pe_exc / len(pe_ids)) and s['grade'] == 2, s

    # 9. 재현성: 동일 입력 → 동일 출력
    a = score_session(RUBRIC, judg(ht_exc, [{'type': 'et03'}]), ctx_dep)
    b = score_session(RUBRIC, judg(ht_exc, [{'type': 'et03'}]), ctx_dep)
    assert a == b

    # 10. 3상태 판정: 부분 수행은 0.5점, 목록과 피드백용 ID에 따로 남는다.
    partial_judgments = judg({'ht01'})
    partial_judgments['items']['ht02'] = {'status': 'partial', 'satisfied': False}
    s = section(score_session(RUBRIC, partial_judgments, ctx_dep), 'history_taking')
    assert s['earnedItemUnits'] == 1.5 and s['partialIds'] == ['ht02'], s

    # 11. 고위험 실신: 총점이 높아도 필수 응급행동 누락 시 전체 등급은 미흡으로 제한된다.
    sy_gate = SYNCOPE_RUBRIC['safetyGates'][0]
    sy_miss = sy_gate['requiredItemIds'][-1]
    r = score_session(
        SYNCOPE_RUBRIC,
        all_met_judgments(SYNCOPE_RUBRIC, {sy_miss}),
        {'caseId': sy_gate['caseIds'][0], 'depressionRelated': False},
    )
    assert r['totalScore'] >= 90 and r['overallGradeLabel'] == '미흡', r
    assert r['safetyGate']['triggered'][0]['missingItemIds'] == [sy_miss], r['safetyGate']

    # 12. 우울증 관련 인지저하: 자살위험 안전안내 누락도 동일하게 차단한다.
    ml_gate = MEMORY_RUBRIC['safetyGates'][0]
    ml_miss = ml_gate['requiredItemIds'][-1]
    r = score_session(
        MEMORY_RUBRIC,
        all_met_judgments(MEMORY_RUBRIC, {ml_miss}),
        {'caseId': ml_gate['caseIds'][0], 'depressionRelated': True},
    )
    assert r['overallGradeLabel'] == '미흡', r
    assert r['safetyGate']['triggered'][0]['missingItemIds'] == [ml_miss], r['safetyGate']

    # 13. 전 루브릭 회귀: 세분화 이후에도 만점 100·빈 판정 10(임상예의만)·전 영역 등급 정합
    ctx_all = {'depressionRelated': True, 'femalePatient': True}
    checked = 0
    for path in sorted(DATA_DIR.glob('canonical_rubric.*.json')):
        rub = json.loads(path.read_text())
        full = score_session(rub, all_met_judgments(rub), ctx_all)
        assert full['totalScore'] == 100.0, (path.name, full['totalScore'])
        assert all(s['grade'] == 2 for s in full['sections']), path.name
        empty = score_session(rub, {'items': {}, 'violations': []}, ctx_all)
        assert empty['totalScore'] == 10.0, (path.name, empty['totalScore'])
        checked += 1
    assert checked >= 54, checked

    # 14. 신체진찰 면제(physicalExamRequired=False): 진찰 영역 제외 + 나머지 85 → 100 재정규화
    ctx_no_pe = {'depressionRelated': True, 'physicalExamRequired': False}
    r = score_session(RUBRIC, judg(set(ALL_ITEM_IDS)), ctx_no_pe)
    assert r['totalScore'] == 100.0, r['totalScore']
    assert all(s['id'] != 'physical_exam' for s in r['sections']), '진찰 영역이 sections에 남음'
    assert r['excludedSections'][0]['id'] == 'physical_exam' and r['excludedSections'][0]['weightPercent'] == 15
    # 병력만 전부 충족(35) + 임상예의(10) = 45 → ×100/85 = 52.9
    ht_ids = {i['id'] for s in RUBRIC['sections'] if s['id'] == 'history_taking' for i in s['items']}
    r = score_session(RUBRIC, judg(ht_ids), ctx_no_pe)
    assert r['totalScore'] == 52.9, r['totalScore']
    # 플래그 없으면(기본) 기존 산식 그대로 — 진찰 미수행이 그대로 감점
    r = score_session(RUBRIC, judg(ht_ids), ctx_dep)
    assert r['totalScore'] == 45.0, r['totalScore']
    assert 'excludedSections' not in r

    print('전체', 14, '개 테스트 그룹 통과 ✅ (전 루브릭', checked, '종 회귀 포함)')


if __name__ == '__main__':
    run()
