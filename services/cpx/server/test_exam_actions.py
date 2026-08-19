"""진찰 버튼의 행위 표시·검사 분리·문 앞 정보 회귀 (2026-08-18 감사 가2·가3·가8)."""
from __future__ import annotations

import os
import tempfile
from pathlib import Path

os.environ['REQUIRE_LECTURELINK_AUTH'] = 'true'
os.environ['CPX_PROXY_SHARED_SECRET'] = 'offline-exam-actions-secret'

import db  # noqa: E402
import main  # noqa: E402
import physical_exam as pe  # noqa: E402
import prompt as pm  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

HEADERS = {
    'x-cpx-proxy-secret': 'offline-exam-actions-secret',
    'x-lecturelink-user-id': 'exam-actions-tester',
}
CASE_ID = 'ectopic_pregnancy_rule'   # 활력징후가 쇼크 수준이라 문 앞 정보의 의미가 분명한 증례


def _start(client) -> dict:
    r = client.post('/api/sessions', headers=HEADERS,
                    json={'caseId': CASE_ID, 'timeLimitSeconds': 720})
    assert r.status_code == 200, r.text
    return r.json()


def test_door_chart_gives_vitals_before_entry(client) -> None:
    """가8 — 쇼크 수준 혈압이 버튼 뒤에 숨어 있으면 안 된다."""
    created = _start(client)
    chart = created.get('doorChart')
    assert chart, '문 앞 정보가 없다'
    assert chart.get('vitals'), '활력징후가 문 앞 정보에 없다'
    assert '95/60' in chart['vitals'], f"케이스의 활력징후가 그대로 실려야 한다: {chart['vitals']}"
    for key in ('name', 'age', 'gender', 'chiefComplaint'):
        assert chart.get(key), f'문 앞 정보에 {key} 가 없다'
    print('  문 앞 정보(인적사항·활력징후) 통과')


def test_exam_and_test_buttons_are_separated() -> None:
    """가3 — 심전도·혈당·소변검사는 진찰이 아니라 검사다."""
    for case_id, expected_tests in (
        ('psvt_palpitation_rule', {'심전도 검사'}),
        ('first_generalized_convulsion_rule', {'혈당 확인'}),
    ):
        catalog = pe.button_catalog(pm.load_case(case_id))
        tests = {b['label'] for b in catalog if b['kind'] == pe.KIND_TEST}
        assert expected_tests <= tests, f'{case_id}: 검사로 분류되지 않았다 — {tests}'
        assert all(b['kind'] in (pe.KIND_EXAM, pe.KIND_TEST) for b in catalog)
    # 질경·검체는 실제 진찰이므로 검사로 분류하면 안 된다
    vag = pe.button_catalog(pm.load_case('bacterial_vaginosis_rule'))
    speculum = [b for b in vag if b['id'] == 'speculum']
    assert speculum and speculum[0]['kind'] == pe.KIND_EXAM, '질경 진찰은 진찰이다'
    print('  진찰/검사 분리 통과')


def test_button_action_is_marked_as_action_not_speech(client) -> None:
    """가2 — 버튼 클릭이 학생 발화처럼 기록되면 안 된다(무엇을 인정할지는 별도 결정)."""
    created = _start(client)
    sid = created['sessionId']
    catalog = pe.button_catalog(pm.load_case(CASE_ID))
    exam_button = next(b for b in catalog if b['kind'] == pe.KIND_EXAM)

    r = client.post(f'/api/sessions/{sid}/exam', headers=HEADERS,
                    json={'buttonId': exam_button['id'], 'tOffsetMs': 1000})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body['kind'] == pe.KIND_EXAM
    assert body['transcriptText'].startswith('[진찰 수행] '), body['transcriptText']
    assert body['declaration'] in body['transcriptText']

    events = client.get(f'/api/sessions/{sid}/transcript', headers=HEADERS).json()['events']
    recorded = [e for e in events if e['role'] == 'student']
    assert recorded, '전사에 기록되지 않았다'
    assert recorded[-1]['text'].startswith('[진찰 수행] '), recorded[-1]['text']
    print('  버튼 행위 표시 통과')


def test_grader_is_told_what_the_marker_means() -> None:
    """표시만 하고 채점기에 뜻을 알려주지 않으면 아무 효과가 없다."""
    import evaluate as ev
    case = pm.load_case(CASE_ID)
    rubric = ev.load_rubric(case)
    ctx = ev.build_context(case, pm.resolve_persona(case, 'marker'))
    prompt_text = ev.build_extraction_prompt(rubric, [], ctx, case)
    assert '[진찰 수행]' in prompt_text and '[검사 지시]' in prompt_text, '채점 프롬프트에 표시 설명이 없다'
    assert '말한 것이 아니라' in prompt_text
    print('  채점기 표시 설명 통과')


def main_() -> None:
    with tempfile.TemporaryDirectory(prefix='cpx-exam-actions-') as tmpdir:
        db.DB_PATH = Path(tmpdir) / 'cpx.sqlite3'
        main.GEMINI_API_KEY = 'offline-exam-actions'
        with TestClient(main.app) as client:
            test_door_chart_gives_vitals_before_entry(client)
            test_button_action_is_marked_as_action_not_speech(client)
    test_exam_and_test_buttons_are_separated()
    test_grader_is_told_what_the_marker_means()
    print('진찰 행위 표시·검사 분리·문 앞 정보 회귀 테스트 통과')


if __name__ == '__main__':
    main_()
