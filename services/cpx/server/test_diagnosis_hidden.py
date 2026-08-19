"""환자 모델 컨텍스트에 증례 메타데이터가 들어가지 않는가 (2026-08-18 감사 가1).

`targetDiagnosis` 하나만 제외해서는 진단명이 가려지지 않았다. 216/243 증례의 title 이
'급성 복통 (충수염 의심)' 꼴이고 tags 207건·description 60건·variant 55건에도 병명이
들어 있어, 환자 모델은 사실상 자기 병명을 알고 연기했다.

여기서 막는 것은 **작성자용 메타데이터**다. 환자가 실제로 아는 사실(가족력의 '삼촌이 대장암',
본인의 '진정제 복용력', 산전 증례의 '임신 24주')은 서사에 남아 있어야 하며 유출이 아니다.
"""
from __future__ import annotations

import re

from prompt import build_system_instruction, list_cases, load_case, public_case, resolve_persona

# 모델 컨텍스트에서 통째로 빠져야 하는 필드
HIDDEN_FIELDS = ('title', 'variant', 'description', 'tags')


def _values(case: dict, field: str) -> list[str]:
    v = case.get(field)
    if isinstance(v, list):
        return [str(x) for x in v if str(x).strip()]
    return [str(v)] if v and str(v).strip() else []


def test_metadata_never_reaches_the_patient_model() -> None:
    """ruleContext 는 JSON 으로 직렬화되므로 필드가 남아 있으면 키가 그대로 보인다.

    값(태그 '의식장애' 등)으로 검사하면 서사에 정상적으로 등장하는 같은 낱말과 구별되지 않는다 —
    키로 검사해야 '메타데이터가 실렸는가'를 정확히 가른다.
    """
    offenders = []
    checked = 0
    for meta in list_cases():
        case = load_case(meta['id'])
        instruction = build_system_instruction(case['id'], resolve_persona(case, 'leak-check'))
        checked += 1
        for field in HIDDEN_FIELDS:
            if f'"{field}":' in instruction:
                offenders.append(f"{case['id']}: ruleContext 에 {field} 필드가 실렸다")
        # 제목 전체 문자열('급성 복통 (충수염 의심)')은 충분히 특이해 오탐 없이 검사할 수 있다
        title = (case.get('title') or '').strip()
        if len(title) >= 6 and title in instruction:
            offenders.append(f"{case['id']}: 제목 «{title}» 이 프롬프트에 남아 있다")
    assert not offenders, (
        '증례 메타데이터가 환자 모델 프롬프트에 들어갔다. 제목·태그에는 진단명이 들어 있어\n'
        '모델이 자기 병명을 알게 된다. prompt.py 의 private_keys 를 확인하라:\n'
        + '\n'.join(offenders[:20])
    )
    print(f'  메타데이터 비노출 통과 ({checked}개 증례 × {len(HIDDEN_FIELDS)}개 필드 + 제목)')


def test_target_diagnosis_never_reaches_the_patient_model() -> None:
    """진단명 문자열 자체는 어떤 형태로도 프롬프트에 있으면 안 된다."""
    offenders = []
    for meta in list_cases():
        case = load_case(meta['id'])
        dx = (case.get('targetDiagnosis') or '').strip()
        if len(dx) < 4:
            continue
        instruction = build_system_instruction(case['id'], resolve_persona(case, 'leak-check'))
        korean = re.sub(r'\([^)]*\)', '', dx).strip()
        for candidate in {dx, korean}:
            if len(candidate) >= 4 and candidate in instruction:
                offenders.append(f"{case['id']}: «{candidate}»")
    assert not offenders, '진단명이 환자 프롬프트에 그대로 있다:\n' + '\n'.join(offenders[:20])
    print('  진단명 문자열 비노출 통과')


def test_selection_metadata_is_preserved() -> None:
    """감춘 것은 모델 컨텍스트이지 증례 목록이 아니다 — 선택 화면은 그대로 동작해야 한다."""
    case = load_case('acute_appendicitis_rule')
    pub = public_case(case)
    for key in ('title', 'category', 'variant', 'description', 'tags'):
        assert key in pub, f'선택 화면에 필요한 {key} 가 사라졌다'
    print('  증례 목록 메타데이터 유지 통과')


if __name__ == '__main__':
    test_metadata_never_reaches_the_patient_model()
    test_target_diagnosis_never_reaches_the_patient_model()
    test_selection_metadata_is_preserved()
    print('진단명 비노출 회귀 테스트 통과')
