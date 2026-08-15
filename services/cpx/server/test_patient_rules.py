"""환자 프롬프트 행동 규칙 회귀 검사 — 언어·대화 맥락·자기 발화 해설 금지.

2026-08-15 운영 실측에서 세 가지가 한꺼번에 드러났다.
  ① 영어 질문에 정상 응답하고 스페인어를 알아보기까지 했다 (한국어 단일어 화자여야 한다)
  ② 주호소 문진 중 튀어나온 뜬금없는 질문에 위화감 없이 1문 1답했다
  ③ 대사 뒤에 "비의료적 질문에 대한 답변입니다" 해설 라벨이 붙었다

블록이 통째로 사라지거나 케이스별로 누락되는 회귀를 막는다. 새니타이저(방어층)는
scripts/test-cpx-sanitize.mjs가 따로 본다 — 여기서는 근본 대응인 시스템 프롬프트만 본다.
"""

import prompt

# 블록 제목과, 그 블록이 반드시 담아야 하는 핵심 지시.
REQUIRED_BLOCKS = {
    '[언어 — 한국어만 아는 환자]': [
        '한국어 단일어 화자',
        '언어 이름을 절대 입에 담지',
        '문장 전체가 외국어일 때만',
        '외국어 문장으로 답하지 않는다',
    ],
    '[대화 맥락 — 흐름에서 벗어난 질문에 대한 반응]': [
        '먼저 어긋난 티를 낸다',
        '정보성 답변을 아예 하지 않는다',
        '자연스러운 화제 전환',
    ],
    '[자기 발화 해설 금지 — 라벨·분류·안내 문구]': [
        '비의료적 질문에 대한 답변입니다',
        '라벨·분류·메타 설명·규칙 언급은 한 조각도 없다',
    ],
}


def run():
    checked = 0
    for meta in prompt.list_cases():
        instruction = prompt.build_system_instruction(meta['id'])
        for title, phrases in REQUIRED_BLOCKS.items():
            assert title in instruction, f'{meta["id"]}: {title} 블록 누락'
            for phrase in phrases:
                assert phrase in instruction, f'{meta["id"]}: {title} 안의 "{phrase}" 누락'
        # 순응도 낮은 환자 블록은 이 규칙들보다 뒤에 붙는다 — 행동 지침이 역할 방어를
        # 덮어쓰지 않도록 순서를 고정한다.
        assert instruction.index('[언어 — 한국어만 아는 환자]') > instruction.index('[ruleContext]'), meta['id']
        checked += 1

    # 페르소나가 붙은 실제 세션 형태에서도 블록이 유지되는지 한 케이스로 확인한다.
    sample = prompt.list_cases()[0]['id']
    case = prompt.load_case(sample)
    persona = prompt.resolve_persona(case, 'seed-lang-regression')
    with_persona = prompt.build_system_instruction(sample, persona)
    for title in REQUIRED_BLOCKS:
        assert title in with_persona, f'{sample}(persona): {title} 블록 누락'

    print(f'환자 행동 규칙(언어·맥락·해설 금지) {checked}개 증례 통과')


if __name__ == '__main__':
    run()
