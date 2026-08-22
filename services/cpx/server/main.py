"""렉처링크 CPX 백엔드 (FastAPI).

역할:
- ephemeral token 발급 (§5 옵션 A) — 시스템 프롬프트를 liveConnectConstraints에 잠가
  API 키·진단명 모두 클라이언트에 노출하지 않는다.
- 세션·전사 저장 (§5 전사 파이프라인) — 채점(§4.7)의 근거 인용 소스.

실행:
    cd server && python3 -m venv venv && venv/bin/pip install -r requirements.txt
    cp .env.example .env  # GEMINI_API_KEY 기입
    venv/bin/uvicorn main:app --port 8787 --reload
"""
import contextlib
import datetime as dt
import hmac
import json
import os
import time
import uuid
from typing import Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import db
import metrics as metrics_mod
import prompt as prompt_mod

load_dotenv()

GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
LIVE_MODEL = os.environ.get('GEMINI_LIVE_MODEL', 'gemini-3.1-flash-live-preview')
# 개발 편의: constraints 잠금이 문제를 일으키면 false로 두고 클라이언트 구성 폴백 사용
LOCK_CONSTRAINTS = os.environ.get('LOCK_CONSTRAINTS', 'true').lower() != 'false'
# 기본값은 '켜짐'이다. 예전 기본값은 false 라, 환경변수를 빠뜨린 배포가 조용히 인증 없이
# 열렸다 — 안전 실패(fail-closed)여야 할 자리에서 열린 쪽으로 실패했다(2026-08-18 감사 P2).
# 로컬 개발은 .env 에 REQUIRE_LECTURELINK_AUTH=false 를 명시해서 끈다.
REQUIRE_LECTURELINK_AUTH = os.environ.get('REQUIRE_LECTURELINK_AUTH', 'true').lower() != 'false'
CPX_PROXY_SHARED_SECRET = os.environ.get('CPX_PROXY_SHARED_SECRET', '')
# 운영에서는 사용자 임상 승인이 끝난 케이스만 노출한다. 로컬 작성·검수 환경은 기본값(false)으로
# 전체 케이스를 보되, 실제 서비스 환경에서만 true로 설정한다.
CPX_RELEASE_READY_ONLY = os.environ.get('CPX_RELEASE_READY_ONLY', 'false').lower() == 'true'


def _assert_release_gate_is_usable() -> None:
    """이 스위치를 켰는데 통과하는 케이스가 하나도 없으면 즉시 죽는다.

    2026-08-22 실측: 릴리스 허용 상태(user_approved·release_ready)인 증례가 0건이라
    이 스위치는 켜는 순간 목록이 통째로 비고, 학생에게는 "증례가 없다"로만 보인다.
    끄면 임상 검수 미완 34건이 그대로 나가고 켜면 0건이 나가는, 어느 쪽도 쓸 수 없는 상태다.

    조용히 빈 목록을 내주는 대신 배포를 실패시킨다 — 빈 카탈로그로 뜬 서비스는 이미 고장이고,
    그걸 기동 실패로 드러내야 배포자가 원인을 안다. 임상 승인이 끝나 증례에
    contentStatus: user_approved 가 붙으면 이 검사는 저절로 통과한다.
    """
    if not CPX_RELEASE_READY_ONLY:
        return
    approved = prompt_mod.list_cases(release_ready_only=True)
    if approved:
        return
    counts: dict[str, int] = {}
    for c in prompt_mod.list_cases():
        counts[c['contentStatus']] = counts.get(c['contentStatus'], 0) + 1
    raise RuntimeError(
        'CPX_RELEASE_READY_ONLY=true 인데 릴리스 허용 상태('
        + ' · '.join(sorted(prompt_mod.RELEASE_STATUSES))
        + ')인 증례가 0건이라 목록이 비어 버린다. '
        f'현재 검수 상태 분포: {counts}. '
        '증례에 contentStatus 를 부여하거나, 임상 검수 전이라면 이 스위치를 false 로 두어라.'
    )


_assert_release_gate_is_usable()
# 계측 레코드의 '기능 버전' — 모델·프롬프트를 바꾼 배포에서 올리면 버전 간 회귀 비교가 된다
# (가이드 §4.1 '기능 및 버전'). 배포 파이프라인에서 커밋 해시를 넣어도 된다.
CPX_FEATURE_VERSION = os.environ.get('CPX_FEATURE_VERSION', 'cpx-v1')
# 운영 지표 계측 자체를 끄는 스위치. 기본은 켜짐 — 끄면 1단계 실측이 통째로 사라지므로
# 장애 대응 등 예외 상황에서만 쓴다.
CPX_METRICS_ENABLED = os.environ.get('CPX_METRICS_ENABLED', 'true').lower() != 'false'
# 계측 보존 기간(일). 요청마다 한 줄씩 쌓이므로 상한이 없으면 볼륨이 언젠가 찬다.
try:
    CPX_METRICS_RETENTION_DAYS = max(1, int(os.environ.get('CPX_METRICS_RETENTION_DAYS', '90')))
except ValueError:
    CPX_METRICS_RETENTION_DAYS = 90

app = FastAPI(title='lecturelink-cpx')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:5173', 'http://127.0.0.1:5173'],
    allow_methods=['*'],
    allow_headers=['*'],
)


# ── 운영 성능 계측 (성능지표 가이드 1단계 §4.1) ───────────────────────────────
# 모든 API 요청에 request_id 를 부여하고 기능·버전·단계별 시간·결과 상태·오류 코드를
# 한 레코드로 남긴다. 성공률, p50/p95/p99, 오류 코드 분포가 전부 이 한 테이블에서 나온다.

