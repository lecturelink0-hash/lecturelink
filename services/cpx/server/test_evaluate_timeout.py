"""채점 하드 타임아웃이 실제로 응답을 끊는지 — 시간으로 재현하는 회귀 테스트.

감사(2026-08-18 다1) 전 구현은 `with ThreadPoolExecutor(...)` 를 써서, 블록을 벗어날 때
shutdown(wait=True) 가 작업 스레드를 기다렸다. 그래서 타임아웃이 나도 응답은 LLM 호출이
끝난 뒤에야 나갔고 "결과 화면 무한 로딩"이 그대로 발생했다. 타임아웃 상수(75초)를 그대로
쓰면 테스트가 75초 걸리므로, 같은 구조를 짧은 상수로 재현해 두 방식의 차이를 시간으로 잰다.
"""
import concurrent.futures as cf
import time

SLOW = 2.0        # '매달린 LLM 호출'
TIMEOUT = 0.3     # 하드 타임아웃


def _hanging_call():
    time.sleep(SLOW)
    return 'late'


def _old_way():
    """감사 전 구현 — 컨텍스트 매니저가 작업 스레드를 기다린다."""
    try:
        with cf.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(_hanging_call).result(timeout=TIMEOUT)
    except cf.TimeoutError:
        return 'timeout'


def _new_way():
    """현재 구현 — finally 에서 wait=False 로 내려 기다리지 않는다."""
    pool = cf.ThreadPoolExecutor(max_workers=1)
    try:
        return pool.submit(_hanging_call).result(timeout=TIMEOUT)
    except cf.TimeoutError:
        return 'timeout'
    finally:
        pool.shutdown(wait=False, cancel_futures=True)


def test_timeout_returns_promptly() -> None:
    t0 = time.monotonic()
    assert _new_way() == 'timeout'
    elapsed = time.monotonic() - t0
    assert elapsed < SLOW * 0.6, (
        f'타임아웃 뒤에도 {elapsed:.2f}초를 기다렸다 — 매달린 호출이 끝나기를 기다리고 있다. '
        'ThreadPoolExecutor 를 with 로 감싸면 shutdown(wait=True) 가 실행된다.'
    )


def test_old_structure_did_not_cut_off() -> None:
    """결함 재현 — 옛 구조는 타임아웃을 잡고도 호출이 끝날 때까지 붙잡고 있었다."""
    t0 = time.monotonic()
    assert _old_way() == 'timeout'
    elapsed = time.monotonic() - t0
    assert elapsed >= SLOW * 0.8, (
        '옛 구조가 더는 기다리지 않는다면 이 테스트의 전제가 낡은 것이다 — 확인하고 갱신하라.'
    )


def test_server_uses_the_non_blocking_shape() -> None:
    """main.py 가 실제로 이 구조를 쓰는지 — 테스트만 통과하고 코드가 되돌아가는 것을 막는다."""
    from pathlib import Path
    src = (Path(__file__).resolve().parent / 'main.py').read_text(encoding='utf-8')
    block = src[src.index('하드 타임아웃'):src.index('eval_usage = judgments.pop')]
    assert 'with _cf.ThreadPoolExecutor' not in block, (
        'ThreadPoolExecutor 를 with 로 감쌌다 — shutdown(wait=True) 가 응답을 붙잡는다.'
    )
    assert 'pool.shutdown(wait=False' in block, '타임아웃 뒤 wait=False 로 내리지 않는다.'


if __name__ == '__main__':
    test_timeout_returns_promptly()
    test_old_structure_did_not_cut_off()
    test_server_uses_the_non_blocking_shape()
    print('채점 타임아웃 회귀 테스트 통과 — 타임아웃이 응답을 즉시 끊고, 옛 구조는 못 끊었음을 재현')
