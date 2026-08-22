"""전체 CPX 증례의 루브릭·신체진찰 카드 연결 회귀 테스트.

이 파일은 두 방향을 모두 본다.
  정방향 — 케이스가 정의한 진찰 소견은 반드시 어떤 버튼으로든 도달할 수 있어야 한다.
  역방향 — 버튼이 케이스 소견과 매칭되지 않아 하드코딩된 기본값으로 떨어지는 조합은
           아래 목록에 등록된 것뿐이어야 한다.

역방향 검사가 없던 탓에 파킨슨병 증례의 '자세·동작 떨림' 버튼이 본태떨림 기본 소견을,
자폐 증례의 청력 버튼이 "반응이 적절하다"는 기본 소견을 내보내고 있었다(2026-08-18 감사).
새 조합이 생기면 케이스에 진찰 소견을 추가할지, 기본값이 그 증례에 맞는지 반드시 확인할 것.
"""

import re

from physical_exam import (
    BUTTON_SETS, POLARITY_ABNORMAL, POLARITY_NORMAL, POLARITY_VALUES,
    button_catalog, buttons_for, resolve_exam,
)
from evaluate import COMMON_DIR, RUBRIC_BY_CATEGORY, load_rubric
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


# 진찰 소견은 표준화 환자 대본이다 — 사실만 적고 해석은 학생이 한다.
# "간·비장 비대 가능", "혈관성 잡음 청진 의심", "갑상샘항진 변형이면 비대 가능" 같은 가정형은
# ① 학생이 "그래서 있다는 건가"를 되묻게 만들고 ② 채점 근거가 되지 못하며
# ③ 변형 선택 로직이 서버에 없어 두 변형이 한 환자에게 동시에 재생된다(2026-08-18 감사).
_HEDGE_WORDS = (
    '가능', '또는', '수 있', '일 수', '의심', '여부 확인', '경우', '이면', '추정', '조합에 따라',
)
# 검사·자세를 가리키는 '~ 시'(굴곡 시·강제 호기 시)와 수치 범위('1~2 cm')는 가정형이 아니다.


def check_findings_are_determinate(cases: list[dict]) -> None:
    offenders = []
    for case in cases:
        for rule in case.get('physicalExamRule') or []:
            finding = rule.get('expectedFinding') or ''
            hit = [w for w in _HEDGE_WORDS if w in finding]
            if hit:
                offenders.append(f"{case['id']}: {rule.get('item')} — 가정형 {hit} :: {finding}")
    assert not offenders, (
        '진찰 소견에 가정형 표현이 있다. 표준화 환자 카드는 "체온 38.4", "비장 늑골하 3 cm"처럼\n'
        '확정값이어야 한다. 증례가 두 변형을 함께 담고 있으면 하나로 확정하라:\n'
        + '\n'.join(offenders)
    )


def check_polarity_is_declared(cases: list[dict]) -> None:
    """정상/비정상 배지의 근거는 polarity 뿐 — 누락되면 실제 이상이 초록으로 나간다.

    예전에는 소견 문장에서 극성을 추론했고 양방향으로 틀렸다(정상 30건+을 빨강으로,
    "소뇌 정상, 보행 불안정"을 초록으로). 추론을 폐기한 대신 여기서 누락을 막는다.
    """
    missing = []
    for case in cases:
        for rule in case.get('physicalExamRule') or []:
            pol = rule.get('polarity')
            if pol not in POLARITY_VALUES:
                missing.append(f"{case['id']}: {rule.get('item')} — polarity={pol!r}")
    assert not missing, (
        f'physicalExamRule 에 polarity({POLARITY_ABNORMAL}/{POLARITY_NORMAL})가 없다.\n'
        '소견이 정상이면 negative, 이상이면 positive 를 명시하라 — 문장에서 추론하지 않는다:\n'
        + '\n'.join(missing)
    )


def check_normal_findings_read_normal(cases: list[dict]) -> None:
    """negative 로 선언한 소견은 실제로 정상으로 읽혀야 한다 (오선언 방지)."""
    offenders = []
    for case in cases:
        for rule in case.get('physicalExamRule') or []:
            if rule.get('polarity') != POLARITY_NORMAL:
                continue
            finding = rule.get('expectedFinding') or ''
            if not any(w in finding for w in _READS_NORMAL):
                offenders.append(f"{case['id']}: {rule.get('item')} :: {finding}")
    assert not offenders, (
        'polarity=negative 인데 정상임을 알 수 있는 표현이 없다. 소견이 실제로 이상이면\n'
        'positive 로 바꾸고, 정상이면 무엇이 정상인지 문장에 남겨라:\n' + '\n'.join(offenders)
    )