# 세션 하위 경로 → 기능 이름. 경로를 그대로 쓰면 세션 id 가 기능 축에 섞여 집계가 무너진다.
_SESSION_FEATURES = {
    'live-token': 'cpx_live_token',
    'events': 'cpx_events',
    'usage': 'cpx_usage',
    'turns': 'cpx_turn_metrics',
    'exam': 'cpx_exam',
    'end': 'cpx_session_end',
    'evaluate': 'cpx_evaluate',
    'transcript': 'cpx_transcript',
    'review-notes': 'cpx_review_notes_save',
}
_ROOT_FEATURES = {
    'cases': 'cpx_cases',
    'exam-buttons': 'cpx_exam_buttons',
    'history': 'cpx_history',
    'review-notes': 'cpx_review_notes',
    'health': 'cpx_health',
    'account-data': 'cpx_account_delete',
    'usage': 'cpx_usage_summary',
}


def classify_request(method: str, path: str) -> tuple[str | None, str | None]:
    """요청 경로 → (기능 이름, 세션 id). 계측 대상이 아니면 (None, None)."""
    parts = [p for p in path.split('/') if p]
    if len(parts) < 2 or parts[0] != 'api':
        return None, None
    parts = parts[1:]
    root = parts[0]
    # 대시보드 열람은 계측하지 않는다 — 지표를 보는 행위가 지표에 섞이면 성공률이 희석된다.
    if root == 'metrics':
        return None, None
    if root == 'sessions':
        if len(parts) == 1:
            return ('cpx_session_create' if method == 'POST' else 'cpx_sessions'), None
        sub = parts[2] if len(parts) > 2 else ''
        return _SESSION_FEATURES.get(sub, f"cpx_session_{sub or 'detail'}"), parts[1]
    return _ROOT_FEATURES.get(root, f"cpx_{root.replace('-', '_')}"), None


def classify_status(status_code: int, error_code: str | None) -> str:
    """가이드 §4.1 '결과 상태'. 타임아웃은 서버 오류와 분리한다 — 원인도 대응도 다르다."""
    if status_code == 504 or error_code == 'evaluate_timeout':
        return metrics_mod.STATUS_TIMEOUT
    if status_code < 400:
        return metrics_mod.STATUS_SUCCESS
    if status_code < 500:
        return metrics_mod.STATUS_CLIENT_ERROR
    return metrics_mod.STATUS_SERVER_ERROR


@contextlib.contextmanager
def stage(request: Request | None, name: str):
    """단계별 소요 시간(ms)을 request.state.stages 에 누적 — 병목 단계 식별용.

    같은 이름이 여러 번 열리면 합산한다(재시도 포함 총 소요). 계측이 없는 호출 경로
    (테스트·오프라인 앱)에서도 그냥 지나가도록 request 가 없으면 아무것도 하지 않는다.
    """
    started = time.perf_counter()
    try:
        yield
    finally:
        if request is not None:
            stages = getattr(request.state, 'stages', None)
            if isinstance(stages, dict):
                stages[name] = stages.get(name, 0) + int((time.perf_counter() - started) * 1000)


def _metric_row(request: Request, feature: str, session_id: str | None,
                status_code: int, error_code: str | None, total_ms: int) -> dict:
    state = request.state
    stages = getattr(state, 'stages', None) or {}
    return {
        'request_id': getattr(state, 'request_id', '') or uuid.uuid4().hex,
        'feature': feature,
        'version': CPX_FEATURE_VERSION,
        'user_id': request.headers.get('x-lecturelink-user-id'),
        'session_id': getattr(state, 'session_id', None) or session_id,
        'model': getattr(state, 'model', None),
        'method': request.method,
        'status': classify_status(status_code, error_code),
        'status_code': status_code,
        'error_code': error_code,
        'total_ms': total_ms,
        'stages': json.dumps(stages, ensure_ascii=False) if stages else None,
        'schema_valid': getattr(state, 'schema_valid', None),
        'created_at': time.time(),
    }


# 마지막 정리 시각. 요청마다 DELETE 를 돌리면 계측이 서비스보다 비싸지므로 1시간에 한 번만 돈다.
_last_metrics_purge = 0.0
_PURGE_INTERVAL_SECONDS = 3600


def purge_metrics_if_due(now_ts: float | None = None) -> dict | None:
    """보존 기간이 지난 계측을 주기적으로 정리. 정리했으면 삭제 건수를 돌려준다."""
    global _last_metrics_purge
    now_ts = time.time() if now_ts is None else now_ts
    if now_ts - _last_metrics_purge < _PURGE_INTERVAL_SECONDS:
        return None
    _last_metrics_purge = now_ts
    try:
        return db.purge_old_metrics(now_ts - CPX_METRICS_RETENTION_DAYS * 86400)
    except Exception as exc:  # noqa: BLE001 — 정리 실패가 요청을 실패시키면 안 된다
        print(f'[metrics] 보존 기간 정리 실패: {exc}')
        return None


@app.middleware('http')
async def record_request_metrics(request: Request, call_next):
    feature, session_id = classify_request(request.method, request.url.path)
    if not CPX_METRICS_ENABLED or feature is None:
        return await call_next(request)
    request.state.request_id = uuid.uuid4().hex
    request.state.stages = {}
    request.state.schema_valid = None
    request.state.model = None
    request.state.session_id = session_id
    started = time.perf_counter()

    async def save(status_code: int, error_code: str | None) -> None:
        elapsed = int((time.perf_counter() - started) * 1000)
        row = _metric_row(request, feature, session_id, status_code, error_code, elapsed)
        try:
            # SQLite 쓰기는 동기 호출이다. 이벤트 루프에서 직접 부르면 계측이 요청 처리를
            # 붙잡는다 — 계측은 서비스보다 뒤에 있어야 하므로 스레드풀로 내린다.
            await run_in_threadpool(db.add_request_metric, row)
        except Exception as exc:  # noqa: BLE001 — 계측 실패가 요청을 실패시키면 안 된다
            print(f'[metrics] 요청 계측 저장 실패 ({feature}): {exc}')

    try:
        response = await call_next(request)
    except Exception:
        # 처리되지 않은 예외도 실패율의 분자다. 여기서 세지 않으면 500 이 통계에서 사라진다.
        await save(500, 'unhandled_exception')
        raise
    code = response.headers.get('x-cpx-error-code')
    if not code and response.status_code >= 400:
        code = f'http_{response.status_code}'
    response.headers['x-cpx-request-id'] = request.state.request_id
    await save(response.status_code, code)
    await run_in_threadpool(purge_metrics_if_due)
    return response


