"""릴리스 게이트가 쓸 수 있는 상태인가 (2026-08-22 진단).

CPX_RELEASE_READY_ONLY 는 어느 쪽으로도 쓸 수 없는 상태였다.
  false — 임상 검수 미완(needs_clinical_review) 34건이 학생 목록에 그대로 나간다.
  true  — 릴리스 허용 상태(user_approved·release_ready)인 증례가 0건이라 목록이 통째로 빈다.

false 로 두는 것은 "임상 검수를 출품 이후로 유예한다"는 문서화된 결정이므로(README) 그대로 둔다.
여기서 닫는 것은 두 번째다 — 스위치를 켠 배포가 빈 카탈로그로 조용히 뜨는 대신 기동에 실패해야 한다.
학생에게 "증례가 없습니다"로 보이는 서비스는 이미 고장이고, 원인은 배포자만 고칠 수 있다.
"""
from __future__ import annotations

import os

os.environ.setdefault('REQUIRE_LECTURELINK_AUTH', 'false')

import main  # noqa: E402
import prompt as prompt_mod  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402


def test_gate_is_off_and_catalog_is_whole() -> None:
    """기본값 점검 — 게이트가 꺼져 있고 전체 증례가 나온다."""
    assert main.CPX_RELEASE_READY_ONLY is False, '기본값이 바뀌었다 — 켜려면 승인 증례부터 만들어야 한다'
    assert len(prompt_mod.list_cases()) == len(prompt_mod.list_cases(release_ready_only=False))
    print(f'  게이트 꺼짐 · 증례 {len(prompt_mod.list_cases())}건 전량 노출')


def test_turning_the_gate_on_with_no_approved_case_fails_loudly() -> None:
    """켰는데 통과하는 증례가 0건이면 조용히 빈 목록을 내주는 대신 기동을 실패시킨다."""
    approved = prompt_mod.list_cases(release_ready_only=True)
    original = main.CPX_RELEASE_READY_ONLY
    main.CPX_RELEASE_READY_ONLY = True
    try:
        if approved:
            # 승인 증례가 생긴 뒤 — 게이트는 이제 정상적으로 통과해야 한다
            main._assert_release_gate_is_usable()
            print(f'  승인 증례 {len(approved)}건 — 게이트 사용 가능')
            return
        try:
            main._assert_release_gate_is_usable()
        except RuntimeError as err:
            assert 'CPX_RELEASE_READY_ONLY' in str(err), f'원인을 알 수 없는 메시지: {err}'
            assert 'contentStatus' in str(err), '고치는 방법이 메시지에 없다'
            print('  릴리스 허용 0건 + 게이트 ON → 기동 실패 통과')
            return
        raise AssertionError(
            '릴리스 허용 증례가 0건인데 게이트가 통과했다 — 빈 카탈로그로 서비스가 뜬다'
        )
    finally:
        main.CPX_RELEASE_READY_ONLY = original


def test_cases_endpoint_reports_the_review_backlog() -> None:
    """게이트를 꺼 둔 동안 검수가 얼마나 밀려 있는지 운영이 볼 수 있어야 한다."""
    client = TestClient(main.app)
    body = client.get('/api/cases').json()
    counts = body['contentStatusCounts']
    assert sum(counts.values()) == len(body['cases']), '분포 합계가 목록 수와 다르다'
    assert body['releaseReadyOnly'] is False
    unreviewed = counts.get('needs_clinical_review', 0)
    print(f'  검수 상태 분포 노출 통과: {counts} (임상 검수 미완 {unreviewed}건)')


if __name__ == '__main__':
    test_gate_is_off_and_catalog_is_whole()
    test_turning_the_gate_on_with_no_approved_case_fails_loudly()
    test_cases_endpoint_reports_the_review_backlog()
    print('릴리스 게이트 회귀 테스트 통과')
