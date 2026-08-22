"""운영 성능 계측 회귀 테스트 — API 키 불필요(오프라인).

「성능지표 측정 및 검증 가이드」 1단계가 요구하는 자동 측정이 실제로 기록되고,
집계 산식이 가이드 §12.1 정의와 같은지 확인한다. 여기서 막고 싶은 것은 조용한 실패다 —
계측은 없어도 서비스가 도니까, 깨져도 아무도 모른 채 발표 직전에 빈 대시보드를 본다.
"""
import json
import os
import tempfile

# db/main 임포트 전에 임시 DB 경로 확정 (DB_PATH는 임포트 시점에 굳는다)
_tmpdir = tempfile.mkdtemp(prefix='cpx-metrics-test-')
os.environ['CPX_DB_PATH'] = os.path.join(_tmpdir, 'cpx.sqlite3')
os.environ.setdefault('REQUIRE_LECTURELINK_AUTH', 'false')
os.environ['CPX_USD_KRW'] = '1450'
os.environ['CPX_FEATURE_VERSION'] = 'test-v1'

from fastapi.testclient import TestClient  # noqa: E402

import db  # noqa: E402
import main  # noqa: E402
import metrics  # noqa: E402
import prompt as prompt_mod  # noqa: E402
import usage as usage_mod  # noqa: E402

client = TestClient(main.app)
USER_A = {'x-lecturelink-user-id': 'metrics-user-a'}
USER_B = {'x-lecturelink-user-id': 'metrics-user-b'}
ADMIN = {**USER_A, 'x-cpx-admin': '1'}


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


# ── 1. 분포 산식 ─────────────────────────────────────────────────────────────

def test_percentiles():
    values = list(range(1, 101))  # 1..100
    check(metrics.percentile(values, 50) == 50, 'p50')
    check(metrics.percentile(values, 95) == 95, 'p95')
    check(metrics.percentile(values, 99) == 99, 'p99')
    check(metrics.percentile([], 95) is None, '빈 표본은 None')
    check(metrics.percentile([7], 95) == 7, '표본 1개')
    # nearest-rank: 보간하지 않으므로 결과는 항상 실제 관측값이다
    check(metrics.percentile([10, 20, 30], 95) == 30, 'nearest-rank 는 실측값을 돌려준다')

    stats = metrics.latency_stats([100, 200, 300, None])
    check(stats['count'] == 3, 'None 은 표본에서 제외')
    check(stats['mean'] == 200.0, 'mean')
    check(stats['max'] == 300, 'max')
    check(metrics.latency_stats([])['p95'] is None, '빈 표본 통계')
    print('  분포 산식(nearest-rank p50/p95/p99) 통과')


# ── 2. 채점 결과 스키마 준수 검사 ─────────────────────────────────────────────

def valid_result() -> dict:
    return {
        'totalScore': 72.5,
        'sections': [{'id': 'history', 'name': '병력청취', 'score': 30, 'weightPercent': 40}],
        'feedback': {}, 'judgments': {}, 'caseId': 'c1', 'itemTexts': {},
        'timeAnalysis': {}, 'clinicalReasoning': {},
    }


def test_schema_validation():
    check(metrics.validate_result_schema(valid_result()) == [], '정상 결과는 위반 없음')

    missing = valid_result()
    del missing['feedback']
    check('missing:feedback' in metrics.validate_result_schema(missing), '필수 필드 누락 탐지')

    wrong_type = valid_result()
    wrong_type['sections'] = {}
    check('type:sections' in metrics.validate_result_schema(wrong_type), '자료형 위반 탐지')

    out_of_range = valid_result()
    out_of_range['totalScore'] = 120
    check('range:totalScore' in metrics.validate_result_schema(out_of_range), '허용 범위 위반 탐지')

    empty_sections = valid_result()
    empty_sections['sections'] = []
    check('empty:sections' in metrics.validate_result_schema(empty_sections), '빈 sections 탐지')

    bad_section = valid_result()
    bad_section['sections'] = [{'id': 'x', 'name': 'y', 'score': 'high', 'weightPercent': 10}]
    check('type:sections[0].score' in metrics.validate_result_schema(bad_section), '섹션 내부 자료형 위반 탐지')

    check(metrics.validate_result_schema([]) == ['result:not_object'], '객체가 아닌 입력')
    print('  채점 결과 스키마 준수 검사 통과')