def current_user_id(
    x_lecturelink_user_id: str | None = Header(default=None),
    x_cpx_proxy_secret: str | None = Header(default=None),
) -> str:
    """Trust LectureLink identity only through the server-side proxy in production.

    Local Vite development remains usable with a namespaced ``local`` user.
    Production must set REQUIRE_LECTURELINK_AUTH=true and a strong shared secret.
    """
    if REQUIRE_LECTURELINK_AUTH:
        if not CPX_PROXY_SHARED_SECRET:
            raise HTTPException(503, 'CPX_PROXY_SHARED_SECRET가 설정되지 않았습니다.')
        # 상수시간 비교 — `!=` 는 첫 불일치 바이트에서 끊기므로 응답 시간으로 앞자리부터
        # 한 글자씩 맞춰 볼 수 있다. 공유 비밀이 뚫리면 임의 사용자 id 로 세션을 만들 수 있다.
        if not hmac.compare_digest(x_cpx_proxy_secret or '', CPX_PROXY_SHARED_SECRET):
            raise HTTPException(401, '인증된 LectureLink CPX 프록시 요청이 아닙니다.')
        if not x_lecturelink_user_id:
            raise HTTPException(401, 'LectureLink 사용자 정보가 없습니다.')
    return x_lecturelink_user_id or 'local'


class SessionCreate(BaseModel):
    caseId: str
    # 연습용 시간제한(초). 실전 12분(720) 외에 11분 30초·11분 단축 연습 지원.
    timeLimitSeconds: int | None = None
    # 연습 방식 — 'random'(증례 비공개 랜덤 실전)이면 순응도 낮은 환자 배정 확률이 40%,
    # 그 외(직접 선택·추천)는 25%. 배정 자체는 모든 세션에 상시 적용되며 사용자가 끌 수 없다.
    practiceMode: str | None = None


DEFAULT_TIME_LIMIT_SECONDS = 12 * 60
TIME_LIMIT_CHOICES = {720, 690, 660}


def resolve_time_limit(value: int | None) -> int:
    return value if value in TIME_LIMIT_CHOICES else DEFAULT_TIME_LIMIT_SECONDS


class TranscriptEvent(BaseModel):
    """채점 근거가 되는 전사 한 줄.

    Live 오디오는 브라우저와 Gemini 사이에서 직접 오가므로 서버는 대화를 독립적으로
    관찰하지 못하고 클라이언트가 보낸 값을 그대로 채점 프롬프트에 싣는다. 최소한 형식만은
    서버가 강제한다 — role 을 열거형으로 묶지 않으면 임의 화자를, 시각에 하한이 없으면
    임의 순서를 만들어 넣을 수 있다.
    """

    role: Literal['student', 'patient', 'system']
    text: str = Field(min_length=1, max_length=4000)
    tOffsetMs: int = Field(ge=0, le=24 * 60 * 60 * 1000)


# 제한시간을 넘겨 도착한 발화 허용 폭 — 전사 지연·마무리 발화를 넉넉히 받되,
# 이 범위를 벗어난 시각은 저장하지 않는다(단계별 소요 시간 왜곡 방지).
EVENT_OFFSET_GRACE_MS = 5 * 60 * 1000


def _offset_ceiling_ms(session: dict) -> int:
    import json as _json

    config = _json.loads(session['config']) if session.get('config') else {}
    limit = config.get('timeLimitSeconds') or DEFAULT_TIME_LIMIT_SECONDS
    return int(limit) * 1000 + EVENT_OFFSET_GRACE_MS


def require_open_session(session_id: str, user_id: str) -> dict:
    """존재하고 아직 종료되지 않은 세션만 통과시킨다.

    종료 뒤에도 전사·진찰을 계속 받으면 채점이 끝난 세션에 근거를 덧붙일 수 있다.
    프론트는 /end 이전에 버퍼를 비우고 주기 전송도 진료 중에만 돌므로 정상 경로에는 영향이 없다.
    """
    session = db.get_session(session_id, user_id)
    if not session:
        raise HTTPException(404, '세션 없음')
    if session.get('status') == 'ended' or session.get('ended_at'):
        raise HTTPException(409, '이미 종료된 세션입니다.')
    return session


@app.get('/api/health')
def health():
    return {'ok': True, 'hasApiKey': bool(GEMINI_API_KEY), 'model': LIVE_MODEL}


@app.delete('/api/account-data')
def delete_account_data(user_id: str = Depends(current_user_id)):
    return {'deletedSessions': db.delete_user_data(user_id)}


@app.get('/api/cases')
def cases(_user_id: str = Depends(current_user_id)):
    listed = prompt_mod.list_cases(release_ready_only=CPX_RELEASE_READY_ONLY)
    # 검수 상태 분포를 함께 돌려준다 — 게이트를 꺼 둔 동안 임상 검수가 얼마나 밀려 있는지
    # 운영이 케이스를 한 건씩 열어보지 않고 알 수 있어야 한다.
    counts: dict[str, int] = {}
    for c in listed:
        counts[c['contentStatus']] = counts.get(c['contentStatus'], 0) + 1
    return {
        'category': '수면장애',
        'cases': listed,
        'releaseReadyOnly': CPX_RELEASE_READY_ONLY,
        'contentStatusCounts': counts,
    }


