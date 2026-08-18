"""점수 산식 (§4.8 이중 표기) — 결정론적 순수 함수. LLM은 여기 개입하지 않는다 (§4.7).

입력:
  rubric    — canonical_rubric.sleep.json 로드 결과
  judgments — LLM 근거 추출 결과 {'items': {itemId: {'satisfied': bool, ...}},
              'violations': [{'type': 'et01'|'et02'|'et03', 'exempt': bool, ...}]}
  context   — {'depressionRelated': bool} (환자교육 조건부 분기, §4.4-5)

출력: {'totalScore', 'sections': [영역별 부분점수+등급], ...} — 동일 입력이면 항상 동일 출력.
"""
from __future__ import annotations

GRADE_LABELS = {2: '우수', 1: '보통', 0: '미흡'}


def round1(x: float) -> float:
    """소수 1자리 half-up 반올림 — 파이썬 기본(은행가 반올림)의 26.25→26.2 대신 26.3."""
    import math
    return math.floor(x * 10 + 0.5) / 10


def applicable_items(section: dict, context: dict) -> list[dict]:
    """조건부 항목(§4.4-5) 반영한 평가 대상 항목 목록."""
    out = []
    for item in section['items']:
        cond = item.get('conditional')
        if cond and not context.get(cond['flag'], False):
            continue
        out.append(item)
    return out


def _grade_checklist(section: dict, satisfied: float, applicable_count: int, context: dict) -> int:
    """원 루브릭 0/1/2 컷오프 — 등급 표시용."""
    cutoffs = section['gradeCutoffs']
    cond = section.get('conditionalGradeCutoffs')
    if cond and not context.get('depressionRelated', False):
        excellent, fair_min = cond['excellent'], cond['fairMin']
    else:
        excellent, fair_min = cutoffs['excellent'], cutoffs['fairMin']
    if satisfied >= excellent:
        return 2
    if satisfied >= fair_min:
        return 1
    return 0


def item_credit(judgment: dict) -> float:
    """채점 근거의 3상태를 내부 점수로 환산한다.

    이전 형식의 satisfied 불리언만 전달된 세션도 재채점할 수 있도록 호환성을 유지한다.
    """
    status = judgment.get('status')
    if status == 'met':
        return 1.0
    if status == 'partial':
        return 0.5
    if status == 'not_met':
        return 0.0
    return 1.0 if judgment.get('satisfied') else 0.0


# 게이트가 제한하는 등급에 대응하는 총점 상한. 등급만 낮추고 총점을 그대로 두면
# "92점 / 미흡" 같은 결과가 나와 무엇이 잘못됐는지 전달되지 않는다(2026-08-18 감사).
GRADE_TOTAL_CAP = {0: 49.0, 1: 79.0}


def applicable_item_ids(rubric: dict, context: dict) -> set[str]:
    """이 세션에서 실제로 채점되는 항목 id — 조건부·영역 제외로 빠진 항목은 뺀다."""
    out: set[str] = set()
    for section in rubric['sections']:
        if section['type'] == 'deduction':
            continue
        if section['id'] == 'physical_exam' and context.get('physicalExamRequired', True) is False:
            continue
        for item in applicable_items(section, context):
            out.add(item['id'])
    return out


def evaluate_safety_gates(rubric: dict, context: dict, judgments: dict) -> list[dict]:
    """케이스별 적신호 게이트 — 핵심 안전행동이 빠지면 총점과 등급을 함께 제한한다.

    부분 수행(partial)은 충족으로 보지 않는다. 안전 행동은 "했다/안 했다"로 갈리고,
    절반만 한 것을 통과시키면 게이트의 뜻이 없어진다.
    조건부로 채점 대상에서 빠진 항목(예: 남성 환자의 임신 가능성 확인)은 요구에서 제외한다 —
    빼지 않으면 플래그가 꺼진 세션이 영구히 게이트에 걸린다.
    """
    case_id = context.get('caseId')
    scored_ids = applicable_item_ids(rubric, context)
    triggered = []
    for gate in rubric.get('safetyGates', []):
        if case_id not in gate.get('caseIds', []):
            continue
        required = [i for i in gate.get('requiredItemIds', []) if i in scored_ids]
        missing = [i for i in required if item_credit(judgments.get(i, {})) < 1.0]
        if not missing:
            continue
        max_grade = gate.get('maxOverallGrade', 0)
        triggered.append({
            'id': gate.get('id', 'safety_gate'),
            'message': gate.get('message', '핵심 안전 항목이 누락되었습니다.'),
            'missingItemIds': missing,
            'requiredItemIds': required,
            'maxOverallGrade': max_grade,
            'maxTotalScore': gate.get('maxTotalScore', GRADE_TOTAL_CAP.get(max_grade)),
        })
    return triggered


