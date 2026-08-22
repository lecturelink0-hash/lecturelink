"""반복 생성 안정성 측정 — 성능지표 가이드 §4.2.

가이드 요구:
  - 동일한 입력, 프롬프트, 모델 버전으로 최소 10회 반복한다.
  - 스키마 준수, 정답 개념, 출처 문단, 핵심 주장, 실행시간의 변동을 계산한다.
  - 모델과 프롬프트가 바뀔 때 같은 고정 입력셋으로 다시 실행한다.

CPX에서 이 검사의 대상은 **채점 근거 추출**이다. AI 환자 대화는 학생의 질문이 매번 달라
같은 입력을 만들 수 없지만, 채점은 '고정된 전사 → 항목별 판정'이라 완전히 반복 가능하다.
채점이 흔들리면 같은 진료가 볼 때마다 다른 점수를 받는다 — 학습 도구로서 가장 치명적인 실패다.

CPX 용어 대응:
  - 정답 개념  → 항목별 판정(met/partial/not_met)과 총점
  - 출처 문단  → 판정의 근거 인용(전사 줄 번호)
  - 핵심 주장  → 위반(violations)·임상추론 판정

실행:
    GEMINI_API_KEY=... venv/bin/python repeatability.py --runs 10 --out ../../../outputs/cpx-repeatability.json
    venv/bin/python repeatability.py --selftest      # 산식만 검증 (API 키·쿼터 불필요)

주의: 이 하니스의 결과를 보고 프롬프트를 고친 뒤 같은 입력으로 다시 재면 그 수치는
개발셋 성능이지 테스트셋 성능이 아니다(가이드 §10.2). 고정 입력을 바꾸면 이전 측정과
비교할 수 없으므로 fixtureId 를 함께 보고한다.
"""
import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path

import evaluate as ev
import metrics as metrics_mod
import prompt as prompt_mod
import scoring

FIXTURE_PATH = Path(__file__).resolve().parent / 'fixtures' / 'repeatability_transcript.json'
DEFAULT_RUNS = 10


def load_fixture(path: Path = FIXTURE_PATH) -> dict:
    return json.loads(path.read_text(encoding='utf-8'))


# ── 변동 계산 (순수 함수 — selftest 로 오프라인 검증한다) ──────────────────────

def _mode_share(values: list) -> tuple[object, float]:
    """최빈값과 그 비율. 판정이 갈리는 정도를 항목 하나 단위로 나타낸다."""
    if not values:
        return None, 0.0
    counts: dict = {}
    for v in values:
        counts[v] = counts.get(v, 0) + 1
    best = max(counts.items(), key=lambda kv: kv[1])
    return best[0], best[1] / len(values)