# negative 로 선언했지만 절 하나가 이상 소견을 단정하는 경우를 잡는다.
# 문장 끝의 부정이 앞의 단정을 삼켜 정상으로 읽히는 게 이 결함의 전형이었다 —
# DKA 의 "전반적 경도 압통(국소 반발통 뚜렷치 않음)"이 정상 배지로 나가고 있었고,
# 급성 간염의 "피부 황달은 경미하고 … 없음"도 그랬다. 괄호와 연결어미까지 절로 쪼개서 본다.
_ABNORMAL_ASSERTIONS = (
    '압통', '종괴', '비대', '부종', '창백', '황달', '팽만', '잡음', '종대', '강직', '발적',
    '수포', '출혈', '떨림', '빈맥', '서맥', '발열', '미열', '위약', '마비', '안진', '충혈',
    '저하', '감소', '상승', '제한', '건조', '불안정',
)
_CLAUSE_NEGATIONS = ('없', '않', '음성', '아님', '미달', '이르지', '뚜렷하지', '뚜렷치')
# 진찰은 정상이고 그 어구가 '병력' 또는 '기준 미달'을 서술하는, 검토를 마친 예외.
_NORMAL_DESPITE_ASSERTION = {
    ('temporal_arteritis_rule', '눈'),               # 일과성 시력 저하는 병력 — 현재 진찰은 정상
    ('situational_syncope_rule', '체위별 혈압'),        # 15 mmHg 저하는 기립성 저혈압 기준 미달
}


def _clauses(text: str) -> list[str]:
    parts: list[str] = []
    for segment in re.split(r'[()]', text):
        parts += re.split(r'[,，]|—|\s+외\s+|고\s+|며\s+|나\s+|으나\s+|지만\s+', segment)
    return [p.strip() for p in parts if p.strip()]


def check_no_normal_badge_on_abnormal_finding(cases: list[dict]) -> None:
    offenders = []
    for case in cases:
        for rule in case.get('physicalExamRule') or []:
            if rule.get('polarity') != POLARITY_NORMAL:
                continue
            if (case['id'], rule.get('item')) in _NORMAL_DESPITE_ASSERTION:
                continue
            for clause in _clauses(rule.get('expectedFinding') or ''):
                if any(n in clause for n in _CLAUSE_NEGATIONS):
                    continue
                if any(w in clause for w in _READS_NORMAL):
                    continue
                hit = [w for w in _ABNORMAL_ASSERTIONS if w in clause]
                if hit:
                    offenders.append(
                        f"{case['id']}: {rule.get('item')} — '{clause}' {hit} 를 단정하는데 polarity=negative"
                    )
    assert not offenders, (
        'polarity=negative 인데 이상 소견을 단정하는 절이 있다. 실제로 이상이면 positive 로 바꾸고,\n'
        '병력 서술이나 기준 미달이라 정상이 맞다면 _NORMAL_DESPITE_ASSERTION 에 근거와 함께 등록하라:\n'
        + '\n'.join(offenders)
    )


# 같은 카테고리에 같은 진단이 두 번 있으면 두 증례는 같은 체크리스트로 채점되고
# 학생은 둘을 구별할 수 없다(편타손상이 그랬다 — 서사·진찰 5항목까지 사실상 같았다).
# 카테고리를 넘는 중복은 주호소가 다르므로 정당한 설계다(폐색전증이 호흡곤란과 가슴통증에
# 하나씩) — 그건 막지 않는다.
def _diagnosis_key(case: dict) -> str:
    dx = re.sub(r'\([^)]*\)', '', case.get('targetDiagnosis') or '')
    dx = dx.replace('의심', '').replace('연관', '').replace('에 의한', ' ')
    return re.sub(r'\s+', ' ', dx).strip()


def check_no_same_category_duplicate(cases: list[dict]) -> None:
    seen: dict[tuple[str, str], list[str]] = {}
    for case in cases:
        key = (case.get('category') or '', _diagnosis_key(case))
        if not key[1]:
            continue
        seen.setdefault(key, []).append(case['id'])
    dupes = [(k, v) for k, v in sorted(seen.items()) if len(v) > 1]
    assert not dupes, (
        '같은 카테고리에 같은 진단이 둘 이상이다. 같은 루브릭으로 채점되어 변별이 되지 않는다.\n'
        '증례를 임상적으로 갈라내거나 하나로 합쳐라:\n'
        + '\n'.join(f"  [{cat}] {dx} — {', '.join(ids)}" for (cat, dx), ids in dupes)
    )


