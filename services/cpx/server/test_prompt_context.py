"""환자 모델에 전달되는 컨텍스트의 비공개 필드 회귀 검사."""

import json

import prompt


def run():
    checked = 0
    for meta in prompt.list_cases():
        case = prompt.load_case(meta['id'])
        instruction = prompt.build_system_instruction(case['id'])
        context = instruction.split('[ruleContext]\n', 1)[1].split('\n\n우선순위:', 1)[0]
        rule_context = json.loads(context)
        assert 'targetDiagnosis' not in rule_context, case['id']
        assert 'physicalExamRule' not in rule_context, case['id']
        assert 'evaluationUse' not in rule_context, case['id']
        assert 'sourceTextFile' not in rule_context, case['id']
        assert 'patientContextFocus' not in rule_context.get('liveApiContext', {}), case['id']
        checked += 1
    print(f'환자 프롬프트 비공개 컨텍스트 {checked}개 증례 통과')


if __name__ == '__main__':
    run()