def score_session(rubric: dict, judgments: dict, context: dict) -> dict:
    item_judgments = judgments.get('items', {})
    violations = [v for v in judgments.get('violations', []) if not v.get('exempt')]

    sections_out = []
    excluded_sections = []
    total = 0.0
    for section in rubric['sections']:
        weight = section['weightPercent']
        # 신체진찰 면제 케이스(physicalExamRequired=false): 진찰 영역을 채점에서 제외하고
        # 나머지 영역 합계를 100점 만점으로 재정규화한다 — 진찰을 안 해도 감점되지 않는다.
        if section['id'] == 'physical_exam' and context.get('physicalExamRequired', True) is False:
            excluded_sections.append({
                'id': section['id'], 'name': section['name'], 'weightPercent': weight,
                'reason': '이 시나리오는 신체진찰이 필요하지 않아 채점에서 제외되었습니다.',
            })
            continue
        if section['type'] == 'deduction':
            # 임상예의: 감점제 (기본 10점, 위반당 -2, 하한 0) — §4.8-2
            raw = max(section['floor'], section['baseScore'] - section['deductionPerViolation'] * len(violations))
            score = raw * weight / section['baseScore']
            gc = section['gradeCutoffs']
            n = len(violations)
            grade = 2 if n <= gc['excellentMaxViolations'] else (1 if n <= gc['fairMaxViolations'] else 0)
            sections_out.append({
                'id': section['id'], 'name': section['name'], 'weightPercent': weight,
                'score': round1(score), 'violationCount': n,
                'grade': grade, 'gradeLabel': GRADE_LABELS[grade],
            })
        else:
            # checklist / passfail: 부분점수 = 충족 수 / 해당 분모 × 가중치 — §4.8-1, §4.8-3
            items = applicable_items(section, context)
            credits = {item['id']: item_credit(item_judgments.get(item['id'], {})) for item in items}
            satisfied_ids = [item_id for item_id, credit in credits.items() if credit == 1.0]
            partial_ids = [item_id for item_id, credit in credits.items() if credit == 0.5]
            missed_ids = [item_id for item_id, credit in credits.items() if credit == 0.0]
            earned_units = sum(credits.values())
            score = (earned_units / len(items)) * weight if items else 0.0
            grade = _grade_checklist(section, earned_units, len(items), context)
            sections_out.append({
                'id': section['id'], 'name': section['name'], 'weightPercent': weight,
                'score': round1(score), 'satisfiedCount': len(satisfied_ids),
                'partialCount': len(partial_ids), 'earnedItemUnits': earned_units,
                'applicableCount': len(items),
                'satisfiedIds': satisfied_ids,
                'partialIds': partial_ids,
                'missedIds': missed_ids,
                'grade': grade, 'gradeLabel': GRADE_LABELS[grade],
            })
        total += score

    # 제외 영역이 있으면 남은 가중치 합을 100으로 환산 (예: 진찰 15 제외 → ×100/85)
    excluded_weight = sum(s['weightPercent'] for s in excluded_sections)
    if excluded_weight and excluded_weight < 100:
        total = total * 100.0 / (100.0 - excluded_weight)

    total = round1(total)
    raw_total = total
    safety_gates = evaluate_safety_gates(rubric, context, item_judgments)
    caps = [g['maxTotalScore'] for g in safety_gates if g.get('maxTotalScore') is not None]
    if caps:
        total = min(total, round1(min(caps)))
    overall_grade = 2 if total >= 80 else (1 if total >= 50 else 0)  # 파생 규칙 (원문에 총점 등급 없음)
    if safety_gates:
        overall_grade = min(overall_grade, min(gate['maxOverallGrade'] for gate in safety_gates))
    result = {
        'totalScore': total,
        'overallGradeLabel': GRADE_LABELS[overall_grade],
        'sections': sections_out,
        'violations': violations,
        'context': context,
        'safetyGate': {'triggered': safety_gates, 'passed': not safety_gates},
    }
    if total != raw_total:
        # 게이트로 깎이기 전 점수 — "체크리스트는 채웠지만 안전 행동을 놓쳤다"를 보여준다
        result['rawTotalScore'] = raw_total
    if excluded_sections:
        result['excludedSections'] = excluded_sections
    return result