@app.post('/api/sessions')
def create_session(body: SessionCreate, user_id: str = Depends(current_user_id)):
    try:
        case = prompt_mod.load_case(body.caseId)
    except KeyError:
        raise HTTPException(404, f'케이스 없음: {body.caseId}')
    if CPX_RELEASE_READY_ONLY and not prompt_mod.is_release_ready(case):
        raise HTTPException(404, '임상 최종 승인이 완료되지 않은 케이스입니다.')
    # 인적사항은 세션 생성 시 서버가 확정 — 프롬프트·보이스·UI가 전부 이 값을 따른다
    import json as _json
    import uuid as _uuid
    seed = _uuid.uuid4().hex
    persona = prompt_mod.resolve_persona(case, seed)
    time_limit = resolve_time_limit(body.timeLimitSeconds)
    config_dict = {'timeLimitSeconds': time_limit}
    # 순응도 낮은 환자는 모든 세션에 상시 무작위 배정 (직접 선택 25% · 랜덤 실전 40%).
    # 배정 결과는 config에만 저장하고 응답에는 싣지 않는다 — 세션 중에는 비공개,
    # 채점 결과에서만 유형이 공개된다.
    probability = prompt_mod.low_compliance_probability(body.practiceMode)
    behaviors = prompt_mod.resolve_low_compliance(case, seed, probability)
    if behaviors:
        config_dict['lowCompliance'] = {'behaviors': behaviors, 'probability': probability}
    config = _json.dumps(config_dict, ensure_ascii=False)
    session_id = db.create_session(body.caseId, user_id, _json.dumps(persona, ensure_ascii=False), config)
    # 문 앞 정보 — 실제 시험은 입실 전에 인적사항과 활력징후를 준다. 여기서는 활력징후가
    # 버튼 뒤에 있어 쇼크 수준 혈압이 결정적인 증례에서도 클릭해야만 보였다(2026-08-18 감사 가8).
    # 채점에는 영향이 없다 — 활력징후 항목 80개는 전부 '확인 또는 선언'을 요구하는 말의 행위라,
    # 값을 미리 알려줘도 학생은 여전히 확인하겠다고 말해야 인정된다.
    import physical_exam as _pe
    door_chart = {
        'name': persona.get('name'),
        'age': persona.get('age'),
        'gender': persona.get('gender'),
        'chiefComplaint': case.get('category'),
        'location': ((case.get('demographicsRule') or {}).get('fixed') or {}).get('location'),
        'vitals': _pe.door_chart_vitals(case),
    }
    child = persona.get('child')
    if isinstance(child, dict):
        door_chart['child'] = {
            'name': child.get('name'), 'age': child.get('ageDetail') or child.get('age'),
            'gender': child.get('gender'), 'label': child.get('label'),
        }
    return {'sessionId': session_id, 'persona': persona, 'timeLimitSeconds': time_limit,
            'doorChart': door_chart}


@app.post('/api/sessions/{session_id}/live-token')
def live_token(request: Request, session_id: str, user_id: str = Depends(current_user_id)):
    """세션용 ephemeral token 발급. 1회 연결, 시스템 프롬프트 서버 잠금."""
    request.state.model = LIVE_MODEL
    if not GEMINI_API_KEY:
        raise HTTPException(503, 'GEMINI_API_KEY가 설정되지 않았습니다 (server/.env).',
                            headers={'x-cpx-error-code': 'missing_api_key'})
    session = db.get_session(session_id, user_id)
    if not session:
        raise HTTPException(404, '세션 없음')

    import json as _json
    persona = _json.loads(session['persona']) if session.get('persona') else None
    session_config = _json.loads(session['config']) if session.get('config') else {}
    low_compliance = session_config.get('lowCompliance') or {}
    low_compliance_ids = [b['id'] for b in low_compliance.get('behaviors', [])] or None
    system_instruction = prompt_mod.build_system_instruction(
        session['case_id'], persona, low_compliance_ids=low_compliance_ids,
    )
    voice = prompt_mod.voice_for_persona(persona or {})

    from google import genai  # 지연 임포트 — 키 없이도 서버는 뜬다

    client = genai.Client(api_key=GEMINI_API_KEY, http_options={'api_version': 'v1alpha'})
    now = dt.datetime.now(tz=dt.timezone.utc)
    live_config = {
        'response_modalities': ['AUDIO'],
        'input_audio_transcription': {},
        'output_audio_transcription': {},
        'speech_config': {'voice_config': {'prebuilt_voice_config': {'voice_name': voice}}},
        'system_instruction': system_instruction,
    }
    token_config = {
        'uses': 1,
        'expire_time': now + dt.timedelta(minutes=20),          # 12분 세션 + 여유
        'new_session_expire_time': now + dt.timedelta(minutes=2),
    }
    if LOCK_CONSTRAINTS:
        token_config['live_connect_constraints'] = {'model': LIVE_MODEL, 'config': live_config}

    try:
        with stage(request, 'token_create'):
            token = client.auth_tokens.create(config=token_config)
    except Exception as e:  # noqa: BLE001 — SDK 예외 유형이 넓음
        raise HTTPException(502, f'ephemeral token 발급 실패: {e}',
                            headers={'x-cpx-error-code': 'token_create_failed'})

    resp = {'token': token.name, 'model': LIVE_MODEL, 'locked': LOCK_CONSTRAINTS, 'voice': voice}
    if not LOCK_CONSTRAINTS:
        # 폴백 모드에서만 클라이언트가 직접 구성 (진단명 노출 — 개발 전용)
        resp['systemInstruction'] = system_instruction
    return resp


