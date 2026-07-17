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
"""


def connect() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.executescript(SCHEMA)
    # 기존 DB 마이그레이션: 누락 컬럼 추가
    cols = {r[1] for r in conn.execute('PRAGMA table_info(sessions)')}
    for col in ('persona', 'result', 'user_id'):
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


def create_session(case_id: str, user_id: str, persona_json: str | None = None) -> str:
    session_id = uuid.uuid4().hex
    with connect() as conn:
        conn.execute(
            'INSERT INTO sessions (id, user_id, case_id, started_at, persona) VALUES (?, ?, ?, ?, ?)',
            (session_id, user_id, case_id, time.time(), persona_json),
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


def get_transcript(session_id: str, user_id: str) -> list[dict]:
    with connect() as conn:
        if not conn.execute('SELECT 1 FROM sessions WHERE id = ? AND user_id = ?', (session_id, user_id)).fetchone():
            return []
        rows = conn.execute(
            'SELECT role, text, t_offset_ms FROM transcript_events WHERE session_id = ? ORDER BY t_offset_ms, id',
            (session_id,),
        ).fetchall()
    return [{'role': r['role'], 'text': r['text'], 'tOffsetMs': r['t_offset_ms']} for r in rows]