def stability(runs: list[dict]) -> dict:
    """반복 실행 결과들의 변동 지표.

    runs 각 원소:
      {'ok': bool, 'elapsedMs': int, 'schemaProblems': [...], 'totalScore': float,
       'items': {item_id: 'met'|'partial'|'not_met'}, 'evidenceCounts': {item_id: int},
       'violationTypes': ['et01', ...], 'error': str | None}
    """
    total = len(runs)
    ok_runs = [r for r in runs if r.get('ok')]
    completed = len(ok_runs)

    # 스키마 준수율 — 성공한 실행 중 계약을 지킨 비율
    schema_ok = sum(1 for r in ok_runs if not r.get('schemaProblems'))
    schema_problems: dict[str, int] = {}
    for r in ok_runs:
        for problem in r.get('schemaProblems') or []:
            schema_problems[problem] = schema_problems.get(problem, 0) + 1

    # 항목 판정 안정성 — 항목마다 '가장 흔한 판정이 차지한 비율'을 구해 평균낸다.
    # 1.0 이면 모든 실행이 같은 판정을 냈다는 뜻이다.
    item_ids: set = set()
    for r in ok_runs:
        item_ids.update((r.get('items') or {}).keys())
    per_item = []
    unstable = []
    for item_id in sorted(item_ids):
        verdicts = [(r.get('items') or {}).get(item_id) for r in ok_runs]
        verdicts = [v for v in verdicts if v is not None]
        if not verdicts:
            continue
        modal, share = _mode_share(verdicts)
        per_item.append(share)
        if share < 1.0:
            counts: dict = {}
            for v in verdicts:
                counts[v] = counts.get(v, 0) + 1
            unstable.append({'itemId': item_id, 'modal': modal, 'agreement': round(share, 4),
                             'counts': dict(sorted(counts.items()))})
    unstable.sort(key=lambda u: u['agreement'])

    # 근거 인용 안정성 — 판정이 같아도 근거를 들었다 말았다 하면 학생에게 보이는 화면이 달라진다
    evidence_shares = []
    for item_id in sorted(item_ids):
        flags = [bool((r.get('evidenceCounts') or {}).get(item_id)) for r in ok_runs]
        if flags:
            evidence_shares.append(_mode_share(flags)[1])

    scores = [r['totalScore'] for r in ok_runs if isinstance(r.get('totalScore'), (int, float))]
    elapsed = [r['elapsedMs'] for r in ok_runs if isinstance(r.get('elapsedMs'), (int, float))]
    violation_sets = [tuple(sorted(set(r.get('violationTypes') or []))) for r in ok_runs]

    errors: dict[str, int] = {}
    for r in runs:
        if not r.get('ok'):
            errors[str(r.get('error') or 'unknown')] = errors.get(str(r.get('error') or 'unknown'), 0) + 1

    return {
        'runs': total,
        'completed': completed,
        'completionRate': round(completed / total, 4) if total else None,
        'errors': dict(sorted(errors.items(), key=lambda kv: -kv[1])),
        'schemaValidRate': round(schema_ok / completed, 4) if completed else None,
        'schemaProblems': dict(sorted(schema_problems.items(), key=lambda kv: -kv[1])),
        'items': {
            'count': len(per_item),
            'meanAgreement': round(sum(per_item) / len(per_item), 4) if per_item else None,
            'fullyStable': sum(1 for s in per_item if s == 1.0),
            'unstable': len(unstable),
            'unstableRate': round(len(unstable) / len(per_item), 4) if per_item else None,
            'worst': unstable[:15],
        },
        'evidence': {
            'meanAgreement': round(sum(evidence_shares) / len(evidence_shares), 4) if evidence_shares else None,
        },
        'totalScore': {
            'mean': round(statistics.fmean(scores), 3) if scores else None,
            'sd': round(statistics.pstdev(scores), 3) if len(scores) > 1 else 0.0 if scores else None,
            'min': min(scores) if scores else None,
            'max': max(scores) if scores else None,
            'range': round(max(scores) - min(scores), 3) if scores else None,
        },
        'violations': {
            'identicalRate': round(_mode_share(violation_sets)[1], 4) if violation_sets else None,
        },
        'elapsedMs': metrics_mod.latency_stats(elapsed),
    }


# ── 실행 ─────────────────────────────────────────────────────────────────────

def run_once(api_key: str, case: dict, rubric: dict, events: list[dict], context: dict) -> dict:
    started = time.perf_counter()
    try:
        judgments = ev.extract_judgments(api_key, rubric, events, context, case)
    except Exception as exc:  # noqa: BLE001 — SDK 예외 유형이 넓다
        return {'ok': False, 'error': type(exc).__name__ + ': ' + str(exc)[:200],
                'elapsedMs': int((time.perf_counter() - started) * 1000)}
    elapsed_ms = int((time.perf_counter() - started) * 1000)

    judgments.pop('usage', None)
    reasoning = judgments.pop('clinicalReasoning', None)
    items = judgments['items']
    result = scoring.score_session(rubric, judgments, context)
    result['clinicalReasoning'] = reasoning or ev.normalize_clinical_reasoning(None)
    result['feedback'] = ev.build_feedback(rubric, result, result['clinicalReasoning'])
    result['judgments'] = items
    result['caseId'] = case.get('id', '')
    result['itemTexts'] = {
        i['id']: i['text'] for s in rubric['sections'] if s['type'] != 'deduction' for i in s['items']
    }
    result['timeAnalysis'] = {}

    return {
        'ok': True,
        'error': None,
        'elapsedMs': elapsed_ms,
        'schemaProblems': metrics_mod.validate_result_schema(result),
        'totalScore': result.get('totalScore'),
        'items': {k: v.get('status') for k, v in items.items()},
        'evidenceCounts': {k: len(v.get('evidence') or []) for k, v in items.items()},
        'violationTypes': [v.get('type') for v in (judgments.get('violations') or []) if v.get('type')],
    }


def measure(runs: int, fixture: dict, api_key: str, verbose: bool = True) -> dict:
    case = prompt_mod.load_case(fixture['caseId'])
    rubric = ev.load_rubric(case)
    context = ev.build_context(case, fixture.get('persona'))
    events = fixture['events']

    results = []
    for i in range(runs):
        outcome = run_once(api_key, case, rubric, events, context)
        results.append(outcome)
        if verbose:
            mark = 'OK ' if outcome['ok'] else 'ERR'
            score = outcome.get('totalScore')
            print(f'  [{i + 1}/{runs}] {mark} {outcome["elapsedMs"]}ms '
                  f'총점={score if score is not None else "-"}', flush=True)

    return {
        'fixtureId': fixture.get('fixtureId'),
        'caseId': fixture['caseId'],
        'evalModel': ev.EVAL_MODEL,
        'thinkingBudget': int(os.environ.get('GEMINI_EVAL_THINKING_BUDGET', '0')),
        'temperature': 0,
        'measuredAt': time.time(),
        'stability': stability(results),
        'runs': results,
    }