# ── 3. 경로 → 기능 분류 ───────────────────────────────────────────────────────

def test_classify():
    cases = [
        ('POST', '/api/sessions', 'cpx_session_create', None),
        ('POST', '/api/sessions/abc123/evaluate', 'cpx_evaluate', 'abc123'),
        ('POST', '/api/sessions/abc123/live-token', 'cpx_live_token', 'abc123'),
        ('POST', '/api/sessions/abc123/turns', 'cpx_turn_metrics', 'abc123'),
        ('GET', '/api/sessions/abc123/transcript', 'cpx_transcript', 'abc123'),
        ('GET', '/api/cases', 'cpx_cases', None),
        ('GET', '/api/health', 'cpx_health', None),
        ('GET', '/api/usage/summary', 'cpx_usage_summary', None),
    ]
    for method, path, feature, session_id in cases:
        got = main.classify_request(method, path)
        check(got == (feature, session_id), f'{method} {path} → {got} (기대 {(feature, session_id)})')
    # 세션 id 가 기능 축에 새면 집계가 세션 수만큼 쪼개진다
    check(main.classify_request('POST', '/api/sessions/xyz/evaluate')[0]
          == main.classify_request('POST', '/api/sessions/qrs/evaluate')[0], '세션 id 는 기능 이름에 섞이지 않는다')
    # 대시보드 열람은 계측 대상이 아니다
    check(main.classify_request('GET', '/api/metrics/summary') == (None, None), '지표 조회는 계측하지 않는다')
    check(main.classify_request('GET', '/healthz') == (None, None), '/api 밖 경로는 계측하지 않는다')

    check(main.classify_status(200, None) == metrics.STATUS_SUCCESS, '2xx')
    check(main.classify_status(404, 'http_404') == metrics.STATUS_CLIENT_ERROR, '4xx')
    check(main.classify_status(502, 'extract_failed') == metrics.STATUS_SERVER_ERROR, '5xx')
    check(main.classify_status(504, 'evaluate_timeout') == metrics.STATUS_TIMEOUT, '타임아웃은 서버 오류와 분리')
    print('  경로→기능 분류·상태 분류 통과')


# ── 4. 미들웨어가 실제로 기록하는가 ───────────────────────────────────────────

def rows_for(feature: str) -> list[dict]:
    return [r for r in db.list_request_metrics(0) if r['feature'] == feature]


def test_middleware_records():
    before = len(rows_for('cpx_cases'))
    response = client.get('/api/cases', headers=USER_A)
    check(response.status_code == 200, '케이스 목록 200')
    check(response.headers.get('x-cpx-request-id'), '응답에 request_id 가 실린다')

    rows = rows_for('cpx_cases')
    check(len(rows) == before + 1, '성공 요청 1건이 기록된다')
    row = rows[0]
    check(row['status'] == metrics.STATUS_SUCCESS, f"성공 분류: {row['status']}")
    check(row['status_code'] == 200, '상태 코드')
    check(row['version'] == 'test-v1', '기능 버전이 기록된다 (버전 간 회귀 비교축)')
    check(row['user_id'] == 'metrics-user-a', '사용자 id')
    check(row['method'] == 'GET', 'HTTP 메서드')
    check(row['total_ms'] >= 0, '총 소요시간')
    check(row['request_id'] and row['request_id'] == response.headers['x-cpx-request-id'],
          '기록된 request_id 와 응답 헤더가 같아야 추적이 된다')

    # 실패도 분모에 들어가야 한다 — 실패가 기록되지 않으면 성공률이 항상 100%가 된다
    missing = client.post('/api/sessions', json={'caseId': 'no-such-case'}, headers=USER_A)
    check(missing.status_code == 404, '없는 케이스는 404')
    fail_rows = rows_for('cpx_session_create')
    check(any(r['status_code'] == 404 for r in fail_rows), '실패 요청이 기록된다')
    failed = next(r for r in fail_rows if r['status_code'] == 404)
    check(failed['status'] == metrics.STATUS_CLIENT_ERROR, '4xx 는 client_error')
    check(failed['error_code'] == 'http_404', f"오류 코드 기본값: {failed['error_code']}")
    print('  요청 미들웨어 기록(성공·실패·request_id·버전) 통과')


