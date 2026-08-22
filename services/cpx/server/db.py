"""세션·전사 저장 (SQLite). §5 전사 파이프라인 — 채점(§4.7 근거 인용)의 전제."""
import os
import sqlite3
import time
import uuid
from pathlib import Path

DB_PATH = Path(os.environ.get('CPX_DB_PATH', Path(__file__).resolve().parent / 'cpx.sqlite3'))

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL DEFAULT 'local',
    case_id TEXT NOT NULL,
    started_at REAL NOT NULL,
    ended_at REAL,
    status TEXT NOT NULL DEFAULT 'active',  -- active | ended
    persona TEXT                             -- 확정 인적사항 JSON {name, age, gender}
);
CREATE TABLE IF NOT EXISTS transcript_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    role TEXT NOT NULL,          -- student | patient | system
    text TEXT NOT NULL,
    t_offset_ms INTEGER NOT NULL, -- 세션 시작 기준 경과 ms (근거 인용 타임스탬프)
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON transcript_events(session_id, t_offset_ms);

-- 오답노트 (§6.3) — 채점에서 놓친 항목을 MCQ 오답과 같은 모델로 복습
CREATE TABLE IF NOT EXISTS review_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    case_id TEXT NOT NULL,
    section TEXT NOT NULL,       -- 병력청취 | 신체진찰 | 환자교육 | PPI
    item_id TEXT NOT NULL,
    item_text TEXT NOT NULL,
    created_at REAL NOT NULL,
    UNIQUE(session_id, item_id)
);
CREATE INDEX IF NOT EXISTS idx_review_case ON review_notes(case_id, created_at);

-- Live API 턴별 usageMetadata + 채점 호출 토큰 (세션 원가 실측 — API가 주는 값을 그대로 기록)
CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    kind TEXT NOT NULL DEFAULT 'live_turn',   -- live_turn | evaluate
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    response_tokens INTEGER NOT NULL DEFAULT 0,
    total_tokens INTEGER NOT NULL DEFAULT 0,
    prompt_text_tokens INTEGER NOT NULL DEFAULT 0,
    prompt_audio_tokens INTEGER NOT NULL DEFAULT 0,
    response_text_tokens INTEGER NOT NULL DEFAULT 0,
    response_audio_tokens INTEGER NOT NULL DEFAULT 0,
    model TEXT,
    t_offset_ms INTEGER NOT NULL DEFAULT 0,
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_session ON usage_events(session_id, id);

