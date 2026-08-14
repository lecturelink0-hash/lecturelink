"""순응도 낮은 환자 모드 회귀 검사 — 라이브러리 무결성·샘플링 결정론·프롬프트 주입."""

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
    checked = excluded = guardian_cases = 0
    for meta in prompt.list_cases():
        case = prompt.load_case(meta['id'])
        picked = prompt.resolve_low_compliance(case, 'seed-1')
        # 2) 결정론: 같은 시드는 항상 같은 선택
        assert picked == prompt.resolve_low_compliance(case, 'seed-1'), case['id']

        if case.get('category', '') in excluded_categories:
            assert picked == [], f"제외 카테고리에 행동 배정됨: {case['id']}"
            excluded += 1
            continue

        # 3) 세션당 병력 1 + 교육 1, phase 중복 없음
        assert 1 <= len(picked) <= 2, case['id']
        phases = [p['phase'] for p in picked]
        assert len(set(phases)) == len(phases), case['id']

        # 4) 보호자 전용 행동은 보호자 케이스에서만 나온다
        by_id = {b['id']: b for b in lib['behaviors']}
        guardian = prompt._is_guardian_case(case)
        if guardian:
            guardian_cases += 1
        for p in picked:
            if by_id[p['id']].get('requiresGuardian'):
                assert guardian, f"보호자 아닌 케이스에 보호자 행동: {case['id']}"

        # 5) 프롬프트 주입: 모드 켜면 블록 포함, 기본은 미포함
        ids = [p['id'] for p in picked]
        with_block = prompt.build_system_instruction(case['id'], low_compliance_ids=ids)
        assert '[순응도 낮은 환자 모드' in with_block, case['id']
        for p in picked:
            assert p['name'] in with_block, f"{case['id']}: {p['name']} 누락"
        base = prompt.build_system_instruction(case['id'])
        assert '[순응도 낮은 환자 모드' not in base, case['id']
        checked += 1

    # 6) 존재하지 않는 id는 조용히 건너뛴다 (라이브러리 개편 내성)
    assert prompt.low_compliance_block(['no_such_behavior']) == ''

    print(
        f'순응도 낮은 환자 모드: 적용 {checked}개 · 제외 카테고리 {excluded}개 · '
        f'보호자 케이스 {guardian_cases}개 통과'
    )


if __name__ == '__main__':
    run()