def test_stage_and_error_code():
    """단계별 시간과 명시적 오류 코드 — 병목 식별과 오류 분포의 전제."""
    case_id = prompt_mod.list_cases()[0]['id']
    created = client.post('/api/sessions', json={'caseId': case_id}, headers=USER_A).json()
    sid = created['sessionId']

    # 진행 중 세션 채점 → 409 + 명시적 오류 코드
    response = client.post(f'/api/sessions/{sid}/evaluate', headers=USER_A)
    check(response.status_code == 409, '진행 중 세션은 409')
    row = next(r for r in rows_for('cpx_evaluate') if r['session_id'] == sid)
    check(row['error_code'] == 'session_in_progress',
          f"명시 오류 코드가 기록돼야 같은 4xx 안의 원인 분포가 보인다: {row['error_code']}")
    check(row['status'] == metrics.STATUS_CLIENT_ERROR, '409 는 client_error')

    # 캐시 히트 경로의 단계 기록 — 결과를 직접 심고 재채점을 부른다(LLM 미호출)
    client.post(f'/api/sessions/{sid}/end', json={'reason': 'completed'}, headers=USER_A)
    db.set_result(sid, 'metrics-user-a', json.dumps(valid_result(), ensure_ascii=False))
    cached = client.post(f'/api/sessions/{sid}/evaluate', headers=USER_A)
    check(cached.status_code == 200, '캐시 채점 200')
    hit = [r for r in rows_for('cpx_evaluate') if r['session_id'] == sid and r['status_code'] == 200][0]
    stages = json.loads(hit['stages'] or '{}')
    check('cache_hit' in stages, f'캐시 히트가 단계로 분리돼야 채점 p95 가 왜곡되지 않는다: {stages}')
    check(hit['schema_valid'] == 1, '스키마 준수 여부가 기록된다')
    check(hit['model'], '모델명이 기록된다 (모델 교체 회귀 비교축)')

    # 계약 위반 결과는 schema_valid=0 으로 남되 응답은 막지 않는다
    broken = client.post('/api/sessions', json={'caseId': case_id}, headers=USER_A).json()['sessionId']
    client.post(f'/api/sessions/{broken}/end', json={'reason': 'completed'}, headers=USER_A)
    bad = valid_result()
    del bad['feedback']
    bad['totalScore'] = 999
    db.set_result(broken, 'metrics-user-a', json.dumps(bad, ensure_ascii=False))
    response = client.post(f'/api/sessions/{broken}/evaluate', headers=USER_A)
    check(response.status_code == 200, '계약 위반이어도 학생에게는 결과를 준다')
    violation = [r for r in rows_for('cpx_evaluate') if r['session_id'] == broken][0]
    check(violation['schema_valid'] == 0, '계약 위반이 계측에 남는다')
    print('  단계별 시간·명시 오류 코드·스키마 준수율 기록 통과')


# ── 5. 턴 응답시간 수집 ───────────────────────────────────────────────────────

