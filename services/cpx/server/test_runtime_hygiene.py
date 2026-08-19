"""런타임 위생 회귀 — 스키마 반복 실행·WAL·인증 기본값·정산 시각·조기 채점 (2026-08-18 감사 P2)."""
from __future__ import annotations

import importlib
import os
import tempfile
import time
from pathlib import Path

os.environ['REQUIRE_LECTURELINK_AUTH'] = 'true'
os.environ['CPX_PROXY_SHARED_SECRET'] = 'offline-runtime-hygiene-secret'

import db  # noqa: E402
import main  # noqa: E402
import prompt as pm  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

HEADERS = {
    'x-cpx-proxy-secret': 'offline-runtime-hygiene-secret',
    'x-lecturelink-user-id': 'runtime-hygiene-tester',
}
CASE_ID = 'chronic_primary_insomnia_rule'


def test_schema_runs_once_and_wal_is_on() -> None:
    """connect() 마다 DDL 을 돌리면 요청마다 쓰기 잠금을 잡는다."""
    with tempfile.TemporaryDirectory(prefix='cpx-hygiene-') as tmpdir:
        db.DB_PATH = Path(tmpdir) / 'cpx.sqlite3'
        db._initialized_for = None
        calls = {'n': 0}
        original = db._initialize

        def counting(conn):
            calls['n'] += 1
            original(conn)

        db._initialize = counting
        try:
            for _ in range(5):
                conn = db.connect()
                mode = conn.execute('PRAGMA journal_mode').fetchone()[0]
                assert mode.lower() == 'wal', f'WAL 이 아니다: {mode}'
                busy = conn.execute('PRAGMA busy_timeout').fetchone()[0]
                assert int(busy) >= 1000, f'busy_timeout 이 없다: {busy}'
                conn.close()
            assert calls['n'] == 1, f'스키마 초기화가 {calls["n"]}회 실행됐다 (1회여야 함)'
        finally:
            db._initialize = original
    print('  스키마 1회 실행 · WAL · busy_timeout 통과')


def test_auth_defaults_to_required() -> None:
    """환경변수를 빠뜨린 배포가 조용히 인증 없이 열리면 안 된다."""
    saved = os.environ.pop('REQUIRE_LECTURELINK_AUTH', None)
    try:
        reloaded = importlib.reload(main)
        assert reloaded.REQUIRE_LECTURELINK_AUTH is True, '기본값이 fail-open 이다'
    finally:
        if saved is not None:
            os.environ['REQUIRE_LECTURELINK_AUTH'] = saved
        importlib.reload(main)
    print('  인증 기본값 fail-closed 통과')


def test_end_time_is_not_overwritten() -> None:
    """정산 뒤 늦게 도착한 종료 요청이 종료 시각을 밀면 기록과 정산이 어긋난다."""
    with tempfile.TemporaryDirectory(prefix='cpx-hygiene-end-') as tmpdir:
        db.DB_PATH = Path(tmpdir) / 'cpx.sqlite3'
        db._initialized_for = None
        sid = db.create_session(CASE_ID, 'u1', None, None)
        db.end_session(sid, 'u1')
        first = db.get_session(sid, 'u1')['ended_at']
        time.sleep(0.02)
        db.end_session(sid, 'u1')
        second = db.get_session(sid, 'u1')['ended_at']
        assert first == second, f'종료 시각이 덮어써졌다: {first} → {second}'
    print('  종료 시각 보존 통과')


def test_case_index_is_cached() -> None:
    """목록 조회마다 243개 파일을 다시 파싱하면 안 된다."""
    reads = {'n': 0}
    original = pm._read_case

    def counting(path):
        reads['n'] += 1
        return original(path)

    pm._read_case = counting
    pm._index_cache = None
    try:
        pm.list_cases()
        first = reads['n']
        assert first > 0
        for _ in range(5):
            pm.list_cases()
        assert reads['n'] == first, f'캐시가 동작하지 않는다 ({first} → {reads["n"]})'
    finally:
        pm._read_case = original
    print(f'  증례 인덱스 캐시 통과 (첫 조회 {first}건 읽고 이후 0건)')


def test_active_session_cannot_be_scored(client) -> None:
    """진행 중 채점은 부분 결과를 캐시로 굳혀 최종 결과를 영영 못 만들게 한다."""
    created = client.post('/api/sessions', headers=HEADERS,
                          json={'caseId': CASE_ID, 'timeLimitSeconds': 720})
    sid = created.json()['sessionId']
    r = client.post(f'/api/sessions/{sid}/evaluate', headers=HEADERS)
    assert r.status_code == 409, f'진행 중 세션이 채점됐다: {r.status_code} {r.text[:120]}'
    client.post(f'/api/sessions/{sid}/end', headers=HEADERS)
    r2 = client.post(f'/api/sessions/{sid}/evaluate', headers=HEADERS)
    assert r2.status_code != 409, '종료된 세션이 여전히 막힌다'
    print('  진행 중 세션 조기 채점 차단 통과')


def main_() -> None:
    test_schema_runs_once_and_wal_is_on()
    test_end_time_is_not_overwritten()
    test_case_index_is_cached()
    test_auth_defaults_to_required()
    with tempfile.TemporaryDirectory(prefix='cpx-hygiene-api-') as tmpdir:
        db.DB_PATH = Path(tmpdir) / 'cpx.sqlite3'
        db._initialized_for = None
        main.GEMINI_API_KEY = ''
        with TestClient(main.app) as client:
            test_active_session_cannot_be_scored(client)
    print('런타임 위생 회귀 테스트 통과')


if __name__ == '__main__':
    main_()