@app.post('/api/sessions/{session_id}/events')
def add_events(session_id: str, events: list[TranscriptEvent], user_id: str = Depends(current_user_id)):
    session = require_open_session(session_id, user_id)
    # 제한시간 + 유예를 넘긴 시각은 저장하지 않는다. 400 으로 막으면 클라이언트가 같은 배치를
    # 계속 재전송하므로, 받아들이되 버리고 몇 건을 버렸는지 응답에 남긴다.
    ceiling = _offset_ceiling_ms(session)
    kept = [e for e in events if e.tOffsetMs <= ceiling]
    dropped = len(events) - len(kept)
    n = db.add_events(session_id, user_id, [e.model_dump() for e in kept]) if kept else 0
    return {'saved': n, 'dropped': dropped} if dropped else {'saved': n}


class UsageEvent(BaseModel):
    """Live API가 턴마다 돌려주는 usageMetadata (클라이언트 live.js가 수집)."""
    promptTokens: int = 0
    responseTokens: int = 0
    totalTokens: int = 0
    promptTextTokens: int = 0
    promptAudioTokens: int = 0
    responseTextTokens: int = 0
    responseAudioTokens: int = 0
    tOffsetMs: int = 0


@app.post('/api/sessions/{session_id}/usage')
def add_usage(session_id: str, events: list[UsageEvent], user_id: str = Depends(current_user_id)):
    """Live 턴별 토큰 사용량 기록 — CPX 회당 원가 실측의 원천 데이터."""
    if not db.get_session(session_id, user_id):
        raise HTTPException(404, '세션 없음')
    n = db.add_usage_events(session_id, user_id, [e.model_dump() for e in events], kind='live_turn', model=LIVE_MODEL)
    return {'saved': n}


class TurnMetricEvent(BaseModel):
    """클라이언트가 측정한 턴 응답시간 (가이드 §2.1 'CPX 응답 지연시간').

    Live 오디오는 브라우저와 Gemini 사이에서 직접 오간다 — 서버는 발화 종료도 응답 시작도
    보지 못하므로 클라이언트 측정치를 받는다. 대신 값의 범위는 서버가 강제한다:
    음수나 몇 시간짜리 지연이 섞이면 p95 가 통째로 망가진다.
    """
    turnIndex: int = Field(ge=0, le=10_000)
    inputMode: Literal['voice', 'text'] = 'voice'
    speechEndOffsetMs: int = Field(ge=0, le=24 * 60 * 60 * 1000)
    firstResponseMs: int | None = Field(default=None, ge=0, le=600_000)
    firstAudioMs: int | None = Field(default=None, ge=0, le=600_000)
    turnCompleteMs: int | None = Field(default=None, ge=0, le=600_000)
    interrupted: bool = False
    network: str | None = Field(default=None, max_length=32)


@app.post('/api/sessions/{session_id}/turns')
def add_turn_metrics(session_id: str, events: list[TurnMetricEvent],
                     user_id: str = Depends(current_user_id)):
    """턴별 '발화 종료 → 응답 시작' 실측치 기록 — 턴 응답시간 p50/p95의 원천."""
    if not db.get_session(session_id, user_id):
        raise HTTPException(404, '세션 없음')
    saved = db.add_turn_metrics(session_id, user_id, [e.model_dump() for e in events], model=LIVE_MODEL)
    return {'saved': saved}


@app.get('/api/sessions/{session_id}/turns')
def session_turns(session_id: str, user_id: str = Depends(current_user_id)):
    if not db.get_session(session_id, user_id):
        raise HTTPException(404, '세션 없음')
    rows = db.get_turn_metrics(session_id, user_id)
    return {'sessionId': session_id, 'turns': rows, 'summary': metrics_mod.summarize_turns(rows)}


@app.get('/api/sessions/{session_id}/usage')
def session_usage(session_id: str, user_id: str = Depends(current_user_id)):
    """세션의 턴별 사용량 + 원가 요약 (단가표: usage.py)."""
    import usage as usage_mod

    if not db.get_session(session_id, user_id):
        raise HTTPException(404, '세션 없음')
    rows = db.get_usage_events(session_id, user_id)
    return {'sessionId': session_id, 'events': rows, 'summary': usage_mod.summarize(rows)}


@app.get('/api/usage/summary')
def usage_summary(limit: int = 20, user_id: str = Depends(current_user_id)):
    """사용자 세션별 원가 요약 (최근순) — CPX 회당 원가 실측 집계."""
    import usage as usage_mod

    sessions = []
    total_usd = 0.0
    live_costs = []
    for s in db.list_usage_sessions(user_id, limit=max(1, min(limit, 100))):
        summary = usage_mod.summarize(db.get_usage_events(s['id'], user_id))
        total_usd += summary['usd']
        if summary['turns'] > 0:
            live_costs.append(summary['usd'])
        sessions.append({
            'sessionId': s['id'],
            'caseId': s['case_id'],
            'startedAt': s['started_at'],
            'endedAt': s['ended_at'],
            'summary': summary,
        })
    rate = usage_mod.usd_krw_rate()
    mean_usd = sum(live_costs) / len(live_costs) if live_costs else 0.0
    return {
        'sessions': sessions,
        'count': len(sessions),
        'totalUsd': round(total_usd, 6),
        'totalKrw': round(total_usd * rate, 1),
        'meanLiveSessionUsd': round(mean_usd, 6),
        'meanLiveSessionKrw': round(mean_usd * rate, 1),
        'usdKrwRate': rate,
    }


def require_metrics_admin(
    x_cpx_admin: str | None = Header(default=None),
    _user_id: str = Depends(current_user_id),
) -> None:
    """운영 지표는 관리자만 본다.

    이중 잠금이다. ① current_user_id 가 프록시 공유 비밀을 검사하므로 LectureLink 서버를
    거치지 않은 요청은 여기까지 오지 못한다. ② 그 프록시는 requireAdmin() 이 통과한
    요청에만 이 헤더를 붙인다. 헤더가 없으면 거절 — 열린 쪽으로 실패하지 않는다.
    """
    if (x_cpx_admin or '') != '1':
        raise HTTPException(403, '운영 지표는 관리자만 조회할 수 있습니다.')


