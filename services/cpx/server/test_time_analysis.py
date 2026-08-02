"""단계별 사용 시간 계산(compute_time_analysis) 단위 테스트 — 결정론 검증."""
from evaluate import compute_time_analysis


def ev(role, text, t_ms):
    return {'role': role, 'text': text, 'tOffsetMs': t_ms}


EVENTS = [
    ev('student', '안녕하세요, 어디가 불편해서 오셨나요?', 0),          # L1
    ev('patient', '머리가 아파서요.', 8_000),                            # L2
    ev('student', '언제부터 아프셨어요?', 20_000),                       # L3
    ev('patient', '일주일 전부터요.', 30_000),                           # L4
    ev('student', '혈압을 측정하겠습니다.', 300_000),                    # L5
    ev('patient', '네.', 310_000),                                       # L6
    ev('student', '뇌막자극 징후를 확인하겠습니다.', 360_000),           # L7
    ev('student', '긴장형 두통이 의심됩니다. 스트레칭을 권해드려요.', 480_000),  # L8
    ev('patient', '알겠습니다.', 600_000),                               # L9
]


def phase_map(analysis):
    return {p['id']: p for p in analysis['phases']}


def run():
    # 1. LLM 경계 3개 → 표준 순서 분할, 다음 단계 시작 전까지가 해당 단계 시간
    llm = [
        {'phase': 'history_taking', 'startLine': 1},
        {'phase': 'physical_exam', 'startLine': 5},
        {'phase': 'patient_education', 'startLine': 8},
    ]
    a = compute_time_analysis(EVENTS, llm, 690)
    assert a['source'] == 'llm' and a['totalSeconds'] == 600 and a['timeLimitSeconds'] == 690, a
    m = phase_map(a)
    assert m['history_taking']['seconds'] == 300, m
    assert m['physical_exam']['seconds'] == 180, m
    assert m['patient_education']['seconds'] == 120, m
    assert sum(p['seconds'] for p in a['phases']) == a['totalSeconds']

    # 2. LLM 실패 + 진찰 버튼 선언 폴백 → 진찰 시작을 선언 이벤트 시각으로 잡는다
    a = compute_time_analysis(EVENTS, [], None, exam_declarations={'혈압을 측정하겠습니다.'})
    assert a['source'] == 'heuristic', a
    m = phase_map(a)
    assert m['physical_exam']['startSeconds'] == 300 and m['physical_exam']['seconds'] == 300, m
    assert m['history_taking']['startSeconds'] == 0 and m['history_taking']['seconds'] == 300, m
    assert 'patient_education' not in m

    # 3. 경계 정보가 전혀 없으면 총 시간만 보고 (단계 배열 비움)
    a = compute_time_analysis(EVENTS, [], None)
    assert a['source'] == 'unavailable' and a['phases'] == [] and a['totalSeconds'] == 600, a

    # 4. 잘못된 라인·미지의 단계는 무시, 중복 단계는 최초 것만
    llm_bad = [
        {'phase': 'physical_exam', 'startLine': 999},
        {'phase': 'closing', 'startLine': 3},
        {'phase': 'patient_education', 'startLine': 8},
        {'phase': 'patient_education', 'startLine': 9},
    ]
    a = compute_time_analysis(EVENTS, llm_bad, 720)
    m = phase_map(a)
    assert set(m) == {'history_taking', 'patient_education'}, m
    assert m['patient_education']['startSeconds'] == 480, m

    # 5. 세션 종료 시각이 마지막 발화 이후면 침묵 구간까지 총 시간에 포함
    session = {'started_at': 1000.0, 'ended_at': 1000.0 + 660.0}
    a = compute_time_analysis(EVENTS, [{'phase': 'history_taking', 'startLine': 1}], 660, session)
    assert a['totalSeconds'] == 660, a
    assert a['phases'][0]['seconds'] == 660, a

    # 6. 이벤트 없음 → None (채점 게이트가 먼저 막지만 방어)
    assert compute_time_analysis([], [], 720) is None

    print('전체 6개 테스트 그룹 통과 ✅')


if __name__ == '__main__':
    run()