def test_turn_metrics():
    case_id = prompt_mod.list_cases()[0]['id']
    sid = client.post('/api/sessions', json={'caseId': case_id}, headers=USER_A).json()['sessionId']

    events = [
        {'turnIndex': 0, 'inputMode': 'voice', 'speechEndOffsetMs': 5_000,
         'firstResponseMs': 900, 'firstAudioMs': 1_100, 'turnCompleteMs': 4_200, 'network': '4g'},
        {'turnIndex': 1, 'inputMode': 'text', 'speechEndOffsetMs': 20_000,
         'firstResponseMs': 700, 'firstAudioMs': 800, 'turnCompleteMs': 3_000,
         'interrupted': True, 'network': '3g'},
    ]
    saved = client.post(f'/api/sessions/{sid}/turns', json=events, headers=USER_A)
    check(saved.status_code == 200 and saved.json()['saved'] == 2, f'2건 저장: {saved.json()}')

    # 재전송(같은 turnIndex)은 무시 — 표본이 두 번 세어지면 p95 가 왜곡된다
    again = client.post(f'/api/sessions/{sid}/turns', json=events, headers=USER_A)
    check(again.json()['saved'] == 0, f'중복 턴은 저장하지 않는다: {again.json()}')
    check(len(db.get_turn_metrics(sid, 'metrics-user-a')) == 2, '중복 후에도 2건')

    # 범위를 벗어난 값은 서버가 막는다 — 음수 지연 하나가 분포 전체를 망친다
    bad = client.post(f'/api/sessions/{sid}/turns',
                      json=[{'turnIndex': 2, 'speechEndOffsetMs': 0, 'firstResponseMs': -1}], headers=USER_A)
    check(bad.status_code == 422, f'음수 지연은 거절: {bad.status_code}')
    huge = client.post(f'/api/sessions/{sid}/turns',
                       json=[{'turnIndex': 3, 'speechEndOffsetMs': 0, 'firstResponseMs': 999_999_999}], headers=USER_A)
    check(huge.status_code == 422, '비현실적 지연은 거절')

    # 남의 세션에는 쓸 수 없다
    other = client.post(f'/api/sessions/{sid}/turns', json=events, headers=USER_B)
    check(other.status_code == 404, f'타 사용자 세션은 404: {other.status_code}')

    summary = client.get(f'/api/sessions/{sid}/turns', headers=USER_A).json()['summary']
    check(summary['turns'] == 2, '요약 턴 수')
    check(summary['firstResponseMs']['p50'] in (700.0, 900.0), f"p50: {summary['firstResponseMs']}")
    check(summary['byNetwork']['4g']['turns'] == 1, '네트워크별 분리')
    check(summary['byInputMode']['text']['turns'] == 1, '입력 방식별 분리')
    check(summary['interruptedRate'] == 0.5, f"끼어들기 비율: {summary['interruptedRate']}")
    print('  턴 응답시간 수집(중복·범위·격리·세부 집계) 통과')


# ── 6. 세션 완주율 ────────────────────────────────────────────────────────────

def test_end_reason_and_completion():
    case_id = prompt_mod.list_cases()[0]['id']
    sid = client.post('/api/sessions', json={'caseId': case_id}, headers=USER_A).json()['sessionId']
    client.post(f'/api/sessions/{sid}/end', json={'reason': 'time_limit'}, headers=USER_A)
    check(db.get_session(sid, 'metrics-user-a')['end_reason'] == 'time_limit', '종료 사유 기록')

    # 뒤늦은 종료 요청이 사유를 덮으면 완주가 사라진다
    client.post(f'/api/sessions/{sid}/end', json={'reason': 'superseded'}, headers=USER_A)
    check(db.get_session(sid, 'metrics-user-a')['end_reason'] == 'time_limit', '첫 사유가 보존된다')

    # 본문 없는 예전 클라이언트도 그대로 받는다
    legacy = client.post('/api/sessions', json={'caseId': case_id}, headers=USER_A).json()['sessionId']
    response = client.post(f'/api/sessions/{legacy}/end', headers=USER_A)
    check(response.status_code == 200, f'본문 없는 종료 요청 호환: {response.status_code}')
    check(db.get_session(legacy, 'metrics-user-a')['end_reason'] is None, '사유 없음은 NULL')

    # 모르는 사유는 접는다 — 집계축이 무한히 늘어나지 않게
    weird = client.post('/api/sessions', json={'caseId': case_id}, headers=USER_A).json()['sessionId']
    client.post(f'/api/sessions/{weird}/end', json={'reason': 'ㅁㄴㅇㄹ'}, headers=USER_A)
    check(db.get_session(weird, 'metrics-user-a')['end_reason'] == 'unknown', '미등록 사유는 unknown 으로 접힌다')
    print('  종료 사유 기록·보존·정규화 통과')