@app.get('/api/metrics/summary')
def metrics_summary(days: int = 7, _admin: None = Depends(require_metrics_admin)):
    """1단계 운영 지표 묶음 — 성공률·p95·오류 분포·완주율·턴 지연·세션당 원가."""
    import usage as usage_mod

    window = max(1, min(days, 90))
    since = time.time() - window * 86400
    return metrics_mod.build_summary(
        window,
        db.list_request_metrics(since),
        db.list_turn_metrics(since),
        db.list_sessions_since(since),
        db.usage_events_since(since),
        usage_mod,
    )


class ExamRequest(BaseModel):
    buttonId: str = Field(min_length=1, max_length=64)
    tOffsetMs: int = Field(ge=0, le=24 * 60 * 60 * 1000)


@app.get('/api/exam-buttons')
def exam_buttons(caseId: str | None = None, _user_id: str = Depends(current_user_id)):
    """진찰 버튼 카탈로그 — 케이스 category별 세트 (caseId 없으면 기본 세트)."""
    import physical_exam
    case = None
    if caseId:
        try:
            case = prompt_mod.load_case(caseId)
        except KeyError:
            raise HTTPException(404, f'케이스 없음: {caseId}')
    return {'buttons': physical_exam.button_catalog(case)}


@app.post('/api/sessions/{session_id}/exam')
def perform_exam(session_id: str, body: ExamRequest, user_id: str = Depends(current_user_id)):
    """신체진찰 버튼 클릭 → 소견 반환 + 선언 문구를 전사에 기록(채점 근거, §8)."""
    import physical_exam

    session = require_open_session(session_id, user_id)
    case = prompt_mod.load_case(session['case_id'])
    try:
        result = physical_exam.resolve_exam(case, body.buttonId)
    except KeyError as e:
        raise HTTPException(404, str(e))
    # 버튼 클릭은 학생 발화로 전사에 들어간다 — 학생은 그 문장을 말한 적이 없다.
    # 그래서 다섯 번 클릭으로 진찰 항목 대부분이 충족되는 일이 생겼다(2026-08-18 감사 가2).
    # 무엇을 인정할지는 제품 정체성(시험 재현 vs 학습 도구)에 달린 별도 결정이므로 여기서
    # 채점 정책은 바꾸지 않는다. 다만 **말한 것이 아니라 버튼으로 수행한 행위**임을 표시해
    # 채점기와 학생이 둘을 구별할 수 있게 한다. 새 role 을 만들지 않는 이유는 Supabase
    # cpx_transcript_events.role 에 CHECK 제약(student/patient/system)이 있고, 미러 실패가
    # 이제 조용히 넘어가므로(감사 다2 수정) 제약 위반이 소리 없이 전사를 누락시키기 때문이다.
    kind = physical_exam.button_kind(body.buttonId)
    marker = '[검사 지시]' if kind == physical_exam.KIND_TEST else '[진찰 수행]'
    transcript_text = f"{marker} {result['declaration']}"
    offset = min(body.tOffsetMs, _offset_ceiling_ms(session))
    db.add_events(session_id, user_id, [{'role': 'student', 'text': transcript_text, 'tOffsetMs': offset}])
    # 클라이언트도 같은 문장을 로컬 전사에 넣도록 서버가 확정한 문자열을 함께 돌려준다.
    return {**result, 'kind': kind, 'transcriptText': transcript_text}


class SessionEnd(BaseModel):
    """종료 사유 — 완주율에서 중단·타임아웃·재시작을 분리하기 위한 값(가이드 §2.1).

    본문 없이 오는 예전 클라이언트도 그대로 받는다(사유 NULL → 집계에서 'unknown').
    """
    reason: str | None = Field(default=None, max_length=32)


@app.post('/api/sessions/{session_id}/end')
def end_session(session_id: str, body: SessionEnd | None = None,
                user_id: str = Depends(current_user_id)):
    if not db.get_session(session_id, user_id):
        raise HTTPException(404, '세션 없음')
    reason = body.reason if body else None
    # 임의 문자열이 들어오면 집계축이 무한히 늘어난다 — 아는 사유만 그대로 두고 나머지는 접는다.
    if reason is not None and reason not in metrics_mod.END_REASONS:
        reason = 'unknown'
    db.end_session(session_id, user_id, reason)
    return {'ok': True}


@app.get('/api/history')
def history(user_id: str = Depends(current_user_id)):
    """채점 완료 세션 목록 (점수 히스토리)."""
    import json as _json

    out = []
    for s in db.list_scored_sessions(user_id):
        result = _json.loads(s['result'])
        persona = _json.loads(s['persona']) if s.get('persona') else None
        scored_sections = [
            section for section in result.get('sections', [])
            if section.get('weightPercent', 0) > 0 and 'violationCount' not in section
        ]
        weakest = min(
            scored_sections,
            key=lambda section: section.get('score', 0) / section['weightPercent'],
            default=None,
        )
        out.append({
            'sessionId': s['id'],
            'caseId': s['case_id'],
            'startedAt': s['started_at'],
            'persona': persona,
            'totalScore': result.get('totalScore'),
            'gradeLabel': result.get('overallGradeLabel'),
            'weakestSection': ({
                'id': weakest.get('id'),
                'name': weakest.get('name'),
                'score': weakest.get('score'),
                'weightPercent': weakest.get('weightPercent'),
            } if weakest else None),
        })
    return {'sessions': out}