# ── 판정 기준 ────────────────────────────────────────────────────────────────
# 대외 보고 전에 자체적으로 넘겨야 하는 선. 1단계는 "얼마나 흔들리는지 안다"가 목표이므로
# 통과/실패는 참고값이며, 미달이면 원인(모델·프롬프트·thinking budget)을 함께 보고한다.
THRESHOLDS = {
    'schemaValidRate': 1.0,      # 계약 위반은 0건이어야 한다 — 화면이 조용히 깨진다
    'itemMeanAgreement': 0.95,   # 항목 판정 평균 일치도
    'totalScoreSd': 2.0,         # 총점 표준편차(100점 만점)
}


def verdicts(stats: dict) -> list[dict]:
    out = []
    schema_rate = stats.get('schemaValidRate')
    out.append({'metric': 'schemaValidRate', 'value': schema_rate,
                'threshold': THRESHOLDS['schemaValidRate'],
                'pass': schema_rate is not None and schema_rate >= THRESHOLDS['schemaValidRate']})
    agreement = (stats.get('items') or {}).get('meanAgreement')
    out.append({'metric': 'itemMeanAgreement', 'value': agreement,
                'threshold': THRESHOLDS['itemMeanAgreement'],
                'pass': agreement is not None and agreement >= THRESHOLDS['itemMeanAgreement']})
    sd = (stats.get('totalScore') or {}).get('sd')
    out.append({'metric': 'totalScoreSd', 'value': sd, 'threshold': THRESHOLDS['totalScoreSd'],
                'pass': sd is not None and sd <= THRESHOLDS['totalScoreSd']})
    return out


def print_report(report: dict) -> None:
    stats = report['stability']
    print()
    print('반복 생성 안정성 (성능지표 가이드 §4.2)')
    print(f"  고정 입력  : {report['fixtureId']} / 증례 {report['caseId']}")
    print(f"  모델·설정  : {report['evalModel']} temperature=0 thinking={report['thinkingBudget']}")
    print(f"  실행       : {stats['completed']}/{stats['runs']} 성공"
          + (f" (오류 {stats['errors']})" if stats['errors'] else ''))
    print(f"  스키마 준수율      : {stats['schemaValidRate']}")
    print(f"  항목 판정 일치도    : {stats['items']['meanAgreement']} "
          f"(전 실행 동일 {stats['items']['fullyStable']}/{stats['items']['count']} 항목)")
    print(f"  근거 인용 일치도    : {stats['evidence']['meanAgreement']}")
    score = stats['totalScore']
    print(f"  총점               : 평균 {score['mean']} · 표준편차 {score['sd']} · 범위 {score['range']}"
          f" ({score['min']}~{score['max']})")
    print(f"  위반 판정 동일 비율 : {stats['violations']['identicalRate']}")
    print(f"  실행시간(ms)       : p50 {stats['elapsedMs']['p50']} · p95 {stats['elapsedMs']['p95']}")
    if stats['items']['worst']:
        print('  가장 흔들린 항목:')
        for item in stats['items']['worst'][:5]:
            print(f"    - {item['itemId']}: 일치도 {item['agreement']} {item['counts']}")
    print('  판정:')
    for v in verdicts(stats):
        print(f"    [{'통과' if v['pass'] else '미달'}] {v['metric']} = {v['value']} (기준 {v['threshold']})")


# ── selftest — 산식만 오프라인 검증 (CI에서 돈다) ─────────────────────────────