-- 운영 성능 계측 (성능지표 가이드 §4.1) — API 요청 1건 = 1행.
-- 성공률·실패율, p50/p95/p99 지연시간, 오류 코드 분포, 스키마 준수율의 원천 데이터다.
-- 세션 테이블과 FK 로 묶지 않는다 — 세션이 만들어지기 전에 실패한 요청(케이스 404, 인증
-- 실패)도 실패율의 분모에 들어가야 하는데, FK 가 있으면 그 행을 넣을 수 없다.
CREATE TABLE IF NOT EXISTS request_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL,
    feature TEXT NOT NULL,          -- cpx_evaluate | cpx_live_token | cpx_session_create ...
    version TEXT NOT NULL,          -- 기능 버전 (모델·프롬프트 교체 시 회귀 비교 축)
    user_id TEXT,
    session_id TEXT,
    model TEXT,
    method TEXT NOT NULL,
    status TEXT NOT NULL,           -- success | client_error | server_error | timeout
    status_code INTEGER NOT NULL,
    error_code TEXT,                -- evaluate_timeout | quota_exhausted | http_404 ...
    total_ms INTEGER NOT NULL,
    stages TEXT,                    -- 단계별 소요 ms JSON {"llm_extract": 8123, "scoring": 4}
    schema_valid INTEGER,           -- 1 | 0 | NULL(스키마 검사 대상 아님)
    created_at REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_metrics_created ON request_metrics(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_metrics_feature ON request_metrics(feature, created_at DESC);

-- CPX 턴 응답시간 (성능지표 가이드 §2.1 'CPX 응답 지연시간').
-- Live 오디오는 브라우저와 Gemini 사이에서 직접 오가므로 서버는 턴 지연을 관측할 수 없다.
-- 클라이언트가 측정한 '발화 종료 → 응답 시작' 실측치를 그대로 받아 적재한다.
CREATE TABLE IF NOT EXISTS turn_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    turn_index INTEGER NOT NULL,
    input_mode TEXT NOT NULL,           -- voice | text
    speech_end_offset_ms INTEGER NOT NULL,  -- 세션 시작 기준 발화 종료 시각
    first_response_ms INTEGER,          -- 발화 종료 → 첫 응답(전사 또는 오디오)
    first_audio_ms INTEGER,             -- 발화 종료 → 첫 오디오 바이트
    turn_complete_ms INTEGER,           -- 발화 종료 → turnComplete
    interrupted INTEGER NOT NULL DEFAULT 0,
    network TEXT,                       -- 네트워크 상태(effectiveType) 별 세부 집계용
    model TEXT,
    created_at REAL NOT NULL,
    UNIQUE(session_id, turn_index)
);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_session ON turn_metrics(session_id, turn_index);
"""


# 스키마·마이그레이션은 프로세스당 한 번만 돌린다.
# 예전에는 connect() 마다 executescript(SCHEMA) + PRAGMA table_info + ALTER 검사 + CREATE INDEX 를
# 전부 실행했다. 요청 하나가 여러 번 connect() 하므로 매 요청이 DDL 을 반복했고, SQLite 에서
# DDL 은 쓰기 잠금을 잡기 때문에 동시 접속 시 서로를 막았다(2026-08-18 감사 P2).
# 파일 경로가 바뀌면(테스트가 DB_PATH 를 갈아끼운다) 다시 초기화한다.
_initialized_for: Path | None = None


def _initialize(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)
    # 기존 DB 마이그레이션: 누락 컬럼 추가
    cols = {r[1] for r in conn.execute('PRAGMA table_info(sessions)')}
    for col in ('persona', 'result', 'user_id', 'config', 'end_reason'):
        if col not in cols:
            if col == 'user_id':
                conn.execute("ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local'")
            else:
                conn.execute(f'ALTER TABLE sessions ADD COLUMN {col} TEXT')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_sessions_user_started ON sessions(user_id, started_at DESC)')
    conn.commit()


def connect() -> sqlite3.Connection:
    global _initialized_for
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # WAL: 읽기가 쓰기를 막지 않는다. 하트비트·전사 저장·조회가 동시에 오는 구조라
    # 기본 rollback journal 로는 읽기 하나가 쓰기 전체를 세운다.
    # busy_timeout: 잠금이 잡혀 있으면 즉시 'database is locked' 로 죽지 않고 기다린다.
    conn.execute('PRAGMA journal_mode=WAL')
    conn.execute('PRAGMA busy_timeout=5000')
    conn.execute('PRAGMA foreign_keys=ON')
    if _initialized_for != DB_PATH:
        _initialize(conn)
        _initialized_for = DB_PATH
    return conn


def set_result(session_id: str, user_id: str, result_json: str) -> None:
    with connect() as conn:
        conn.execute('UPDATE sessions SET result = ? WHERE id = ? AND user_id = ?', (result_json, session_id, user_id))


def create_session(case_id: str, user_id: str, persona_json: str | None = None, config_json: str | None = None) -> str:
    session_id = uuid.uuid4().hex
    with connect() as conn:
        conn.execute(
            'INSERT INTO sessions (id, user_id, case_id, started_at, persona, config) VALUES (?, ?, ?, ?, ?, ?)',
            (session_id, user_id, case_id, time.time(), persona_json, config_json),
        )
    return session_id


def get_session(session_id: str, user_id: str):
    with connect() as conn:
        row = conn.execute('SELECT * FROM sessions WHERE id = ? AND user_id = ?', (session_id, user_id)).fetchone()
    return dict(row) if row else None


def end_session(session_id: str, user_id: str, reason: str | None = None) -> None:
    """종료 시각은 처음 한 번만 기록한다.

    예전에는 조건 없이 덮어써서, 스윕이 이미 정산한 세션에 뒤늦은 종료 요청이 오면
    종료 시각이 그때로 밀렸다 — 정산에 쓴 시각과 기록이 어긋난다(2026-08-18 감사 P2).

    종료 사유도 같은 이유로 처음 한 번만 남긴다. 완주율(가이드 §2.1 'CPX 세션 완주율')은
    중단·타임아웃·재시작을 분리해 세야 하는데, 뒤늦은 요청이 사유를 덮으면
    '제한시간 완주'가 '이전 연습 정리'로 바뀌어 분자가 사라진다.
    """
    with connect() as conn:
        conn.execute(
            "UPDATE sessions SET ended_at = COALESCE(ended_at, ?), status = 'ended', "
            "end_reason = COALESCE(end_reason, ?) WHERE id = ? AND user_id = ?",
            (time.time(), reason, session_id, user_id),
        )


def add_events(session_id: str, user_id: str, events: list[dict]) -> int:
    now = time.time()
    with connect() as conn:
        if not conn.execute('SELECT 1 FROM sessions WHERE id = ? AND user_id = ?', (session_id, user_id)).fetchone():
            return 0
        conn.executemany(
            'INSERT INTO transcript_events (session_id, role, text, t_offset_ms, created_at) VALUES (?, ?, ?, ?, ?)',
            [(session_id, e['role'], e['text'], int(e['tOffsetMs']), now) for e in events],
        )
    return len(events)


def list_scored_sessions(user_id: str, limit: int = 50) -> list[dict]:
    """채점 완료된 세션 목록 (점수 히스토리용)."""
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, case_id, started_at, ended_at, persona, result "
            "FROM sessions WHERE user_id = ? AND result IS NOT NULL ORDER BY started_at DESC LIMIT ?",
            (user_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def add_review_notes(session_id: str, user_id: str, case_id: str, notes: list[dict]) -> int:
    now = time.time()
    with connect() as conn:
        if not conn.execute('SELECT 1 FROM sessions WHERE id = ? AND user_id = ?', (session_id, user_id)).fetchone():
            return 0
        conn.executemany(
            'INSERT OR IGNORE INTO review_notes (session_id, case_id, section, item_id, item_text, created_at) '
            'VALUES (?, ?, ?, ?, ?, ?)',
            [(session_id, case_id, n['section'], n['itemId'], n['itemText'], now) for n in notes],
        )
        return conn.total_changes


def get_review_notes(user_id: str, case_id: str | None = None, limit: int = 200) -> list[dict]:
    q = ('SELECT r.session_id, r.case_id, r.section, r.item_id, r.item_text, r.created_at '
         'FROM review_notes r JOIN sessions s ON s.id = r.session_id WHERE s.user_id = ?')
    args: tuple = (user_id,)
    if case_id:
        q += ' AND r.case_id = ?'
        args += (case_id,)
    q += ' ORDER BY created_at DESC LIMIT ?'
    args += (limit,)
    with connect() as conn:
        rows = conn.execute(q, args).fetchall()
    return [dict(r) for r in rows]


def add_usage_events(session_id: str, user_id: str, events: list[dict], kind: str, model: str | None) -> int:
    """Live 턴별 usageMetadata(kind=live_turn) 또는 채점 호출 토큰(kind=evaluate) 기록."""
    now = time.time()
    with connect() as conn:
        if not conn.execute('SELECT 1 FROM sessions WHERE id = ? AND user_id = ?', (session_id, user_id)).fetchone():
            return 0
        conn.executemany(
            'INSERT INTO usage_events (session_id, kind, prompt_tokens, response_tokens, total_tokens, '
            'prompt_text_tokens, prompt_audio_tokens, response_text_tokens, response_audio_tokens, model, '
            't_offset_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [(
                session_id, kind,
                int(e.get('promptTokens', 0)), int(e.get('responseTokens', 0)), int(e.get('totalTokens', 0)),
                int(e.get('promptTextTokens', 0)), int(e.get('promptAudioTokens', 0)),
                int(e.get('responseTextTokens', 0)), int(e.get('responseAudioTokens', 0)),
                model, int(e.get('tOffsetMs', 0)), now,
            ) for e in events],
        )
    return len(events)


def get_usage_events(session_id: str, user_id: str) -> list[dict]:
    with connect() as conn:
        if not conn.execute('SELECT 1 FROM sessions WHERE id = ? AND user_id = ?', (session_id, user_id)).fetchone():
            return []
        rows = conn.execute(
            'SELECT * FROM usage_events WHERE session_id = ? ORDER BY id', (session_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def list_usage_sessions(user_id: str, limit: int = 20) -> list[dict]:
    """usage 기록이 있는 세션 목록 (최근순) — 세션별 원가 요약용."""
    with connect() as conn:
        rows = conn.execute(
            'SELECT DISTINCT s.id, s.case_id, s.started_at, s.ended_at FROM sessions s '
            'JOIN usage_events u ON u.session_id = s.id WHERE s.user_id = ? '
            'ORDER BY s.started_at DESC LIMIT ?',
            (user_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]


# ── 운영 성능 계측 (성능지표 가이드 1단계) ────────────────────────────────────

def add_request_metric(row: dict) -> None:
    """API 요청 1건의 계측 레코드를 남긴다.

    계측 실패가 서비스 요청을 실패시켜서는 안 된다 — 부르는 쪽(미들웨어)이 예외를 삼키지만,
    여기서도 실패를 조용히 흘리지는 않는다. 부르는 쪽에서 로그로 남긴다.
    """
    with connect() as conn:
        conn.execute(
            'INSERT INTO request_metrics (request_id, feature, version, user_id, session_id, model, method, '
            'status, status_code, error_code, total_ms, stages, schema_valid, created_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            (
                row['request_id'], row['feature'], row.get('version', 'v1'), row.get('user_id'),
                row.get('session_id'), row.get('model'), row['method'], row['status'],
                int(row['status_code']), row.get('error_code'), int(row['total_ms']),
                row.get('stages'), row.get('schema_valid'), row.get('created_at', time.time()),
            ),
        )


def purge_old_metrics(before: float) -> dict:
    """보존 기간을 넘긴 계측 행을 지운다.

    계측은 요청마다 한 줄씩 쌓인다 — 하트비트와 3초 flush 까지 세면 12분 세션 하나가
    수백 행이다. 단일 컨테이너 SQLite 볼륨에서 이걸 영원히 두면 언젠가 디스크가 찬다.
    턴 계측은 세션 삭제 시에도 함께 지워지지만, 오래된 세션은 그대로 남으므로 여기서도 턴다.
    """
    with connect() as conn:
        requests = conn.execute('DELETE FROM request_metrics WHERE created_at < ?', (before,)).rowcount
        turns = conn.execute('DELETE FROM turn_metrics WHERE created_at < ?', (before,)).rowcount
    return {'requests': max(requests, 0), 'turns': max(turns, 0)}


def list_request_metrics(since: float, feature: str | None = None, limit: int = 100_000) -> list[dict]:
    q = 'SELECT * FROM request_metrics WHERE created_at >= ?'
    args: tuple = (since,)
    if feature:
        q += ' AND feature = ?'
        args += (feature,)
    q += ' ORDER BY created_at DESC LIMIT ?'
    args += (limit,)
    with connect() as conn:
        return [dict(r) for r in conn.execute(q, args).fetchall()]


def add_turn_metrics(session_id: str, user_id: str, events: list[dict], model: str | None) -> int:
    """클라이언트가 측정한 턴 응답시간을 적재한다.

    같은 턴이 재전송으로 두 번 오면 UNIQUE(session_id, turn_index) 가 막는다 — 지연시간
    분포는 표본 하나가 두 번 세어지면 그만큼 왜곡되므로, 중복은 무시(INSERT OR IGNORE)한다.
    """
    now = time.time()
    with connect() as conn:
        if not conn.execute('SELECT 1 FROM sessions WHERE id = ? AND user_id = ?', (session_id, user_id)).fetchone():
            return 0
        before = conn.total_changes
        conn.executemany(
            'INSERT OR IGNORE INTO turn_metrics (session_id, turn_index, input_mode, speech_end_offset_ms, '
            'first_response_ms, first_audio_ms, turn_complete_ms, interrupted, network, model, created_at) '
            'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [(
                session_id, int(e['turnIndex']), e.get('inputMode', 'voice'), int(e.get('speechEndOffsetMs', 0)),
                e.get('firstResponseMs'), e.get('firstAudioMs'), e.get('turnCompleteMs'),
                1 if e.get('interrupted') else 0, e.get('network'), model, now,
            ) for e in events],
        )
        return conn.total_changes - before


def get_turn_metrics(session_id: str, user_id: str) -> list[dict]:
    with connect() as conn:
        if not conn.execute('SELECT 1 FROM sessions WHERE id = ? AND user_id = ?', (session_id, user_id)).fetchone():
            return []
        rows = conn.execute(
            'SELECT * FROM turn_metrics WHERE session_id = ? ORDER BY turn_index', (session_id,),
        ).fetchall()
    return [dict(r) for r in rows]


def list_turn_metrics(since: float, limit: int = 200_000) -> list[dict]:
    with connect() as conn:
        rows = conn.execute(
            'SELECT * FROM turn_metrics WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?', (since, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def list_sessions_since(since: float, limit: int = 100_000) -> list[dict]:
    """완주율 집계용 — 기간 내 시작된 세션의 상태·종료 사유·채점 여부."""
    with connect() as conn:
        rows = conn.execute(
            'SELECT id, user_id, case_id, started_at, ended_at, status, end_reason, config, '
            '(result IS NOT NULL) AS scored FROM sessions WHERE started_at >= ? '
            'ORDER BY started_at DESC LIMIT ?',
            (since, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def usage_events_since(since: float, limit: int = 500_000) -> list[dict]:
    """기간 내 세션들의 usage 행 — 세션당 원가 집계용 (세션 시작 시각 기준)."""
    with connect() as conn:
        rows = conn.execute(
            'SELECT u.* FROM usage_events u JOIN sessions s ON s.id = u.session_id '
            'WHERE s.started_at >= ? ORDER BY u.session_id, u.id LIMIT ?',
            (since, limit),
        ).fetchall()
    return [dict(r) for r in rows]


def get_transcript(session_id: str, user_id: str) -> list[dict]:
    with connect() as conn:
        if not conn.execute('SELECT 1 FROM sessions WHERE id = ? AND user_id = ?', (session_id, user_id)).fetchone():
            return []
        rows = conn.execute(
            'SELECT role, text, t_offset_ms FROM transcript_events WHERE session_id = ? ORDER BY t_offset_ms, id',
            (session_id,),
        ).fetchall()
    return [{'role': r['role'], 'text': r['text'], 'tOffsetMs': r['t_offset_ms']} for r in rows]


def delete_user_data(user_id: str) -> int:
    """Delete every CPX record owned by a LectureLink account."""
    with connect() as conn:
        session_ids = [
            row['id'] for row in conn.execute(
                'SELECT id FROM sessions WHERE user_id = ?', (user_id,),
            ).fetchall()
        ]
        if not session_ids:
            return 0
        placeholders = ','.join('?' for _ in session_ids)
        conn.execute(f'DELETE FROM review_notes WHERE session_id IN ({placeholders})', session_ids)
        conn.execute(f'DELETE FROM usage_events WHERE session_id IN ({placeholders})', session_ids)
        conn.execute(f'DELETE FROM turn_metrics WHERE session_id IN ({placeholders})', session_ids)
        conn.execute('DELETE FROM request_metrics WHERE user_id = ?', (user_id,))
        conn.execute(f'DELETE FROM transcript_events WHERE session_id IN ({placeholders})', session_ids)
        conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
        return len(session_ids)