@app.post('/api/sessions/{session_id}/evaluate')
def evaluate_session(request: Request, session_id: str, user_id: str = Depends(current_user_id)):
    """전사 → LLM 근거 추출(§4.9) → 규칙 엔진 채점(§4.8) → 결과 저장.

    단계별 소요 시간(load/llm_extract/scoring/persist)을 계측에 남긴다 — 채점은 CPX에서
    가장 느린 경로이고, 총 시간만으로는 LLM 지연인지 우리 코드인지 구분할 수 없다
    (가이드 §4.1 '단계별 시간 → 병목 단계 식별').
    """
    import json as _json

    import evaluate as ev
    import scoring

    request.state.model = ev.EVAL_MODEL

    session = db.get_session(session_id, user_id)
    if not session:
        raise HTTPException(404, '세션 없음')
    def with_item_texts(res: dict) -> dict:
        if 'itemTexts' not in res:
            rub = ev.load_rubric(prompt_mod.load_case(session['case_id']))
            res['itemTexts'] = {
                i['id']: i['text'] for s in rub['sections'] if s['type'] != 'deduction' for i in s['items']
            }
        return res

    # 이미 채점됨 → 캐시 반환 (재현성: 동일 세션 재채점 방지)
    if session.get('result'):
        # 캐시 히트는 LLM을 부르지 않는다. 같은 기능으로 뭉뚱그리면 채점 지연 p95 가
        # 실제보다 좋게 나오므로 단계 이름으로 구분해 남긴다.
        with stage(request, 'cache_hit'):
            cached = with_item_texts(_json.loads(session['result']))
        request.state.schema_valid = 0 if metrics_mod.validate_result_schema(cached) else 1
        return cached
    # 진행 중인 세션을 채점하면 그 시점까지의 부분 결과가 캐시로 굳어, 진짜 최종 결과를
    # 영영 만들 수 없다(위 캐시 분기 때문). 정상 경로는 항상 /end 다음에 /evaluate 를
    # 부르므로 영향이 없다 — 실수나 외부 호출로 세션이 잠기는 것만 막는다(2026-08-18 감사 P2).
    if not (session.get('ended_at') or session.get('status') == 'ended'):
        raise HTTPException(409, '아직 진행 중인 세션입니다. 진료를 종료한 뒤 채점할 수 있습니다.',
                            headers={'x-cpx-error-code': 'session_in_progress'})
    if not GEMINI_API_KEY:
        raise HTTPException(503, 'GEMINI_API_KEY가 설정되지 않았습니다 (server/.env).',
                            headers={'x-cpx-error-code': 'missing_api_key'})

    with stage(request, 'load'):
        events = db.get_transcript(session_id, user_id)
        student_turns = [e for e in events if e['role'] == 'student']

        case = prompt_mod.load_case(session['case_id'])
        rubric = ev.load_rubric(case)
        persona = _json.loads(session['persona']) if session.get('persona') else None
        context = ev.build_context(case, persona)

    # 대화가 짧아도 채점은 한다 — 실제 시험처럼 '그 시점까지의 수행'이 곧 결과다.
    # 예전에는 문진 2턴 미만이면 422로 막았는데, 프론트가 그 실패를 받고 진료 화면으로
    # 되돌아가 "종료를 눌렀는데 이유 없이 대화 화면으로 튕긴다"로 보고됐다(2026-08-15 모바일).
    # 학생 발화가 0턴일 때만 LLM 호출을 건너뛰고 전 항목 미충족으로 곧장 채점한다.
    if not student_turns:
        judgments = ev.empty_judgments(rubric, context)
    else:
        # LLM 근거 추출을 하드 타임아웃으로 감싼다 — 쿼터 소진 시 SDK가 무한 재시도로
        # 매달려 결과 화면이 영원히 로딩되는 것을 방지 (실측 2분+ 행 확인).
        #
        # 이 타임아웃은 한동안 아무것도 막지 못했다. `with ThreadPoolExecutor(...)` 를 쓰면
        # 블록을 벗어날 때 shutdown(wait=True) 가 실행돼 작업 스레드가 끝날 때까지 기다린다.
        # 그래서 75초 뒤 TimeoutError 가 나도 504 응답은 LLM 호출이 다 끝난 뒤에야 나갔고,
        # 주석이 막으려던 "결과 화면 무한 로딩"이 그대로 발생했다(2026-08-18 감사 다1).
        # 컨텍스트 매니저를 쓰지 않고 wait=False 로 내려 응답을 즉시 내보낸다.
        import concurrent.futures as _cf
        pool = _cf.ThreadPoolExecutor(max_workers=1)
        try:
            with stage(request, 'llm_extract'):
                future = pool.submit(ev.extract_judgments, GEMINI_API_KEY, rubric, events, context, case)
                judgments = future.result(timeout=75)
        except _cf.TimeoutError:
            raise HTTPException(504, '채점 시간이 초과되었습니다. 잠시 후 다시 시도해주세요. (API 응답 지연 또는 무료 티어 쿼터 소진 가능성)',
                                headers={'x-cpx-error-code': 'evaluate_timeout'})
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if '429' in msg or 'RESOURCE_EXHAUSTED' in msg:
                raise HTTPException(429, '무료 티어 채점 쿼터를 모두 사용했습니다. 잠시 후(또는 다음 날) 다시 시도하거나 유료 플랜으로 전환해주세요.',
                                    headers={'x-cpx-error-code': 'quota_exhausted'})
            raise HTTPException(502, f'근거 추출 실패: {msg}',
                                headers={'x-cpx-error-code': 'extract_failed'})
        finally:
            # wait=False 가 핵심 — 성공했으면 유휴 스레드가 바로 정리되고,
            # 타임아웃이면 매달린 호출을 기다리지 않고 응답이 나간다.
            # 매 요청마다 새 실행기를 만들므로 여기서 반드시 내려야 스레드가 쌓이지 않는다.
            pool.shutdown(wait=False, cancel_futures=True)

    # 채점 호출 토큰 → usage_events(kind=evaluate) 기록. scoring 입력에서는 분리.
    eval_usage = judgments.pop('usage', None)
    if eval_usage:
        db.add_usage_events(session_id, user_id, [eval_usage], kind='evaluate', model=ev.EVAL_MODEL)

    reasoning = judgments.pop('clinicalReasoning', None)
    scoring_started = time.perf_counter()
    result = scoring.score_session(rubric, judgments, context)
    # 임상추론 판정은 점수 계산에 직접 들어가지 않는다 — 항목 판정(내용 정확성)과 피드백으로만 쓴다.
    result['clinicalReasoning'] = reasoning or ev.normalize_clinical_reasoning(None)
    result['feedback'] = ev.build_feedback(rubric, result, result['clinicalReasoning'])
    result['judgments'] = judgments['items']  # 항목별 근거 인용 (§4.4-3)
    result['caseId'] = session['case_id']
    result['persona'] = _json.loads(session['persona']) if session.get('persona') else None
    # 단계별 사용 시간 — LLM이 보고한 단계 경계 + 전사 타임스탬프로 결정론 계산
    import physical_exam
    config = _json.loads(session['config']) if session.get('config') else {}
    exam_declarations = {b['declaration'] for b in physical_exam.buttons_for(case)}
    result['timeAnalysis'] = ev.compute_time_analysis(
        events, judgments.get('phases'), config.get('timeLimitSeconds'), session, exam_declarations,
    )
    # 순응도 낮은 환자 모드였다면 어떤 저항 유형이었는지 채점 후에 공개한다.
    if config.get('lowCompliance'):
        result['lowCompliance'] = config['lowCompliance']
    # 프론트 표시용 항목 원문
    result['itemTexts'] = {
        i['id']: i['text'] for s in rubric['sections'] if s['type'] != 'deduction' for i in s['items']
    }
    # 세션 원가 실측 요약 — 결과 JSON에 실어 Supabase 미러(cpx_sessions.result)에도 자동 반영
    import usage as usage_mod
    result['usage'] = usage_mod.summarize(db.get_usage_events(session_id, user_id))

    # 계측이 꺼진 배포에서는 stages 가 아예 없다 — getattr 로 받아 조용히 건너뛴다.
    _stages = getattr(request.state, 'stages', None)
    if isinstance(_stages, dict):
        _stages['scoring'] = int((time.perf_counter() - scoring_started) * 1000)

    # 스키마 준수율 (가이드 §2.1) — 결과 JSON은 결과 화면과 Supabase 미러가 함께 쓰는 계약이다.
    # 위반해도 응답은 막지 않는다. 여기서 502 를 내면 이미 돈과 시간을 쓴 채점이 통째로
    # 버려지고 학생은 결과를 못 본다 — 계측에 남기고 로그로 띄워 배포 후 회귀를 잡는다.
    problems = metrics_mod.validate_result_schema(result)
    request.state.schema_valid = 0 if problems else 1
    if problems:
        print(f'[metrics] 채점 결과 스키마 위반 session={session_id}: {problems[:8]}')

    with stage(request, 'persist'):
        db.set_result(session_id, user_id, _json.dumps(result, ensure_ascii=False))
    return result


