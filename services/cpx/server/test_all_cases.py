"""전체 CPX 증례의 루브릭·신체진찰 카드 연결 회귀 테스트.

이 파일은 두 방향을 모두 본다.
  정방향 — 케이스가 정의한 진찰 소견은 반드시 어떤 버튼으로든 도달할 수 있어야 한다.
  역방향 — 버튼이 케이스 소견과 매칭되지 않아 하드코딩된 기본값으로 떨어지는 조합은
           아래 목록에 등록된 것뿐이어야 한다.

역방향 검사가 없던 탓에 파킨슨병 증례의 '자세·동작 떨림' 버튼이 본태떨림 기본 소견을,
자폐 증례의 청력 버튼이 "반응이 적절하다"는 기본 소견을 내보내고 있었다(2026-08-18 감사).
새 조합이 생기면 케이스에 진찰 소견을 추가할지, 기본값이 그 증례에 맞는지 반드시 확인할 것.
"""

from physical_exam import BUTTON_SETS, button_catalog, buttons_for, resolve_exam
from evaluate import load_rubric
from prompt import list_cases, load_case

# (버튼 id) -> 기본 소견으로 떨어져도 무방하다고 확인한 증례.
# 전부 "정상·특이소견 없음" 계열이며 각 증례의 서사와 모순되지 않는다.
KNOWN_DEFAULT_FALLBACKS: dict[str, set[str]] = {
    'auscultation': {
        'narcolepsy_rule', 'ptsd_nightmare_disorder_rule',
        'rem_sleep_behavior_disorder_rule', 'sleepwalking_somnambulism_rule',
    },
    'bp': {
        'alcohol_related_sleep_disorder_rule', 'bph_nocturia_sleep_disorder_rule',
        'chronic_primary_insomnia_rule', 'circadian_rhythm_shift_work_rule',
        'depression_related_sleep_disorder_rule', 'medication_induced_sleep_disorder_rule',
        'menopause_related_sleep_disorder_rule', 'periodic_limb_movement_disorder_rule',
        'physical_disease_gerd_hyperthyroid_sleep_disorder_rule', 'rem_sleep_behavior_disorder_rule',
        'restless_legs_syndrome_rule', 'sleepwalking_somnambulism_rule', 'transient_insomnia_rule',
    },
    'dre': {'mallory_weiss_rule'},
    'eye': {'tension_headache_rule', 'thunderclap_sah_rule'},
    'head_palpation': {'migraine_rule', 'thunderclap_sah_rule'},
    'neuro': {
        'alcohol_related_sleep_disorder_rule', 'bph_nocturia_sleep_disorder_rule',
        'chronic_primary_insomnia_rule', 'circadian_rhythm_shift_work_rule',
        'depression_related_sleep_disorder_rule', 'medication_induced_sleep_disorder_rule',
        'menopause_related_sleep_disorder_rule', 'obstructive_sleep_apnea_rule',
        'physical_disease_gerd_hyperthyroid_sleep_disorder_rule', 'transient_insomnia_rule',
    },
    'oral': {
        'alcohol_related_sleep_disorder_rule', 'bph_nocturia_sleep_disorder_rule',
        'chronic_primary_insomnia_rule', 'circadian_rhythm_shift_work_rule',
        'depression_related_sleep_disorder_rule', 'medication_induced_sleep_disorder_rule',
        'menopause_related_sleep_disorder_rule', 'periodic_limb_movement_disorder_rule',
        'ptsd_nightmare_disorder_rule', 'rem_sleep_behavior_disorder_rule',
        'restless_legs_syndrome_rule',
    },
    'oral_nasal': {'peptic_ulcer_bleed_rule', 'variceal_bleed_rule'},
    'palpation': {'narcolepsy_rule', 'ptsd_nightmare_disorder_rule'},
    'psg': {
        'alcohol_related_sleep_disorder_rule', 'bph_nocturia_sleep_disorder_rule',
        'chronic_primary_insomnia_rule', 'circadian_rhythm_shift_work_rule',
        'depression_related_sleep_disorder_rule', 'medication_induced_sleep_disorder_rule',
        'menopause_related_sleep_disorder_rule', 'narcolepsy_rule', 'obstructive_sleep_apnea_rule',
        'periodic_limb_movement_disorder_rule',
        'physical_disease_gerd_hyperthyroid_sleep_disorder_rule', 'ptsd_nightmare_disorder_rule',
        'rem_sleep_behavior_disorder_rule', 'restless_legs_syndrome_rule',
        'sleepwalking_somnambulism_rule', 'transient_insomnia_rule',
    },
    'pulse': {'narcolepsy_rule', 'rem_sleep_behavior_disorder_rule', 'sleepwalking_somnambulism_rule'},
}