# 표준화 환자는 정해진 한 사람을 연기한다. "장거리 비행/침상안정/수술 중 하나"처럼
# 결정적 사실을 열어 두면 세션마다 다른 병력이 재생되고 채점 근거도 흔들린다.
# 선택이 설계상 열려 있는 recommended 필드와, 전부 부재인 mustAbsent 는 대상이 아니다.
_OPEN_CHOICE = re.compile(r'또는|중 하나')
_FIXED_FACT_FIELDS = [
    ('scenarioRule', 'mustInclude'), ('pastHistoryRule', 'mustInclude'),
    ('socialHistoryRule', 'fixed'), ('familyHistoryRule', 'mustInclude'),
]


def check_fixed_facts_are_decided(cases: list[dict]) -> None:
    offenders = []
    for case in cases:
        for top, key in _FIXED_FACT_FIELDS:
            node = case.get(top) or {}
            values = node.get(key) if isinstance(node, dict) else None
            if not isinstance(values, list):
                continue
            for value in values:
                if isinstance(value, str) and _OPEN_CHOICE.search(value):
                    offenders.append(f"{case['id']}: {top}.{key} :: {value}")
    assert not offenders, (
        '반드시 연기해야 하는 사실이 둘 중 하나로 열려 있다. 하나를 골라 못박아라 —\n'
        '고를 수 있게 두려면 recommended 로 옮겨라(그쪽은 설계상 선택 가능이다):\n'
        + '\n'.join(offenders)
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


def check_every_category_has_a_rubric(cases: list[dict]) -> None:
    """주호소 ↔ 루브릭 등록이 정확히 맞는가 (2026-08-22 진단).

    load_rubric() 은 미등록 카테고리를 canonical_rubric.sleep.json 으로 폴백한다. 지금은
    54 카테고리 ↔ 54 루브릭이 맞아 실제 영향이 없지만, 새 주호소를 추가하면서 여기 등록을
    빠뜨리면 **오류 없이** 수면장애 루브릭으로 채점된다. 점수는 나오는데 채점 항목이 전부
    남의 것인, 가장 알아채기 어려운 실패다. 그 문을 여기서 닫는다.
    """
    used = {case.get("category", "") for case in cases}
    registered = set(RUBRIC_BY_CATEGORY)
    unregistered = sorted(used - registered)
    assert not unregistered, (
        "RUBRIC_BY_CATEGORY 에 없는 주호소가 있다 — 수면장애 루브릭으로 조용히 폴백된다.\n"
        "evaluate.py 의 RUBRIC_BY_CATEGORY 에 등록하라: " + ", ".join(unregistered)
    )
    missing_files = sorted(
        fname for fname in RUBRIC_BY_CATEGORY.values()
        if not (COMMON_DIR / fname).exists()
    )
    assert not missing_files, "등록됐지만 파일이 없는 루브릭: " + ", ".join(missing_files)
    unused = sorted(registered - used)
    print(
        f"  주호소 {len(used)}종 전부 루브릭 등록 확인 "
        f"(등록 {len(registered)}종 · 미사용 등록 {len(unused)}종)"
    )


def main() -> None:
    public_cases = list_cases()
    assert public_cases, "증례 목록이 비어 있음"

    uncovered_rules: list[str] = []
    invalid_buttons: list[str] = []
    fallbacks: dict[str, set[str]] = {}
    loaded: list[dict] = []

    for public_case in public_cases:
        case = load_case(public_case["id"])
        loaded.append(case)
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
    check_polarity_is_declared(loaded)
    check_findings_are_determinate(loaded)
    check_normal_findings_read_normal(loaded)
    check_no_normal_badge_on_abnormal_finding(loaded)
    check_no_same_category_duplicate(loaded)
    check_fixed_facts_are_decided(loaded)
    check_every_category_has_a_rubric(loaded)
    total_fallbacks = sum(len(v) for v in fallbacks.values())
    rules = [r for c in loaded for r in (c.get("physicalExamRule") or [])]
    abnormal = sum(1 for r in rules if r.get("polarity") == POLARITY_ABNORMAL)
    print(
        f"전체 {len(public_cases)}개 증례 루브릭·신체진찰 카드 연결 통과 "
        f"(기본값 폴백 {total_fallbacks}건 — 전부 등록된 조합)"
    )
    print(
        f"진찰 소견 {len(rules)}건 전부 polarity 선언 "
        f"(비정상 {abnormal} / 정상 {len(rules) - abnormal}) · 가정형 0건"
    )


if __name__ == "__main__":
    main()
