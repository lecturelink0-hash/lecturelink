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
import datetime as dt
import os
from typing import Literal

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

import db
import prompt as prompt_mod

load_dotenv()

GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
LIVE_MODEL = os.environ.get('GEMINI_LIVE_MODEL', 'gemini-3.1-flash-live-preview')
# 개발 편의: constraints 잠금이 문제를 일으키면 false로 두고 클라이언트 구성 폴백 사용
LOCK_CONSTRAINTS = os.environ.get('LOCK_CONSTRAINTS', 'true').lower() != 'false'
REQUIRE_LECTURELINK_AUTH = os.environ.get('REQUIRE_LECTURELINK_AUTH', 'false').lower() == 'true'
CPX_PROXY_SHARED_SECRET = os.environ.get('CPX_PROXY_SHARED_SECRET', '')
# 운영에서는 사용자 임상 승인이 끝난 케이스만 노출한다. 로컬 작성·검수 환경은 기본값(false)으로
# 전체 케이스를 보되, 실제 서비스 환경에서만 true로 설정한다.
CPX_RELEASE_READY_ONLY = os.environ.get('CPX_RELEASE_READY_ONLY', 'false').lower() == 'true'

app = FastAPI(title='lecturelink-cpx')
app.add_middleware(
    CORSMiddleware,
    allow_origins=['http://localhost:5173', 'http://127.0.0.1:5173'],
    allow_methods=['*'],
    allow_headers=['*'],
)


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
        if x_cpx_proxy_secret != CPX_PROXY_SHARED_SECRET:
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
    return {
        'category': '수면장애',
        'cases': prompt_mod.list_cases(release_ready_only=CPX_RELEASE_READY_ONLY),
        'releaseReadyOnly': CPX_RELEASE_READY_ONLY,
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
    return {'sessionId': session_id, 'persona': persona, 'timeLimitSeconds': time_limit}


@app.post('/api/sessions/{session_id}/live-token')
def live_token(session_id: str, user_id: str = Depends(current_user_id)):
    """세션용 ephemeral token 발급. 1회 연결, 시스템 프롬프트 서버 잠금."""
    if not GEMINI_API_KEY:
        raise HTTPException(503, 'GEMINI_API_KEY가 설정되지 않았습니다 (server/.env).')
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
        token = client.auth_tokens.create(config=token_config)
    except Exception as e:  # noqa: BLE001 — SDK 예외 유형이 넓음
        raise HTTPException(502, f'ephemeral token 발급 실패: {e}')

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
    # 의사의 진찰 선언은 학생 발화로 기록 → pe02/pe03 등 채점 항목에 반영됨
    offset = min(body.tOffsetMs, _offset_ceiling_ms(session))
    db.add_events(session_id, user_id, [{'role': 'student', 'text': result['declaration'], 'tOffsetMs': offset}])
    return result


@app.post('/api/sessions/{session_id}/end')
def end_session(session_id: str, user_id: str = Depends(current_user_id)):
    if not db.get_session(session_id, user_id):
        raise HTTPException(404, '세션 없음')
    db.end_session(session_id, user_id)
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
def evaluate_session(session_id: str, user_id: str = Depends(current_user_id)):
    """전사 → LLM 근거 추출(§4.9) → 규칙 엔진 채점(§4.8) → 결과 저장."""
    import json as _json

    import evaluate as ev
    import scoring

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
        return with_item_texts(_json.loads(session['result']))
    if not GEMINI_API_KEY:
        raise HTTPException(503, 'GEMINI_API_KEY가 설정되지 않았습니다 (server/.env).')

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
        import concurrent.futures as _cf
        try:
            with _cf.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(ev.extract_judgments, GEMINI_API_KEY, rubric, events, context)
                judgments = future.result(timeout=75)
        except _cf.TimeoutError:
            raise HTTPException(504, '채점 시간이 초과되었습니다. 잠시 후 다시 시도해주세요. (API 응답 지연 또는 무료 티어 쿼터 소진 가능성)')
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if '429' in msg or 'RESOURCE_EXHAUSTED' in msg:
                raise HTTPException(429, '무료 티어 채점 쿼터를 모두 사용했습니다. 잠시 후(또는 다음 날) 다시 시도하거나 유료 플랜으로 전환해주세요.')
            raise HTTPException(502, f'근거 추출 실패: {msg}')

    # 채점 호출 토큰 → usage_events(kind=evaluate) 기록. scoring 입력에서는 분리.
    eval_usage = judgments.pop('usage', None)
    if eval_usage:
        db.add_usage_events(session_id, user_id, [eval_usage], kind='evaluate', model=ev.EVAL_MODEL)

    result = scoring.score_session(rubric, judgments, context)
    result['feedback'] = ev.build_feedback(rubric, result)
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


@app.get('/api/sessions/{session_id}/transcript')
def transcript(session_id: str, user_id: str = Depends(current_user_id)):
    session = db.get_session(session_id, user_id)
    if not session:
        raise HTTPException(404, '세션 없음')
    return {'session': session, 'events': db.get_transcript(session_id, user_id)}