def test_completion_math():
    nowts = 1_000_000.0
    config = json.dumps({'timeLimitSeconds': 720})
    rows = [
        {'end_reason': 'completed', 'status': 'ended', 'scored': 1, 'started_at': nowts - 900, 'config': config},
        {'end_reason': 'time_limit', 'status': 'ended', 'scored': 1, 'started_at': nowts - 900, 'config': config},
        {'end_reason': 'aborted', 'status': 'ended', 'scored': 0, 'started_at': nowts - 900, 'config': config},
        {'end_reason': 'start_failed', 'status': 'ended', 'scored': 0, 'started_at': nowts - 900, 'config': config},
        {'end_reason': 'superseded', 'status': 'ended', 'scored': 0, 'started_at': nowts - 900, 'config': config},
        # /end 가 오지 않은 채 유예를 넘긴 세션 → 이탈
        {'end_reason': None, 'status': 'active', 'scored': 0, 'started_at': nowts - 5_000, 'config': config},
        # 방금 시작해 아직 진행 중인 세션 → 분모에서 제외
        {'end_reason': None, 'status': 'active', 'scored': 0, 'started_at': nowts - 60, 'config': config},
    ]
    summary = metrics.summarize_sessions(rows, now_ts=nowts)
    check(summary['total'] == 7, '전체 세션 수')
    check(summary['byEndReason']['abandoned'] == 1, f"이탈 판정: {summary['byEndReason']}")
    check(summary['byEndReason']['active'] == 1, '진행 중 세션 분리')
    # 분모: completed, time_limit, aborted, abandoned = 4 (start_failed·superseded·active 제외)
    check(summary['eligible'] == 4, f"완주율 분모: {summary['eligible']}")
    check(summary['completed'] == 2, '완주 세션 수 (완주 = 정상 종료 + 제한시간 종료)')
    check(summary['completionRate'] == 0.5, f"완주율: {summary['completionRate']}")
    check(summary['scoredRate'] == 0.5, f"채점 도달률: {summary['scoredRate']}")
    check(summary['startFailures'] == 1, '시작 실패는 따로 보고')
    check(summary['active'] == 1, '진행 중')

    # 아직 진행 중인 세션만 있으면 완주율은 '아직 없음'이지 0% 가 아니다
    only_active = metrics.summarize_sessions(
        [{'end_reason': None, 'status': 'active', 'scored': 0, 'started_at': nowts - 60, 'config': config}],
        now_ts=nowts)
    check(only_active['completionRate'] is None, '표본 없음은 None — 0% 로 보고하면 거짓말이 된다')
    print('  완주율 산식(이탈 판정·분모 제외·표본 없음) 통과')


# ── 7. 요청 집계 ──────────────────────────────────────────────────────────────

