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
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    # 기존 DB 마이그레이션: 누락 컬럼 추가
    cols = {r[1] for r in conn.execute('PRAGMA table_info(sessions)')}
    for col in ('persona', 'result', 'user_id', 'config'):
        if col not in cols:
            if col == 'user_id':
                conn.execute("ALTER TABLE sessions ADD COLUMN user_id TEXT NOT NULL DEFAULT 'local'")
            else:
                conn.execute(f'ALTER TABLE sessions ADD COLUMN {col} TEXT')
    conn.execute('CREATE INDEX IF NOT EXISTS idx_sessions_user_started ON sessions(user_id, started_at DESC)')
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


def end_session(session_id: str, user_id: str) -> None:
    with connect() as conn:
        conn.execute(
            "UPDATE sessions SET ended_at = ?, status = 'ended' WHERE id = ? AND user_id = ?",
            (time.time(), session_id, user_id),
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
        conn.execute(f'DELETE FROM transcript_events WHERE session_id IN ({placeholders})', session_ids)
        conn.execute('DELETE FROM sessions WHERE user_id = ?', (user_id,))
        return len(session_ids)
