"""임상예의 위반(et01~et03) 계약이 세 겹 모두 같은 방향을 보는가 (2026-08-22 진단).

2026-08-13 배점 정합화로 루브릭 54개에서 deduction 섹션이 전부 사라졌는데, 추출 프롬프트의
판정 규칙과 응답 스키마는 violations 를 계속 요구하고 있었다. 정의를 받지 못한 라벨로
위반을 보고하라는 지시였고, 그렇게 나온 값은 scoring.py 의 죽은 감점 분기를 지나
build_feedback() 의 violationNotes 로 학생 화면까지 갔다 — 근거 없는 지적이 섞이는 경로다.

여기서 고정하는 것은 "셋이 함께 켜지고 함께 꺼진다"는 불변식이다.
루브릭에 violationTypes 를 복원하면 세 겹이 자동으로 되살아나야 하고, 없으면 셋 다 꺼져야 한다.
"""
from __future__ import annotations

import copy
import pathlib
import re

from evaluate import (
    build_context, build_extraction_prompt, build_feedback, has_violation_types,
    load_rubric, response_schema,
)
from prompt import list_cases, load_case
from scoring import score_session

VIOLATION_SECTION = {
    'id': 'clinical_etiquette',
    'name': '임상예의',
    'type': 'deduction',
    'weightPercent': 10,
    'baseScore': 10,
    'floor': 0,
    'deductionPerViolation': 2,
    'gradeCutoffs': {'excellentMaxViolations': 0, 'fairMaxViolations': 1},
    'violationTypes': [
        {'id': 'et01', 'text': '환자에게 무례하거나 비하하는 표현을 썼다'},
        {'id': 'et02', 'text': '환자의 사생활을 필요 없이 캐물었다'},
        {'id': 'et03', 'text': '환자의 말을 반복해서 가로막았다'},
    ],
}


def _sample_rubric() -> tuple[dict, dict]:
    case = load_case('chronic_primary_insomnia_rule')
    return load_rubric(case), build_context(case)


def test_no_violation_types_means_no_violation_contract() -> None:
    """지금 상태 — 루브릭에 위반 정의가 없으므로 지시도 스키마도 나가지 않아야 한다."""
    offenders = []
    for meta in list_cases():
        case = load_case(meta['id'])
        rubric = load_rubric(case)
        context = build_context(case)
        if has_violation_types(rubric, context):
            continue  # 정의가 있는 루브릭은 아래 역방향 테스트가 본다
        text = build_extraction_prompt(rubric, [], context, case)
        for label in ('et01', 'et02', 'et03', '임상예의 위반 탐지'):
            if label in text:
                offenders.append(f"{case['id']}: 정의 없는 «{label}» 이 추출 프롬프트에 있다")
        schema = response_schema(rubric, context)
        if 'violations' in schema['properties'] or 'violations' in schema['required']:
            offenders.append(f"{case['id']}: 정의 없는 violations 를 응답 스키마가 요구한다")
    assert not offenders, (
        '정의하지 않은 위반 라벨을 모델에게 요구하고 있다.\n'
        'evaluate.py 의 has_violation_types 로 세 겹을 함께 묶어라:\n'
        + '\n'.join(offenders[:20])
    )
    print(f'  정의 없는 위반 요구 0건 ({len(list_cases())}개 증례)')


def test_restoring_violation_types_revives_all_three_layers() -> None:
    """역방향 — 루브릭에 violationTypes 를 되살리면 지시·스키마가 함께 돌아와야 한다.

    이 검사가 없으면 위 테스트를 "violations 를 통째로 삭제"해서도 통과시킬 수 있고,
    그러면 위반 탐지를 복원할 길이 조용히 막힌다.
    """
    rubric, context = _sample_rubric()
    revived = copy.deepcopy(rubric)
    revived['sections'] = [*revived['sections'], copy.deepcopy(VIOLATION_SECTION)]

    assert has_violation_types(revived, context), '정의를 넣었는데도 위반 계약이 켜지지 않는다'
    text = build_extraction_prompt(revived, [], context, load_case('chronic_primary_insomnia_rule'))
    for label in ('et01', 'et02', 'et03'):
        assert label in text, f'복원된 위반 유형 {label} 이 추출 프롬프트에 없다'
    assert '임상예의 위반 탐지' in text, '위반 탐지 판정 규칙이 살아나지 않았다'
    schema = response_schema(revived, context)
    assert 'violations' in schema['properties'], '응답 스키마에 violations 가 없다'
    assert 'violations' in schema['required'], 'violations 가 required 에 없다'
    print('  위반 정의 복원 시 판정 규칙·응답 스키마 동시 부활 통과')


def test_judgment_rules_are_numbered_without_gaps() -> None:
    """규칙 6번을 빼면서 번호가 어긋나면 뒤 규칙을 가리키는 문구가 틀린 곳을 짚게 된다."""
    rubric, context = _sample_rubric()
    body = build_extraction_prompt(rubric, [], context, None)
    block = body.split('[판정 규칙]\n', 1)[1].split('\n\n[진료 단계', 1)[0]
    numbers = [int(line.split('.', 1)[0]) for line in block.splitlines() if line[:1].isdigit()]
    assert numbers == list(range(1, len(numbers) + 1)), f'판정 규칙 번호가 연속이 아니다: {numbers}'
    assert any('evidence=[]' in line for line in block.splitlines()), '근거 규칙이 사라졌다'
    # 규칙 번호는 위반 계약이 켜지고 꺼지면서 밀린다. 코드 주석이 번호로 규칙을 가리키면
    # 그 참조가 조용히 틀어지므로, 소스에 "판정 규칙 <숫자>" 형태의 참조가 없어야 한다.
    here = pathlib.Path(__file__).parent
    stale = [
        f'{path.name}:{n}: {line.strip()}'
        for path in sorted(here.glob('*.py')) if path.name != pathlib.Path(__file__).name
        for n, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1)
        if re.search(r'판정 규칙 \d', line)
    ]
    assert not stale, '번호로 판정 규칙을 가리키는 참조가 있다 (번호는 가변이다):\n' + '\n'.join(stale)
    print(f'  판정 규칙 {len(numbers)}개 연속 번호 · 번호 참조 0건 통과')


def test_no_violations_means_no_violation_notes() -> None:
    """학생 화면 끝단 — 위반이 없으면 violationNotes 는 비어 있어야 한다."""
    rubric, context = _sample_rubric()
    judgments = {'items': {}, 'violations': []}
    result = score_session(rubric, judgments, context)
    feedback = build_feedback(rubric, result)
    assert feedback['violationNotes'] == [], f'근거 없는 지적이 나간다: {feedback["violationNotes"]}'
    print('  violationNotes 비어 있음 통과')


if __name__ == '__main__':
    test_no_violation_types_means_no_violation_contract()
    test_restoring_violation_types_revives_all_three_layers()
    test_judgment_rules_are_numbered_without_gaps()
    test_no_violations_means_no_violation_notes()
    print('임상예의 위반 계약 회귀 테스트 통과')