def test_request_aggregation():
    rows = [
        {'feature': 'cpx_evaluate', 'status': 'success', 'total_ms': 1_000, 'error_code': None,
         'stages': json.dumps({'llm_extract': 800, 'scoring': 5}), 'schema_valid': 1,
         'version': 'v1', 'model': 'gemini-2.5-flash'},
        {'feature': 'cpx_evaluate', 'status': 'success', 'total_ms': 3_000, 'error_code': None,
         'stages': json.dumps({'llm_extract': 2_700, 'scoring': 7}), 'schema_valid': 0,
         'version': 'v1', 'model': 'gemini-2.5-flash'},
        {'feature': 'cpx_evaluate', 'status': 'timeout', 'total_ms': 75_000, 'error_code': 'evaluate_timeout',
         'stages': None, 'schema_valid': None, 'version': 'v1', 'model': 'gemini-2.5-flash'},
        {'feature': 'cpx_live_token', 'status': 'server_error', 'total_ms': 400,
         'error_code': 'token_create_failed', 'stages': None, 'schema_valid': None, 'version': 'v1', 'model': None},
    ]
    summary = metrics.summarize_requests(rows)
    check(summary['total'] == 4 and summary['success'] == 2, '전체/성공 수')
    check(summary['successRate'] == 0.5, f"전체 성공률: {summary['successRate']}")
    check(summary['errorCodes']['evaluate_timeout'] == 1, '오류 코드 분포')

    ev = next(f for f in summary['features'] if f['feature'] == 'cpx_evaluate')
    check(ev['total'] == 3 and ev['success'] == 2, '기능별 건수')
    check(round(ev['successRate'], 4) == 0.6667, f"기능별 성공률: {ev['successRate']}")
    check(ev['byStatus']['timeout'] == 1, '상태별 분포')
    # 타임아웃(75초)이 성공 지연 분포를 오염시키면 안 된다
    check(ev['successLatencyMs']['max'] == 3_000, f"성공 경로 지연: {ev['successLatencyMs']}")
    check(ev['latencyMs']['max'] == 75_000, '전체 지연에는 타임아웃도 포함')
    check(ev['stageMs']['llm_extract']['p50'] in (800.0, 2_700.0), '단계별 지연 집계')
    check(ev['schemaChecked'] == 2 and ev['schemaValid'] == 1, '스키마 검사 대상만 분모')
    check(ev['schemaValidRate'] == 0.5, f"스키마 준수율: {ev['schemaValidRate']}")
    print('  요청 집계(기능별 성공률·성공 경로 지연·단계·스키마 준수율) 통과')


def test_cost_aggregation():
    rows = [
        {'session_id': 's1', 'kind': 'live_turn', 'model': 'gemini-3.1-flash-live', 'prompt_tokens': 10_000,
         'response_tokens': 500, 'prompt_text_tokens': 10_000, 'prompt_audio_tokens': 0,
         'response_text_tokens': 500, 'response_audio_tokens': 0},
        # 연결만 되고 턴이 없던 세션 — 평균 원가에서 빠져야 한다
        {'session_id': 's2', 'kind': 'evaluate', 'model': 'gemini-2.5-flash', 'prompt_tokens': 1_000,
         'response_tokens': 100, 'prompt_text_tokens': 1_000, 'prompt_audio_tokens': 0,
         'response_text_tokens': 100, 'response_audio_tokens': 0},
    ]
    summary = metrics.summarize_cost(rows, usage_mod)
    check(summary['sessions'] == 2, '세션 수')
    check(summary['liveSessions'] == 1, '턴이 있던 세션만 원가 평균의 분모')
    expected = (10_000 * 0.75 + 500 * 4.50) / 1e6
    check(abs(summary['meanSessionUsd'] - expected) < 1e-9,
          f"세션당 평균 원가: {summary['meanSessionUsd']} != {expected}")
    check(summary['meanSessionKrw'] == round(expected * 1450, 1), '원화 환산')
    print('  세션당 원가 집계 통과')


# ── 8. 지표 조회 권한 ─────────────────────────────────────────────────────────

def test_metrics_endpoint():
    denied = client.get('/api/metrics/summary', headers=USER_A)
    check(denied.status_code == 403, f'관리자 헤더 없이는 거절(fail-closed): {denied.status_code}')

    allowed = client.get('/api/metrics/summary?days=7', headers=ADMIN)
    check(allowed.status_code == 200, f'관리자는 조회 가능: {allowed.status_code}')
    payload = allowed.json()
    for key in ('schemaVersion', 'windowDays', 'generatedAt', 'requests', 'turns', 'sessions', 'cost'):
        check(key in payload, f'요약에 {key} 가 있어야 한다')
    check(payload['windowDays'] == 7, '조회 기간')
    check(payload['requests']['total'] > 0, '앞선 테스트 요청들이 집계에 잡힌다')
    check(payload['turns']['turns'] > 0, '턴 지연 표본이 잡힌다')

    # 기간은 상한이 있다 — 무제한 조회로 전체 테이블을 긁지 않게
    clamped = client.get('/api/metrics/summary?days=9999', headers=ADMIN).json()
    check(clamped['windowDays'] == 90, f"기간 상한: {clamped['windowDays']}")
    print('  지표 조회 권한(fail-closed)·요약 응답 통과')


