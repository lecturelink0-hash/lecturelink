"""CPX 운영 성능 계측 — 「성능지표 측정 및 검증 가이드」 1단계 자동 측정.

가이드가 1단계(§11 '지금 바로 내부 측정')로 지정한 항목 중 CPX에 해당하는 것:

  - 생성 성공률과 실패율            → request_metrics.status
  - p50, p95, p99 응답시간          → request_metrics.total_ms (+ stages 단계별)
  - 오류 코드별 빈도                → request_metrics.error_code
  - 스키마 준수율                   → request_metrics.schema_valid (채점 결과 계약 검사)
  - CPX 세션 완주율                 → sessions.status / end_reason
  - CPX 턴 응답시간                 → turn_metrics (발화 종료 → 응답 시작)
  - 세션당 비용                     → usage_events (usage.py 단가표)

이 모듈은 **집계와 판정만** 한다. 적재는 db.py, 수집은 main.py 미들웨어와 클라이언트가 맡는다.

측정값의 정의를 여기 한 곳에 모아 둔 이유: 대외 발표에 쓰는 수치는 "어떻게 셌는가"가
숫자만큼 중요하다(가이드 §10.3). 산식이 코드 여기저기 흩어지면 보고서와 코드가 갈라진다.
"""
import json
import time

# 계측 스키마 버전 — 필드 의미가 바뀌면 올린다. 보고서에 함께 싣는다.
METRICS_SCHEMA_VERSION = '1'

# 요청 상태 분류. 가이드 §4.1 '결과 상태(success, timeout, invalid_schema)'를 따르되,
# 4xx/5xx 를 나눈다 — 사용자 입력 오류(404 케이스 없음)와 서버 장애(502 추출 실패)를
# 같은 '실패율'에 뭉치면 개선 대상이 보이지 않는다.
STATUS_SUCCESS = 'success'
STATUS_CLIENT_ERROR = 'client_error'
STATUS_SERVER_ERROR = 'server_error'
STATUS_TIMEOUT = 'timeout'

# 세션 종료 사유 — 완주율(가이드 §2.1 '중단, 타임아웃, 재시작을 분리')의 분류축.
END_REASON_COMPLETED = 'completed'        # 학생이 [진료 종료]를 눌러 정상 종료
END_REASON_TIME_LIMIT = 'time_limit'      # 제한시간 소진으로 자동 종료 — 실제 시험과 동일, 완주로 센다
END_REASON_ABORTED = 'aborted'            # 학생이 중도 이탈
END_REASON_START_FAILED = 'start_failed'  # 연결·마이크 실패로 시작 직후 반납
END_REASON_SUPERSEDED = 'superseded'      # 다른 연습을 시작하려고 이전 세션을 정리
END_REASON_ERROR = 'error'                # 클라이언트가 오류로 판단해 종료
END_REASONS = {
    END_REASON_COMPLETED, END_REASON_TIME_LIMIT, END_REASON_ABORTED,
    END_REASON_START_FAILED, END_REASON_SUPERSEDED, END_REASON_ERROR,
}
# 클라이언트가 아무 말 없이 사라진 세션 — /end 가 오지 않아 상태가 active 로 남는다.
# 이탈은 '자동 일시정지'라 클라이언트가 /end 를 부르지 않는 것이 정책이므로(정책 7장),
# 집계 쪽에서 시간으로 판정한다. 아래 유예를 넘겨도 active 면 이탈로 센다.
END_REASON_ABANDONED = 'abandoned'
STALE_GRACE_SECONDS = 15 * 60
DEFAULT_TIME_LIMIT_SECONDS = 12 * 60
# 완주로 세는 사유. 제한시간 종료는 실제 CPX 시험의 정상 종료 형태이므로 완주다.
COMPLETED_REASONS = {END_REASON_COMPLETED, END_REASON_TIME_LIMIT}
# 분모에서 빼는 사유 — 학생이 진료를 해 볼 기회 자체가 없었던 세션.
# 연결 실패로 반납된 세션을 '중단'으로 세면 완주율이 인프라 장애율과 뒤섞인다.
# 이 세션들은 별도로 startFailureRate 로 보고한다.
EXCLUDED_FROM_COMPLETION = {END_REASON_START_FAILED, END_REASON_SUPERSEDED, 'active'}


def now() -> float:
    return time.time()


# ── 분포 통계 ────────────────────────────────────────────────────────────────

