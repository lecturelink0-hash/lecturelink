"""채점기가 케이스를 아는지 확인하는 회귀 테스트 (2026-08-18 감사 P0-1).

감사 시점의 채점 프롬프트에는 케이스·진단·진찰 소견이 하나도 들어가지 않았다. 그래서
거미막하출혈 환자에게 "긴장형 두통 같으니 CT 는 필요 없습니다"라고 해도 추정 진단 설명·검사
계획 항목이 충족으로 채점됐다. 모델 호출 없이 프롬프트 구성과 판정 정규화만 검사한다.
"""
from __future__ import annotations

import evaluate as ev
import prompt as pm


def test_case_brief_carries_the_answer_key() -> None:
    case = pm.load_case('thunderclap_sah_rule')
    brief = ev.build_case_brief(case)
    assert case['targetDiagnosis'] in brief, '정답 진단이 채점자에게 전달되지 않는다'
    assert '채점자 전용' in brief
    for label in ('반드시 확인해야 할 것', '환자가 가진 단서', '진찰하면 나오는 소견'):
        assert label in brief, f'{label} 이 빠졌다'
    # 케이스가 없으면(구버전 세션 재채점 등) 빈 문자열이어야 한다
    assert ev.build_case_brief(None) == ''
    print('  증례 정답지 구성 확인')


def test_prompt_includes_case_and_content_rule() -> None:
    case = pm.load_case('thunderclap_sah_rule')
    rubric = ev.load_rubric(case)
    context = ev.build_context(case, {'gender': '여성'})
    events = [{'role': 'student', 'text': '언제부터 아프셨어요?', 'tOffsetMs': 1000}]

    with_case = ev.build_extraction_prompt(rubric, events, context, case)
    assert case['targetDiagnosis'] in with_case, '프롬프트에 진단이 안 들어갔다'
    assert '내용' in with_case and '타당할 때만 met' in with_case, '내용 정확성 규칙이 없다'
    assert 'clinicalReasoning' in with_case, '임상추론 판정 지시가 없다'
    # 병명을 맞히지 못해도 안전한 접근이면 인정하라는 단서가 있어야 한다
    assert '병명 맞히기가 아니라' in with_case

    without_case = ev.build_extraction_prompt(rubric, events, context)
    assert case['targetDiagnosis'] not in without_case
    assert len(with_case) > len(without_case)
    print(f'  프롬프트에 증례 주입 확인 (+{len(with_case) - len(without_case):,}자)')


def test_reasoning_normalization() -> None:
    ok = ev.normalize_clinical_reasoning({
        'statedImpression': ' 긴장형 두통 ',
        'impressionConsistent': 'contradictory',
        'dangerousDiagnosisAddressed': False,
        'planAppropriate': 'harmful',
        'evidence': ['L040 의사: CT는 필요 없습니다', '  '],
    })
    assert ok['statedImpression'] == '긴장형 두통'
    assert ok['impressionConsistent'] == 'contradictory'
    assert ok['planAppropriate'] == 'harmful'
    assert ok['evidence'] == ['L040 의사: CT는 필요 없습니다']

    # 모델이 이상한 값을 주거나 필드를 빠뜨려도 중립값으로 고정된다
    for bad in (None, {}, {'impressionConsistent': '아무말', 'planAppropriate': 42}):
        got = ev.normalize_clinical_reasoning(bad)
        assert got['impressionConsistent'] == 'not_stated'
        assert got['planAppropriate'] == 'not_stated'
        assert got['dangerousDiagnosisAddressed'] is False
    print('  임상추론 판정 정규화 확인')


def test_empty_session_has_reasoning_shape() -> None:
    case = pm.load_case('thunderclap_sah_rule')
    rubric = ev.load_rubric(case)
    context = ev.build_context(case, {'gender': '여성'})
    empty = ev.empty_judgments(rubric, context)
    assert 'clinicalReasoning' in empty, '조기 종료 세션에 임상추론 필드가 없다'
    assert empty['clinicalReasoning']['impressionConsistent'] == 'not_stated'
    print('  발화 없는 세션 결과 형태 확인')


def test_feedback_surfaces_reasoning_and_gate() -> None:
    import scoring

    case = pm.load_case('thunderclap_sah_rule')
    rubric = ev.load_rubric(case)
    context = ev.build_context(case, {'gender': '여성'})
    judgments = {'items': {}, 'violations': [], 'phases': []}
    for section in rubric['sections']:
        for item in section['items']:
            judgments['items'][item['id']] = {
                'satisfied': True, 'status': 'met', 'evidence': ['L001'], 'confidence': 'high'}
    judgments['items']['ed02'] = {'satisfied': False, 'status': 'not_met', 'evidence': [], 'confidence': 'high'}

    result = scoring.score_session(rubric, judgments, context)
    reasoning = ev.normalize_clinical_reasoning({
        'statedImpression': '긴장형 두통',
        'impressionConsistent': 'contradictory',
        'dangerousDiagnosisAddressed': False,
        'planAppropriate': 'harmful',
    })
    feedback = ev.build_feedback(rubric, result, reasoning)
    assert feedback['reasoningNotes'], '임상추론 피드백이 비었다'
    assert any('배제하지 않은' in n for n in feedback['reasoningNotes'])
    assert feedback['safetyGateNotes'], '게이트 메시지가 피드백에 없다'
    print(f"  피드백 연결 확인 (추론 {len(feedback['reasoningNotes'])}건 · 게이트 {len(feedback['safetyGateNotes'])}건)")


def main() -> None:
    test_case_brief_carries_the_answer_key()
    test_prompt_includes_case_and_content_rule()
    test_reasoning_normalization()
    test_empty_session_has_reasoning_shape()
    test_feedback_surfaces_reasoning_and_gate()
    print('케이스 인지 채점 회귀 테스트 통과')


if __name__ == '__main__':
    main()