def selftest() -> None:
    # 완전히 안정적인 10회
    stable_runs = [{
        'ok': True, 'elapsedMs': 1000 + i, 'schemaProblems': [], 'totalScore': 70.0,
        'items': {'a': 'met', 'b': 'not_met'}, 'evidenceCounts': {'a': 2, 'b': 0},
        'violationTypes': [],
    } for i in range(10)]
    s = stability(stable_runs)
    assert s['completionRate'] == 1.0, s['completionRate']
    assert s['schemaValidRate'] == 1.0, s['schemaValidRate']
    assert s['items']['meanAgreement'] == 1.0, s['items']['meanAgreement']
    assert s['items']['unstable'] == 0, s['items']['unstable']
    assert s['totalScore']['sd'] == 0.0, s['totalScore']['sd']
    assert s['totalScore']['range'] == 0.0
    assert s['violations']['identicalRate'] == 1.0
    assert all(v['pass'] for v in verdicts(s)), verdicts(s)
    print('  완전 안정 10회 → 일치도 1.0 · 표준편차 0 통과')

    # 항목 b 가 10회 중 3회 흔들리고 총점도 갈리는 경우
    wobbly = []
    for i in range(10):
        flip = i < 3
        wobbly.append({
            'ok': True, 'elapsedMs': 1000, 'schemaProblems': [] if i else ['missing:feedback'],
            'totalScore': 65.0 if flip else 70.0,
            'items': {'a': 'met', 'b': 'partial' if flip else 'not_met'},
            'evidenceCounts': {'a': 1, 'b': 1 if flip else 0},
            'violationTypes': ['et01'] if flip else [],
        })
    s = stability(wobbly)
    assert s['items']['meanAgreement'] == 0.85, s['items']['meanAgreement']  # (1.0 + 0.7) / 2
    assert s['items']['unstable'] == 1, s['items']['unstable']
    assert s['items']['worst'][0]['itemId'] == 'b', s['items']['worst']
    assert s['items']['worst'][0]['counts'] == {'not_met': 7, 'partial': 3}, s['items']['worst'][0]['counts']
    assert s['schemaValidRate'] == 0.9, s['schemaValidRate']
    assert s['totalScore']['range'] == 5.0, s['totalScore']['range']
    assert s['violations']['identicalRate'] == 0.7, s['violations']['identicalRate']
    assert s['evidence']['meanAgreement'] == 0.85, s['evidence']['meanAgreement']
    # 3회가 65점, 7회가 70점 → 표준편차 2.29 로 기준(2.0)도 함께 넘긴다
    assert round(s['totalScore']['sd'], 2) == 2.29, s['totalScore']['sd']
    failed = [v['metric'] for v in verdicts(s) if not v['pass']]
    assert failed == ['schemaValidRate', 'itemMeanAgreement', 'totalScoreSd'], failed
    print('  변동 10회 → 흔들린 항목 특정·표준편차·판정 미달 통과')

    # 실패한 실행은 분자에서 빠지고 오류 분포로 보고된다
    mixed = stable_runs[:6] + [{'ok': False, 'error': 'ResourceExhausted: 429', 'elapsedMs': 50} for _ in range(4)]
    s = stability(mixed)
    assert s['completed'] == 6 and s['completionRate'] == 0.6, s
    assert s['errors']['ResourceExhausted: 429'] == 4, s['errors']
    assert s['elapsedMs']['count'] == 6, '실패 실행은 실행시간 분포에서도 빠진다'
    print('  실패 실행 분리(완주율·오류 분포·지연 분포) 통과')

    # 고정 입력 파일이 실제로 로드되고 등록된 증례를 가리키는지
    fixture = load_fixture()
    case = prompt_mod.load_case(fixture['caseId'])
    assert case.get('id') == fixture['caseId'], case.get('id')
    assert len(fixture['events']) >= 20, '변동을 보려면 충분한 길이의 전사가 필요하다'
    roles = {e['role'] for e in fixture['events']}
    assert roles <= {'student', 'patient', 'system'}, roles
    assert all(isinstance(e['tOffsetMs'], int) and e['tOffsetMs'] >= 0 for e in fixture['events'])
    offsets = [e['tOffsetMs'] for e in fixture['events']]
    assert offsets == sorted(offsets), '전사 시각이 시간순이어야 채점 근거 줄 번호가 맞는다'
    print(f"  고정 입력 로드 통과 ({fixture['fixtureId']} · {len(fixture['events'])}줄 · {case['title']})")

    print('반복 생성 안정성 산식 selftest 통과')


def main() -> int:
    parser = argparse.ArgumentParser(description='CPX 채점 반복 생성 안정성 측정 (가이드 §4.2)')
    parser.add_argument('--runs', type=int, default=DEFAULT_RUNS, help=f'반복 횟수 (기본 {DEFAULT_RUNS}, 가이드 최소 10)')
    parser.add_argument('--fixture', type=Path, default=FIXTURE_PATH, help='고정 입력 JSON 경로')
    parser.add_argument('--out', type=Path, default=None, help='결과 JSON 저장 경로')
    parser.add_argument('--selftest', action='store_true', help='산식만 검증 (API 호출 없음)')
    args = parser.parse_args()

    if args.selftest:
        selftest()
        return 0

    api_key = os.environ.get('GEMINI_API_KEY', '')
    if not api_key:
        print('GEMINI_API_KEY 가 필요합니다. 산식만 확인하려면 --selftest 를 쓰세요.', file=sys.stderr)
        return 2
    if args.runs < 10:
        print(f'경고: 가이드 §4.2 는 최소 10회를 요구합니다 (지금 {args.runs}회).', file=sys.stderr)

    report = measure(args.runs, load_fixture(args.fixture), api_key)
    print_report(report)
    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'\n결과 저장: {args.out}')
    return 0 if all(v['pass'] for v in verdicts(report['stability'])) else 1


if __name__ == '__main__':
    raise SystemExit(main())