def percentile(values: list[float], p: float) -> float | None:
    """nearest-rank 백분위. 표본이 적을 때 보간법은 없는 값을 만들어 내므로 쓰지 않는다.

    p95 를 5개 표본에서 뽑으면 사실상 최댓값이다. 그래서 집계 결과에는 항상 count 를
    같이 실어, 표본이 적은 p95 를 성능 주장으로 쓰지 않도록 한다(가이드 §10.3).
    """
    if not values:
        return None
    ordered = sorted(values)
    if p <= 0:
        return float(ordered[0])
    rank = -(-len(ordered) * p // 100)  # ceil(len * p / 100)
    idx = min(int(rank), len(ordered)) - 1
    return float(ordered[max(idx, 0)])


def latency_stats(values: list[float]) -> dict:
    clean = [float(v) for v in values if v is not None]
    if not clean:
        return {'count': 0, 'p50': None, 'p95': None, 'p99': None, 'mean': None, 'max': None}
    return {
        'count': len(clean),
        'p50': percentile(clean, 50),
        'p95': percentile(clean, 95),
        'p99': percentile(clean, 99),
        'mean': round(sum(clean) / len(clean), 1),
        'max': max(clean),
    }


def _ratio(numerator: int, denominator: int) -> float | None:
    return round(numerator / denominator, 4) if denominator else None


# ── 채점 결과 스키마 준수 검사 ────────────────────────────────────────────────
# 가이드 §2.1 '스키마 준수율 — 필수 필드, 자료형, 허용 범위 검사'.
# 채점 결과 JSON은 프론트 결과 화면과 Supabase 미러가 함께 쓰는 계약이다. 필드가 빠지면
# 화면이 조용히 빈칸을 그리므로, 응답을 내보내기 전에 계약을 검사하고 위반을 계측에 남긴다.

RESULT_REQUIRED_FIELDS = {
    'totalScore': (int, float),
    'sections': list,
    'feedback': dict,
    'judgments': dict,
    'caseId': str,
    'itemTexts': dict,
    'timeAnalysis': dict,
    'clinicalReasoning': dict,
}
SECTION_REQUIRED_FIELDS = {'id': str, 'name': str, 'score': (int, float), 'weightPercent': (int, float)}


def validate_result_schema(result: dict) -> list[str]:
    """채점 결과 계약 위반 목록. 빈 리스트면 준수."""
    problems: list[str] = []
    if not isinstance(result, dict):
        return ['result:not_object']
    for field, expected in RESULT_REQUIRED_FIELDS.items():
        if field not in result:
            problems.append(f'missing:{field}')
        elif not isinstance(result[field], expected):
            problems.append(f'type:{field}')
    total = result.get('totalScore')
    if isinstance(total, (int, float)) and not (0 <= total <= 100):
        problems.append('range:totalScore')
    sections = result.get('sections')
    if isinstance(sections, list):
        if not sections:
            problems.append('empty:sections')
        for i, section in enumerate(sections):
            if not isinstance(section, dict):
                problems.append(f'type:sections[{i}]')
                continue
            for field, expected in SECTION_REQUIRED_FIELDS.items():
                if field not in section:
                    problems.append(f'missing:sections[{i}].{field}')
                elif not isinstance(section[field], expected):
                    problems.append(f'type:sections[{i}].{field}')
    return problems


# ── 집계 ─────────────────────────────────────────────────────────────────────

def _stage_map(raw: str | None) -> dict:
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError):
        return {}
    return parsed if isinstance(parsed, dict) else {}