# ── 9. 계정 삭제 시 계측도 지운다 ─────────────────────────────────────────────

def test_account_deletion_clears_metrics():
    case_id = prompt_mod.list_cases()[0]['id']
    sid = client.post('/api/sessions', json={'caseId': case_id}, headers=USER_B).json()['sessionId']
    client.post(f'/api/sessions/{sid}/turns',
                json=[{'turnIndex': 0, 'speechEndOffsetMs': 1, 'firstResponseMs': 500}], headers=USER_B)
    check(len(db.get_turn_metrics(sid, 'metrics-user-b')) == 1, '턴 계측 기록됨')

    client.delete('/api/account-data', headers=USER_B)
    with db.connect() as conn:
        left_turns = conn.execute('SELECT COUNT(*) c FROM turn_metrics WHERE session_id = ?', (sid,)).fetchone()['c']
        left_requests = conn.execute(
            'SELECT COUNT(*) c FROM request_metrics WHERE user_id = ?', ('metrics-user-b',)).fetchone()['c']
    check(left_turns == 0, '계정 삭제 시 턴 계측도 지워진다')
    # 삭제 요청 자체의 계측 1건은 삭제 이후에 기록되므로 남는다 — 그 1건만 허용한다
    check(left_requests <= 1, f'요청 계측도 정리된다 (남은 {left_requests}건은 삭제 요청 자신)')
    print('  계정 데이터 삭제 시 계측 정리 통과')


def test_retention_purge():
    """보존 기간 정리 — 계측이 볼륨을 무한히 먹지 않는지."""
    old_ts = metrics.now() - 200 * 86400
    db.add_request_metric({
        'request_id': 'ancient', 'feature': 'cpx_cases', 'version': 'v0', 'user_id': 'metrics-user-a',
        'session_id': None, 'model': None, 'method': 'GET', 'status': 'success', 'status_code': 200,
        'error_code': None, 'total_ms': 5, 'stages': None, 'schema_valid': None, 'created_at': old_ts,
    })
    check(any(r['request_id'] == 'ancient' for r in db.list_request_metrics(0)), '오래된 행 심기')

    # 주기 제한 때문에 방금 돈 뒤에는 다시 돌지 않는다
    main._last_metrics_purge = 0.0
    purged = main.purge_metrics_if_due()
    check(purged is not None and purged['requests'] >= 1, f'보존 기간 초과 행이 지워진다: {purged}')
    check(not any(r['request_id'] == 'ancient' for r in db.list_request_metrics(0)), '오래된 행이 사라짐')
    check(main.purge_metrics_if_due() is None, '1시간 안에는 다시 돌지 않는다 (정리가 서비스보다 비싸지면 안 된다)')

    # 보존 기간 안의 행은 남는다
    check(len(db.list_request_metrics(0)) > 0, '최근 계측은 보존된다')
    print('  계측 보존 기간 정리(주기 제한 포함) 통과')


def main_test():
    test_percentiles()
    test_schema_validation()
    test_classify()
    test_middleware_records()
    test_stage_and_error_code()
    test_turn_metrics()
    test_end_reason_and_completion()
    test_completion_math()
    test_request_aggregation()
    test_cost_aggregation()
    test_metrics_endpoint()
    test_account_deletion_clears_metrics()
    test_retention_purge()
    print('운영 성능 계측 회귀 테스트 통과 — 요청 로그·턴 지연·완주율·원가·권한·보존 13그룹')


if __name__ == '__main__':
    main_test()
