"""전체 CPX 증례의 루브릭·신체진찰 카드 연결 회귀 테스트."""

from evaluate import load_rubric
from physical_exam import button_catalog, buttons_for, resolve_exam
from prompt import list_cases, load_case


def main() -> None:
    public_cases = list_cases()
    assert public_cases, "증례 목록이 비어 있음"

    uncovered_rules: list[str] = []
    invalid_buttons: list[str] = []

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
            for finding in findings:
                if finding.get("method"):
                    covered.add((finding["item"], finding["method"]))

        for rule in case.get("physicalExamRule") or []:
            key = (rule["item"], rule["method"])
            if key not in covered:
                uncovered_rules.append(f"{case['id']}: {rule['item']} / {rule['method']}")

    assert not invalid_buttons, "소견이 비어 있는 진찰 버튼:\n" + "\n".join(invalid_buttons)
    assert not uncovered_rules, "버튼에서 접근할 수 없는 신체진찰:\n" + "\n".join(uncovered_rules)
    print(f"전체 {len(public_cases)}개 증례 루브릭·신체진찰 카드 연결 통과")


if __name__ == "__main__":
    main()