def summarize_requests(rows: list[dict]) -> dict:
    """기능별 성공률·지연시간·오류 코드 분포. 가이드 §4.1 '권장 집계'."""
    by_feature: dict[str, dict] = {}
    error_codes: dict[str, int] = {}
    for row in rows:
        feature = row['feature']
        bucket = by_feature.setdefault(feature, {
            'feature': feature,
            'total': 0,
            'success': 0,
            'byStatus': {},
            'errorCodes': {},
            'latencies': [],
            'successLatencies': [],
            'stages': {},
            'schemaChecked': 0,
            'schemaValid': 0,
            'versions': set(),
            'models': set(),
        })
        bucket['total'] += 1
        status = row.get('status') or STATUS_SERVER_ERROR
        bucket['byStatus'][status] = bucket['byStatus'].get(status, 0) + 1
        total_ms = row.get('total_ms')
        if total_ms is not None:
            bucket['latencies'].append(total_ms)
        if status == STATUS_SUCCESS:
            bucket['success'] += 1
            if total_ms is not None:
                # 성공 요청만의 지연 — 실패는 즉시 끊기거나(4xx) 타임아웃 상한에 붙어(504)
                # 분포를 양쪽으로 왜곡한다. 사용자 체감은 성공 경로의 분포다.
                bucket['successLatencies'].append(total_ms)
        code = row.get('error_code')
        if code:
            bucket['errorCodes'][code] = bucket['errorCodes'].get(code, 0) + 1
            error_codes[code] = error_codes.get(code, 0) + 1
        for stage, ms in _stage_map(row.get('stages')).items():
            if isinstance(ms, (int, float)):
                bucket['stages'].setdefault(stage, []).append(ms)
        schema_valid = row.get('schema_valid')
        if schema_valid is not None:
            bucket['schemaChecked'] += 1
            bucket['schemaValid'] += 1 if schema_valid else 0
        if row.get('version'):
            bucket['versions'].add(row['version'])
        if row.get('model'):
            bucket['models'].add(row['model'])

    features = []
    for bucket in by_feature.values():
        features.append({
            'feature': bucket['feature'],
            'total': bucket['total'],
            'success': bucket['success'],
            'successRate': _ratio(bucket['success'], bucket['total']),
            'failureRate': _ratio(bucket['total'] - bucket['success'], bucket['total']),
            'byStatus': bucket['byStatus'],
            'errorCodes': dict(sorted(bucket['errorCodes'].items(), key=lambda kv: -kv[1])),
            'latencyMs': latency_stats(bucket['latencies']),
            'successLatencyMs': latency_stats(bucket['successLatencies']),
            'stageMs': {k: latency_stats(v) for k, v in sorted(bucket['stages'].items())},
            'schemaChecked': bucket['schemaChecked'],
            'schemaValid': bucket['schemaValid'],
            'schemaValidRate': _ratio(bucket['schemaValid'], bucket['schemaChecked']),
            'versions': sorted(bucket['versions']),
            'models': sorted(bucket['models']),
        })
    features.sort(key=lambda f: -f['total'])

    total = len(rows)
    success = sum(f['success'] for f in features)
    return {
        'total': total,
        'success': success,
        'successRate': _ratio(success, total),
        'failureRate': _ratio(total - success, total),
        'latencyMs': latency_stats([r['total_ms'] for r in rows if r.get('total_ms') is not None]),
        'errorCodes': dict(sorted(error_codes.items(), key=lambda kv: -kv[1])),
        'features': features,
    }


def summarize_turns(rows: list[dict]) -> dict:
    """턴 응답시간 — 발화 종료 → 응답 시작. 네트워크·입력 방식별로도 쪼갠다(가이드 §2.1)."""
    def stats_for(subset: list[dict]) -> dict:
        return {
            'turns': len(subset),
            'firstResponseMs': latency_stats([r['first_response_ms'] for r in subset]),
            'firstAudioMs': latency_stats([r['first_audio_ms'] for r in subset]),
            'turnCompleteMs': latency_stats([r['turn_complete_ms'] for r in subset]),
            'interruptedRate': _ratio(sum(1 for r in subset if r.get('interrupted')), len(subset)),
        }

    by_network: dict[str, list[dict]] = {}
    by_mode: dict[str, list[dict]] = {}
    for row in rows:
        by_network.setdefault(row.get('network') or 'unknown', []).append(row)
        by_mode.setdefault(row.get('input_mode') or 'voice', []).append(row)

    sessions = {r['session_id'] for r in rows}
    return {
        **stats_for(rows),
        'sessions': len(sessions),
        'turnsPerSession': round(len(rows) / len(sessions), 2) if sessions else None,
        'byNetwork': {k: stats_for(v) for k, v in sorted(by_network.items())},
        'byInputMode': {k: stats_for(v) for k, v in sorted(by_mode.items())},
    }


def _session_time_limit(row: dict) -> int:
    try:
        config = json.loads(row.get('config') or '{}')
    except (TypeError, ValueError):
        return DEFAULT_TIME_LIMIT_SECONDS
    limit = config.get('timeLimitSeconds') if isinstance(config, dict) else None
    return int(limit) if isinstance(limit, (int, float)) and limit > 0 else DEFAULT_TIME_LIMIT_SECONDS


def classify_session(row: dict, now_ts: float) -> str:
    """세션 1건의 결말. 완주율 분류축은 여기 한 곳에서만 정한다."""
    reason = row.get('end_reason')
    if reason:
        return reason
    if row.get('status') == 'ended' or row.get('ended_at'):
        # 사유 없이 끝난 세션 — 이 필드가 생기기 전 세션이거나 예전 클라이언트다.
        return 'unknown'
    started = row.get('started_at') or 0
    if now_ts - started > _session_time_limit(row) + STALE_GRACE_SECONDS:
        return END_REASON_ABANDONED
    return 'active'