@app.post('/api/sessions/{session_id}/review-notes')
def save_review_notes(session_id: str, user_id: str = Depends(current_user_id)):
    """채점 결과의 놓친 항목을 오답노트에 저장 (§6.3 오답노트 연동)."""
    import json as _json

    session = db.get_session(session_id, user_id)
    if not session or not session.get('result'):
        raise HTTPException(404, '채점된 세션이 아닙니다')
    result = _json.loads(session['result'])
    item_texts = result.get('itemTexts', {})
    if not item_texts:
        rubric = __import__('evaluate').load_rubric()
        item_texts = {i['id']: i['text'] for s in rubric['sections'] if s['type'] != 'deduction' for i in s['items']}
    notes = []
    for sec in result['sections']:
        # 부분 수행도 다음 진료에서 보완할 항목으로 오답노트에 남긴다.
        for item_id in [*sec.get('partialIds', []), *sec.get('missedIds', [])]:
            notes.append({'section': sec['name'], 'itemId': item_id, 'itemText': item_texts.get(item_id, item_id)})
    saved = db.add_review_notes(session_id, user_id, session['case_id'], notes)
    return {'saved': saved, 'total': len(notes)}


@app.get('/api/review-notes')
def review_notes(caseId: str | None = None, user_id: str = Depends(current_user_id)):
    return {'notes': db.get_review_notes(user_id, caseId)}


# 세션 행에는 학생이 세션 중에 알아서는 안 되는 것이 함께 들어 있다 —
# case_id(증례 비공개 모드에서 감춰야 할 정답)와 config.lowCompliance(배정된 저항 유형).
# 시작 응답은 이들을 빼고 내려주는데 대화록 API 는 행을 통째로 돌려주고 있어서,
# 학생이 이 엔드포인트를 직접 부르면 랜덤 모드의 증례와 저항 유형을 알 수 있었다
# (2026-08-18 감사 다4). config 는 서버 내부값이라 언제나 빼고, case_id 는 세션이
# 끝난 뒤에만 준다 — 결과 화면에서는 정답을 밝혀도 되기 때문이다.
_SESSION_INTERNAL_FIELDS = ('config',)


def public_session(session: dict) -> dict:
    out = {k: v for k, v in session.items() if k not in _SESSION_INTERNAL_FIELDS}
    if not session.get('ended_at'):
        out.pop('case_id', None)
    return out


@app.get('/api/sessions/{session_id}/transcript')
def transcript(session_id: str, user_id: str = Depends(current_user_id)):
    session = db.get_session(session_id, user_id)
    if not session:
        raise HTTPException(404, '세션 없음')
    return {'session': public_session(session), 'events': db.get_transcript(session_id, user_id)}
