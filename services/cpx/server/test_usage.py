"""세션 토큰 사용량(usage_events) 기록·원가 환산 회귀 테스트 — API 키 불필요(오프라인)."""
import os
import tempfile

# db/main 임포트 전에 임시 DB 경로 확정 (DB_PATH는 임포트 시점에 굳는다)
_tmpdir = tempfile.mkdtemp(prefix='cpx-usage-test-')
os.environ['CPX_DB_PATH'] = os.path.join(_tmpdir, 'cpx.sqlite3')
os.environ.setdefault('REQUIRE_LECTURELINK_AUTH', 'false')
os.environ['CPX_USD_KRW'] = '1450'

from fastapi.testclient import TestClient  # noqa: E402

import db  # noqa: E402
import usage as usage_mod  # noqa: E402
from main import app  # noqa: E402
import prompt as prompt_mod  # noqa: E402

client = TestClient(app)
USER_A = {'x-lecturelink-user-id': 'usage-test-user-a'}
USER_B = {'x-lecturelink-user-id': 'usage-test-user-b'}


def approx(a: float, b: float, eps: float = 1e-9) -> bool:
    return abs(a - b) <= eps


def main():
    case_id = prompt_mod.list_cases()[0]['id']

    # 1) 세션 생성 + 턴별 usage 2건 기록
    created = client.post('/api/sessions', json={'caseId': case_id}, headers=USER_A).json()
    sid = created['sessionId']
    turns = [
        {  # 모달리티 분해가 합계와 일치하는 정상 턴
            'promptTokens': 10_000, 'responseTokens': 500, 'totalTokens': 10_500,
            'promptTextTokens': 6_000, 'promptAudioTokens': 4_000,
            'responseTextTokens': 50, 'responseAudioTokens': 450, 'tOffsetMs': 5_000,
        },
        {  # 분해 합계가 1,000토큰 부족한 턴 → 잔여분은 오디오 단가로 보수 가산
            'promptTokens': 20_000, 'responseTokens': 600, 'totalTokens': 20_600,
            'promptTextTokens': 6_000, 'promptAudioTokens': 13_000,
            'responseTextTokens': 0, 'responseAudioTokens': 600, 'tOffsetMs': 15_000,
        },
    ]
    saved = client.post(f'/api/sessions/{sid}/usage', json=turns, headers=USER_A).json()
    assert saved == {'saved': 2}, saved

    # 2) 원가 환산 검증 — gemini-3.1-flash-live 단가 (text_in .75 / audio_in 3 / text_out 4.5 / audio_out 12)
    body = client.get(f'/api/sessions/{sid}/usage', headers=USER_A).json()
    summary = body['summary']
    expected_live_usd = (
        (6_000 * 0.75 + 4_000 * 3.0 + 50 * 4.5 + 450 * 12.0)
        + (6_000 * 0.75 + (13_000 + 1_000) * 3.0 + 0 * 4.5 + 600 * 12.0)
    ) / 1e6
    assert summary['turns'] == 2, summary
    assert summary['live']['promptTokens'] == 30_000
    assert summary['live']['unattributedPromptTokens'] == 1_000
    assert approx(summary['live']['usd'], round(expected_live_usd, 6)), (summary['live']['usd'], expected_live_usd)
    assert approx(summary['usd'], round(expected_live_usd, 6))
    assert approx(summary['krw'], round(expected_live_usd * 1450, 1)), summary['krw']
    assert len(body['events']) == 2

    # 3) 채점(kind=evaluate) 행 — gemini-2.5-flash 단가 (in .30 / out 2.50)
    n = db.add_usage_events(
        sid, USER_A['x-lecturelink-user-id'],
        [{'promptTokens': 5_000, 'responseTokens': 3_000, 'totalTokens': 8_000,
          'promptTextTokens': 5_000, 'responseTextTokens': 3_000}],
        kind='evaluate', model='gemini-2.5-flash',
    )
    assert n == 1
    summary2 = client.get(f'/api/sessions/{sid}/usage', headers=USER_A).json()['summary']
    expected_eval_usd = (5_000 * 0.30 + 3_000 * 2.50) / 1e6
    assert summary2['eval']['calls'] == 1
    assert approx(summary2['eval']['usd'], round(expected_eval_usd, 6))
    assert approx(summary2['usd'], round(expected_live_usd + expected_eval_usd, 6))
    assert summary2['evalModel'] == 'gemini-2.5-flash'
    assert summary2['turns'] == 2  # evaluate 행은 턴 수에 안 들어간다

    # 4) 소유권 격리 — 다른 사용자로는 404, 기록도 차단
    assert client.get(f'/api/sessions/{sid}/usage', headers=USER_B).status_code == 404
    assert client.post(f'/api/sessions/{sid}/usage', json=turns, headers=USER_B).status_code == 404

    # 5) 사용자 요약 — 세션 집계와 평균
    agg = client.get('/api/usage/summary', headers=USER_A).json()
    assert agg['count'] == 1
    assert agg['sessions'][0]['sessionId'] == sid
    assert approx(agg['totalUsd'], round(expected_live_usd + expected_eval_usd, 6))
    assert approx(agg['meanLiveSessionUsd'], round(expected_live_usd + expected_eval_usd, 6))

    # 6) 단가 매칭 — 최장 접두사 (2.5-flash-lite가 2.5-flash로 오매칭되면 안 됨)
    lite = usage_mod._match_price(usage_mod.EVAL_PRICES, 'gemini-2.5-flash-lite', usage_mod.DEFAULT_EVAL_PRICE_KEY)
    assert lite['in'] == 0.10 and lite['out'] == 0.40
    unknown = usage_mod._match_price(usage_mod.LIVE_PRICES, 'totally-new-model', usage_mod.DEFAULT_LIVE_PRICE_KEY)
    assert unknown == usage_mod.LIVE_PRICES['gemini-3.1-flash-live']

    print('usage 기록·원가 환산·격리·요약 6그룹 통과')


if __name__ == '__main__':
    main()