def summarize_sessions(rows: list[dict], now_ts: float | None = None) -> dict:
    """세션 완주율. 중단·타임아웃·재시작을 분리해 센다(가이드 §2.1).

    분모에서 시작 실패·이전 세션 정리를 뺀다 — 진료를 해 볼 기회가 없던 세션까지 넣으면
    완주율이 인프라 장애율과 뒤섞여 무엇을 고쳐야 하는지 가리킨다.
    아직 진행 중일 수 있는 세션(active)도 분모에서 뺀다 — 끝나지 않은 세션을 미완주로
    세면 방금 시작한 연습 때문에 완주율이 내려간다.
    """
    now_ts = now() if now_ts is None else now_ts
    total = len(rows)
    by_reason: dict[str, int] = {}
    eligible = 0
    completed = 0
    scored = 0
    still_active = 0
    for row in rows:
        reason = classify_session(row, now_ts)
        by_reason[reason] = by_reason.get(reason, 0) + 1
        if reason == 'active':
            still_active += 1
        if reason in EXCLUDED_FROM_COMPLETION:
            continue
        eligible += 1
        if reason in COMPLETED_REASONS:
            completed += 1
        if row.get('scored'):
            scored += 1
    excluded = sum(by_reason.get(r, 0) for r in EXCLUDED_FROM_COMPLETION)
    return {
        'total': total,
        'eligible': eligible,
        'completed': completed,
        'completionRate': _ratio(completed, eligible),
        'scored': scored,
        'scoredRate': _ratio(scored, eligible),
        'active': still_active,
        'startFailures': by_reason.get(END_REASON_START_FAILED, 0),
        'startFailureRate': _ratio(by_reason.get(END_REASON_START_FAILED, 0), total),
        'excludedFromCompletion': excluded,
        'byEndReason': dict(sorted(by_reason.items(), key=lambda kv: -kv[1])),
    }


def summarize_cost(usage_rows: list[dict], usage_module) -> dict:
    """세션당 원가 — 가이드 §4.1 'CPX 10분 세션당 평균 비용'.

    턴이 하나도 없는 세션(연결 실패)은 평균에서 뺀다. 0원 세션이 분모에 섞이면
    '한 세션에 얼마 드는가'라는 질문의 답이 실제보다 싸게 나온다.
    """
    by_session: dict[str, list[dict]] = {}
    for row in usage_rows:
        by_session.setdefault(row['session_id'], []).append(row)
    per_session = []
    for session_id, rows in by_session.items():
        summary = usage_module.summarize(rows)
        per_session.append({'sessionId': session_id, 'usd': summary['usd'], 'turns': summary['turns'],
                            'liveUsd': summary['live']['usd'], 'evalUsd': summary['eval']['usd']})
    live_sessions = [s for s in per_session if s['turns'] > 0]
    costs = [s['usd'] for s in live_sessions]
    rate = usage_module.usd_krw_rate()
    mean_usd = sum(costs) / len(costs) if costs else 0.0
    return {
        'sessions': len(per_session),
        'liveSessions': len(live_sessions),
        'totalUsd': round(sum(s['usd'] for s in per_session), 6),
        'meanSessionUsd': round(mean_usd, 6),
        'meanSessionKrw': round(mean_usd * rate, 1),
        'p50SessionUsd': percentile(costs, 50),
        'p95SessionUsd': percentile(costs, 95),
        'meanLiveUsd': round(sum(s['liveUsd'] for s in live_sessions) / len(live_sessions), 6) if live_sessions else 0.0,
        'meanEvalUsd': round(sum(s['evalUsd'] for s in live_sessions) / len(live_sessions), 6) if live_sessions else 0.0,
        'usdKrwRate': rate,
    }


def build_summary(days: int, request_rows: list[dict], turn_rows: list[dict],
                  session_rows: list[dict], usage_rows: list[dict], usage_module,
                  generated_at: float | None = None) -> dict:
    """대시보드·보고서가 그대로 쓰는 1단계 지표 묶음."""
    generated_at = now() if generated_at is None else generated_at
    return {
        'schemaVersion': METRICS_SCHEMA_VERSION,
        'windowDays': days,
        'generatedAt': generated_at,
        'requests': summarize_requests(request_rows),
        'turns': summarize_turns(turn_rows),
        'sessions': summarize_sessions(session_rows, generated_at),
        'cost': summarize_cost(usage_rows, usage_module),
    }
