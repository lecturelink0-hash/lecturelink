"""순응도 낮은 환자 모드 회귀 검사 — 라이브러리 무결성·확률 게이트·샘플링 결정론·프롬프트 주입."""

import prompt


def run():
    lib = prompt.load_low_compliance_library()

    # 1) 라이브러리 무결성: id 중복 없음, 필수 필드, phase 값 검증
    seen_ids = set()
    for b in lib['behaviors']:
        assert b['id'] not in seen_ids, f"중복 id: {b['id']}"
        seen_ids.add(b['id'])
        assert b['phase'] in ('history', 'education'), b['id']
        assert b.get('name') and b.get('instruction'), b['id']
    assert any(b['phase'] == 'history' for b in lib['behaviors'])
    assert any(b['phase'] == 'education' for b in lib['behaviors'])

    excluded_categories = set(lib['excludedCategories'])
    metas = prompt.list_cases()

    # 2) 확률 게이트: 직접 선택 25% · 랜덤 실전 40% — 통과/미통과 시드가 모두 존재하고
    #    각 배정 비율이 목표 근방인지 확인한다. 연습 방식 매핑도 함께 검증.
    assert prompt.low_compliance_probability('random') == prompt.LOW_COMPLIANCE_PROBABILITY_RANDOM
    for mode in ('direct', 'recommendation', None):
        assert prompt.low_compliance_probability(mode) == prompt.LOW_COMPLIANCE_PROBABILITY_DIRECT
    sample_case = next(
        c for c in (prompt.load_case(m['id']) for m in metas)
        if c.get('category', '') not in excluded_categories
    )
    passing_seed = failing_seed = None
    trials = 400
    hits_direct = hits_random = 0
    for i in range(trials):
        s = f'seed-{i}'
        if prompt.resolve_low_compliance(sample_case, s):  # 기본값 = 직접 선택 25%
            hits_direct += 1
            passing_seed = passing_seed or s
        else:
            failing_seed = failing_seed or s
        if prompt.resolve_low_compliance(sample_case, s, prompt.LOW_COMPLIANCE_PROBABILITY_RANDOM):
            hits_random += 1
    assert passing_seed and failing_seed, '확률 게이트가 한쪽 결과만 낸다'
    ratio_direct = hits_direct / trials
    ratio_random = hits_random / trials
    assert 0.15 < ratio_direct < 0.35, f'직접 선택 배정 비율 {ratio_direct:.2f} — 25%에서 크게 벗어남'
    assert 0.30 < ratio_random < 0.50, f'랜덤 실전 배정 비율 {ratio_random:.2f} — 40%에서 크게 벗어남'
    # 25%를 통과한 시드는 40%에서도 반드시 통과한다 (같은 롤, 더 높은 임계값)
    assert hits_random >= hits_direct

    checked = excluded = guardian_cases = 0
    by_id = {b['id']: b for b in lib['behaviors']}
    for meta in metas:
        case = prompt.load_case(meta['id'])
        picked = prompt.resolve_low_compliance(case, passing_seed)
        # 3) 결정론: 같은 시드는 항상 같은 선택 (미통과 시드는 항상 빈 목록)
        assert picked == prompt.resolve_low_compliance(case, passing_seed), case['id']
        assert prompt.resolve_low_compliance(case, failing_seed) == [], case['id']

        if case.get('category', '') in excluded_categories:
            # 제외 카테고리는 확률을 통과한 시드에서도 행동이 배정되지 않는다
            assert picked == [], f"제외 카테고리에 행동 배정됨: {case['id']}"
            excluded += 1
            continue

        # 4) 세션당 병력 1 + 교육 1, phase 중복 없음
        assert 1 <= len(picked) <= 2, case['id']
        phases = [p['phase'] for p in picked]
        assert len(set(phases)) == len(phases), case['id']

        # 5) 보호자 전용 행동은 보호자 케이스에서만 나온다
        guardian = prompt._is_guardian_case(case)
        if guardian:
            guardian_cases += 1
        for p in picked:
            if by_id[p['id']].get('requiresGuardian'):
                assert guardian, f"보호자 아닌 케이스에 보호자 행동: {case['id']}"

        # 6) 프롬프트 주입: 행동이 있으면 블록 포함, 기본(모드 꺼짐)은 미포함
        ids = [p['id'] for p in picked]
        with_block = prompt.build_system_instruction(case['id'], low_compliance_ids=ids)
        assert '[순응도 낮은 환자 모드' in with_block, case['id']
        for p in picked:
            assert p['name'] in with_block, f"{case['id']}: {p['name']} 누락"
        base = prompt.build_system_instruction(case['id'])
        assert '[순응도 낮은 환자 모드' not in base, case['id']
        checked += 1

    # 7) 존재하지 않는 id·빈 목록은 블록을 만들지 않는다 (라이브러리 개편 내성)
    assert prompt.low_compliance_block(['no_such_behavior']) == ''
    assert prompt.low_compliance_block([]) == ''

    print(
        f'순응도 낮은 환자: 적용 {checked}개 · 제외 카테고리 {excluded}개 · 보호자 케이스 {guardian_cases}개 · '
        f'배정 비율 직접 {ratio_direct:.0%} (기대 25%) / 랜덤 {ratio_random:.0%} (기대 40%) 통과'
    )


if __name__ == '__main__':
    run()