# 기본 소견은 케이스가 그 진찰을 정의하지 않았을 때만 나가고 화면에는 abnormal=False 로,
# 즉 '정상'으로 표시된다. 따라서 특정 진단의 양성 소견을 문장으로 박아두면 있지도 않은 소견을
# 정상 배지로 보여주게 된다(유방 덩이·세균성 질증 분비물·폭력 손상·흡연 CO 등이 그랬다).
# 표준화 환자 관례대로 "정의되지 않았으면 정상"이어야 하므로 두 가지를 함께 본다.
_ASSERTS_FINDING = ('촉지', '관찰됩니다', '상승해', '보이며', '적습니다', '흔들립니다', '있으나', '찰과상')
_READS_NORMAL = ('없', '않', '정상', '깨끗', '음성', '양호', '안정', '적절', '범위', '부합', '협조',
                 '대칭', '명료', '규칙적', '기대되는')
# 소견이 아니라 절차를 안내하는 카드 (검사 일정 안내)
_PROCEDURAL_DEFAULTS = {
    '수면다원검사는 병원에서 하룻밤 입원해 진행합니다. 일정을 조율해 안내해 드리겠습니다.',
}


def check_default_findings_are_neutral() -> None:
    offenders = []
    for category, buttons in BUTTON_SETS.items():
        for button in buttons:
            default = button['defaultFinding']
            if default in _PROCEDURAL_DEFAULTS:
                continue
            hit = [w for w in _ASSERTS_FINDING if w in default]
            if hit:
                offenders.append(f"[{category}] {button['id']}: 양성 소견 단정 {hit} — {default}")
            elif not any(w in default for w in _READS_NORMAL):
                offenders.append(f"[{category}] {button['id']}: 정상임을 알 수 없는 문구 — {default}")
    assert not offenders, (
        '기본 진찰 소견이 중립·정상이 아니다. 그 소견이 필요한 증례라면 케이스의 physicalExamRule 에\n'
        '정의하고, 기본값은 "정의되지 않았으면 정상"으로 두라:\n' + '\n'.join(offenders)
    )


def check_no_new_default_fallbacks(fallbacks: dict[str, set[str]]) -> None:
    unexpected = []
    for button_id, cases in sorted(fallbacks.items()):
        new = cases - KNOWN_DEFAULT_FALLBACKS.get(button_id, set())
        for case_id in sorted(new):
            unexpected.append(f'  {case_id} : 버튼 {button_id}')
    assert not unexpected, (
        '진찰 버튼이 케이스 소견과 매칭되지 않아 기본값으로 떨어진다.\n'
        '케이스에 해당 진찰 소견을 추가하거나, 기본값이 그 증례에 맞는지 확인한 뒤\n'
        'KNOWN_DEFAULT_FALLBACKS 에 등록하라:\n' + '\n'.join(unexpected)
    )


def main() -> None:
    public_cases = list_cases()
    assert public_cases, "증례 목록이 비어 있음"

    uncovered_rules: list[str] = []
    invalid_buttons: list[str] = []
    fallbacks: dict[str, set[str]] = {}

    for public_case in public_cases:
        case = load_case(public_case["id"])
        rubric = load_rubric(case)
        assert rubric.get("totalScore") == 100, f"{case['id']}: 루브릭 총점 오류"

        buttons = buttons_for(case)
        catalog = button_catalog(case)
        assert buttons and len(buttons) == len(catalog), f"{case['id']}: 진찰 버튼 없음/목록 불일치"

        covered: set[tuple[str, str]] = set()
        for button in buttons:
            result = resolve_exam(case, button["id"])
            findings = result.get("findings") or []
            if not findings or any(not finding.get("finding") for finding in findings):
                invalid_buttons.append(f"{case['id']}:{button['id']}")
            # 케이스 소견과 하나도 매칭되지 않으면 resolve_exam 이 버튼 기본값 카드를 돌려준다
            first = findings[0] if findings else {}
            if first.get("method") == "" and first.get("item") == button["label"]:
                fallbacks.setdefault(button["id"], set()).add(case["id"])
            for finding in findings:
                if finding.get("method"):
                    covered.add((finding["item"], finding["method"]))

        for rule in case.get("physicalExamRule") or []:
            key = (rule["item"], rule["method"])
            if key not in covered:
                uncovered_rules.append(f"{case['id']}: {rule['item']} / {rule['method']}")

    assert not invalid_buttons, "소견이 비어 있는 진찰 버튼:\n" + "\n".join(invalid_buttons)
    assert not uncovered_rules, "버튼에서 접근할 수 없는 신체진찰:\n" + "\n".join(uncovered_rules)
    check_no_new_default_fallbacks(fallbacks)
    check_default_findings_are_neutral()
    total_fallbacks = sum(len(v) for v in fallbacks.values())
    print(
        f"전체 {len(public_cases)}개 증례 루브릭·신체진찰 카드 연결 통과 "
        f"(기본값 폴백 {total_fallbacks}건 — 전부 등록된 조합)"
    )


if __name__ == "__main__":
    main()
