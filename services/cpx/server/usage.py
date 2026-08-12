"""Live/채점 토큰 사용량 → 원가 환산.

Live API는 턴마다 그 시점까지의 누적 컨텍스트 전체(시스템 프롬프트 + 모든 오디오)를
입력 토큰으로 재과금한다(Google 공식 확인). 따라서 턴별 usageMetadata의
promptTokenCount를 그대로 합산한 값이 곧 실제 청구량이며, 별도의 보정이 필요 없다.

가격표는 2026-08-12 Google 공식 요금(USD per 1M tokens). 단가 개정·모델 교체 시 여기만 수정.
"""
import os

# 모델명 최장 접두사 일치로 단가를 찾는다 (예: gemini-3.1-flash-live-preview → gemini-3.1-flash-live)
LIVE_PRICES = {
    'gemini-3.1-flash-live': {'text_in': 0.75, 'audio_in': 3.00, 'text_out': 4.50, 'audio_out': 12.00},
    'gemini-2.5-flash-native-audio': {'text_in': 0.50, 'audio_in': 3.00, 'text_out': 2.00, 'audio_out': 12.00},
}
EVAL_PRICES = {
    'gemini-2.5-flash-lite': {'in': 0.10, 'out': 0.40},
    'gemini-3.1-flash-lite': {'in': 0.25, 'out': 1.50},
    'gemini-2.5-flash': {'in': 0.30, 'out': 2.50},
}
DEFAULT_LIVE_PRICE_KEY = 'gemini-3.1-flash-live'
DEFAULT_EVAL_PRICE_KEY = 'gemini-2.5-flash'


def _match_price(table: dict, model: str | None, default_key: str) -> dict:
    name = str(model or '')
    best = None
    for key in table:
        if name.startswith(key) and (best is None or len(key) > len(best)):
            best = key
    return table[best or default_key]


def usd_krw_rate() -> float:
    try:
        return float(os.environ.get('CPX_USD_KRW', '1450'))
    except ValueError:
        return 1450.0


def summarize(rows: list[dict]) -> dict:
    """usage_events 행들(kind=live_turn|evaluate)을 세션 요약 + 원가로 환산.

    모달리티 분해(text/audio)가 합계보다 부족한 잔여 토큰은 보수적으로 오디오 단가로
    가산하고 unattributed* 필드에 따로 보고한다 (과소 청구 추정 방지).
    """
    live = {
        'turns': 0,
        'promptTokens': 0, 'promptTextTokens': 0, 'promptAudioTokens': 0,
        'responseTokens': 0, 'responseTextTokens': 0, 'responseAudioTokens': 0,
        'unattributedPromptTokens': 0, 'unattributedResponseTokens': 0,
    }
    eval_sum = {'calls': 0, 'promptTokens': 0, 'responseTokens': 0}
    live_usd = 0.0
    eval_usd = 0.0
    live_model = None
    eval_model = None

    for row in rows:
        kind = row.get('kind') or 'live_turn'
        if kind == 'evaluate':
            price = _match_price(EVAL_PRICES, row.get('model'), DEFAULT_EVAL_PRICE_KEY)
            eval_model = eval_model or row.get('model')
            eval_sum['calls'] += 1
            eval_sum['promptTokens'] += row.get('prompt_tokens', 0)
            eval_sum['responseTokens'] += row.get('response_tokens', 0)
            eval_usd += (row.get('prompt_tokens', 0) * price['in'] + row.get('response_tokens', 0) * price['out']) / 1e6
            continue

        price = _match_price(LIVE_PRICES, row.get('model'), DEFAULT_LIVE_PRICE_KEY)
        live_model = live_model or row.get('model')
        p_total = row.get('prompt_tokens', 0)
        p_text = row.get('prompt_text_tokens', 0)
        p_audio = row.get('prompt_audio_tokens', 0)
        r_total = row.get('response_tokens', 0)
        r_text = row.get('response_text_tokens', 0)
        r_audio = row.get('response_audio_tokens', 0)
        p_rest = max(0, p_total - p_text - p_audio)
        r_rest = max(0, r_total - r_text - r_audio)
        live['turns'] += 1
        live['promptTokens'] += p_total
        live['promptTextTokens'] += p_text
        live['promptAudioTokens'] += p_audio
        live['responseTokens'] += r_total
        live['responseTextTokens'] += r_text
        live['responseAudioTokens'] += r_audio
        live['unattributedPromptTokens'] += p_rest
        live['unattributedResponseTokens'] += r_rest
        live_usd += (
            p_text * price['text_in'] + (p_audio + p_rest) * price['audio_in']
            + r_text * price['text_out'] + (r_audio + r_rest) * price['audio_out']
        ) / 1e6

    rate = usd_krw_rate()
    total_usd = live_usd + eval_usd
    return {
        'liveModel': live_model,
        'evalModel': eval_model,
        'turns': live['turns'],
        'live': {**live, 'usd': round(live_usd, 6)},
        'eval': {**eval_sum, 'usd': round(eval_usd, 6)},
        'usd': round(total_usd, 6),
        'krw': round(total_usd * rate, 1),
        'usdKrwRate': rate,
    }
