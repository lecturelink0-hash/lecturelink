"""LLM 근거 추출 (§4.9) — LLM은 항목별 충족 여부+근거 인용만, 점수는 scoring.py가 계산 (§4.7).

034 evaluationOutputContract 계승: llmRole=extract_evidence_only, ruleEngineRole=calculate_score.
"""
import json
import os
from pathlib import Path

COMMON_DIR = Path(__file__).resolve().parent.parent / 'data' / 'cpx' / 'common'
EVAL_MODEL = os.environ.get('GEMINI_EVAL_MODEL', 'gemini-2.5-flash')

# 케이스 category → 정본 루브릭 파일. 새 도메인 추가 시 여기에 등록.
RUBRIC_BY_CATEGORY = {
    '수면장애': 'canonical_rubric.sleep.json',
    '두통': 'canonical_rubric.headache.json',
    '어지럼': 'canonical_rubric.dizziness.json',
    '피로': 'canonical_rubric.fatigue.json',
    '소화불량/만성복통': 'canonical_rubric.dyspepsia.json',
    '실신': 'canonical_rubric.syncope.json',
    '두근거림': 'canonical_rubric.palpitation.json',
    '기억력 저하': 'canonical_rubric.memory_loss.json',
    '허리 통증': 'canonical_rubric.back_pain.json',
    '발열': 'canonical_rubric.fever.json',
    '체중 감소': 'canonical_rubric.weight_loss.json',
    '기침': 'canonical_rubric.cough.json',
    '관절 통증': 'canonical_rubric.joint_pain.json',
    '변비': 'canonical_rubric.constipation.json',
    '설사': 'canonical_rubric.diarrhea.json',
    '콧물/코막힘': 'canonical_rubric.rhinorrhea.json',
    '목 통증': 'canonical_rubric.neck_pain.json',
    '배뇨 이상': 'canonical_rubric.urinary_symptom.json',
    '붉은색 소변': 'canonical_rubric.red_urine.json',
    '불안': 'canonical_rubric.anxiety.json',
    '음주 문제': 'canonical_rubric.alcohol.json',
    '기분 변화': 'canonical_rubric.mood.json',
    '자살': 'canonical_rubric.suicide_risk.json',
    '가슴 통증': 'canonical_rubric.chest_pain.json',
    '호흡곤란': 'canonical_rubric.dyspnea.json',
    '고혈압': 'canonical_rubric.hypertension.json',
    '급성 복통': 'canonical_rubric.acute_abdomen.json',
    '토혈': 'canonical_rubric.hematemesis.json',
    '혈변': 'canonical_rubric.hematochezia.json',
    '구토': 'canonical_rubric.vomiting.json',
    '황달': 'canonical_rubric.jaundice.json',
    '이상지질혈증': 'canonical_rubric.dyslipidemia.json',
    '객혈': 'canonical_rubric.hemoptysis.json',
    '다뇨': 'canonical_rubric.polyuria.json',
    '핍뇨': 'canonical_rubric.oliguria.json',
    '요실금': 'canonical_rubric.incontinence.json',
    '쉽게 멍이 듦': 'canonical_rubric.easy_bruising.json',
    '체중 증가': 'canonical_rubric.weight_gain.json',
    '피부 발진': 'canonical_rubric.skin_rash.json',
    '경련': 'canonical_rubric.convulsion.json',
    '팔다리 근력 약화 및 감각 이상': 'canonical_rubric.weakness_paresthesia.json',
    '의식장애': 'canonical_rubric.clouded_consciousness.json',
    '손떨림': 'canonical_rubric.hand_tremor.json',
    '유방통/유방덩이': 'canonical_rubric.breast_pain_mass.json',
    '질 분비물': 'canonical_rubric.vaginal_discharge.json',
    '월경 이상/월경통': 'canonical_rubric.menstrual_disorder.json',
    '산전 진찰': 'canonical_rubric.antenatal_care.json',
    '발달 지연': 'canonical_rubric.developmental_delay.json',
    '물질 오남용': 'canonical_rubric.substance_misuse.json',
    '가정폭력': 'canonical_rubric.domestic_violence.json',
    '성폭력': 'canonical_rubric.sexual_violence.json',
    '나쁜소식 전하기': 'canonical_rubric.bad_news.json',
    '예방접종': 'canonical_rubric.vaccination.json',
    '금연 상담': 'canonical_rubric.smoking_cessation.json',
}


def load_rubric(case: dict | None = None) -> dict:
    """케이스 category에 맞는 정본 루브릭 로드. 미등록 카테고리는 수면 정본 폴백."""
    category = (case or {}).get('category', '수면장애')
    fname = RUBRIC_BY_CATEGORY.get(category, 'canonical_rubric.sleep.json')
    return json.loads((COMMON_DIR / fname).read_text(encoding='utf-8'))


def is_depression_related(case: dict) -> bool:
    """환자교육 조건부 분기(§4.4-5) — 우울장애 연관 증례 여부."""
    hay = case.get('id', '') + case.get('title', '') + ' '.join(case.get('tags', []))
    return 'depression' in hay or '우울' in hay


def build_context(case: dict, persona: dict | None = None) -> dict:
    """조건부 항목 판정용 컨텍스트 플래그 — 루브릭 conditional.flag와 이름을 맞춘다."""
    gender = (persona or {}).get('gender') or (case.get('demographicsRule', {}).get('fixed', {}).get('gender', ''))
    return {
        'caseId': case.get('id'),
        'depressionRelated': is_depression_related(case),
        'femalePatient': '여' in str(gender),
    }


def format_transcript(events: list[dict]) -> str:
    lines = []
    for i, e in enumerate(events, 1):
        t = e['tOffsetMs'] / 1000
        role = {'student': '의사', 'patient': '환자', 'system': '시스템'}.get(e['role'], e['role'])
        lines.append(f'L{i:03d} [{int(t // 60):02d}:{int(t % 60):02d}] {role}: {e["text"]}')
    return '\n'.join(lines)


def build_extraction_prompt(rubric: dict, events: list[dict], context: dict) -> str:
    sections_desc = []
    for s in rubric['sections']:
        if s['type'] == 'deduction':
            v_lines = []
            for v in s['violationTypes']:
                line = f"- {v['id']}: {v['text']}"
                if v.get('absoluteException'):
                    line += f"\n  [절대 예외] {v['absoluteException']}"
                v_lines.append(line)
            sections_desc.append(f"## {s['name']} — 위반 행위 탐지 (감지된 위반만 보고)\n" + '\n'.join(v_lines))
        else:
            items = []
            for i in s['items']:
                cond = i.get('conditional')
                if cond and not context.get(cond['flag'], False):
                    continue  # 조건부 제외 항목은 아예 판정 대상에서 뺀다
                hint = f" (판정 힌트: {i['contextHint']})" if i.get('contextHint') else ''
                items.append(f"- {i['id']}: {i['text']}{hint}")
            sections_desc.append(f"## {s['name']}\n" + '\n'.join(items))

    rules = rubric['evaluationRules']
    return f"""당신은 의과대학 CPX(진료수행시험) 채점을 위한 근거 추출기다.
아래 [의사-환자 대화 로그]를 분석해, 각 채점 항목에 대해 의사(학생)가 해당 행위를 얼마나 수행했는지와 그 근거를 추출하라.

[역할 제한 — 매우 중요]
- 너의 역할은 근거 추출뿐이다. 점수 계산·등급 판정은 별도의 규칙 엔진이 수행한다.
- 평가 대상은 오직 '의사' 발화다. 환자(AI)의 응답 품질·성격·프롬프트 준수는 절대 평가하지 않는다.

[판정 규칙]
1. {rules['contextOverKeyword']}
2. {rules['declarationCountsAsPerformance']}
3. {rules['evidenceRequired']} — evidence에는 로그 라인 번호(L001 형식)와 발화 인용을 포함하라.
4. {rules['sttTolerance']}
5. 임상예의 위반 탐지 시: 의료적 필수 인적사항 질문(성별·나이·생년월일·이름·경제수준·학력·직업·키·몸무게)은 절대 위반으로 보고하지 마라. 애매하면 exempt=true로 표시하라.
6. status는 met(충분히 수행), partial(일부만 수행하거나 안전상 불완전), not_met(근거 없음) 중 하나다. partial은 관련 질문·설명은 했지만 핵심 요소가 빠진 경우에만 쓴다.
7. 근거가 없으면 status=not_met, satisfied=false, evidence=[]로 하라. 추측으로 인정하지 마라.

[채점 항목]
{chr(10).join(sections_desc)}

[의사-환자 대화 로그]
{format_transcript(events)}
"""


# Gemini 구조화 출력 스키마 (동적 키 불가 → 배열로 받고 서버에서 dict 변환)
RESPONSE_SCHEMA = {
    'type': 'OBJECT',
    'properties': {
        'items': {
            'type': 'ARRAY',
            'items': {
                'type': 'OBJECT',
                'properties': {
                    'id': {'type': 'STRING'},
                    'satisfied': {'type': 'BOOLEAN'},
                    'status': {'type': 'STRING', 'enum': ['met', 'partial', 'not_met']},
                    'evidence': {'type': 'ARRAY', 'items': {'type': 'STRING'}},
                    'confidence': {'type': 'STRING', 'enum': ['high', 'medium', 'low']},
                },
                'required': ['id', 'satisfied', 'status', 'evidence'],
            },
        },
        'violations': {
            'type': 'ARRAY',
            'items': {
                'type': 'OBJECT',
                'properties': {
                    'type': {'type': 'STRING', 'enum': ['et01', 'et02', 'et03']},
                    'evidence': {'type': 'STRING'},
                    'exempt': {'type': 'BOOLEAN'},
                    'reason': {'type': 'STRING'},
                },
                'required': ['type', 'evidence'],
            },
        },
    },
    'required': ['items', 'violations'],
}


def extract_judgments(api_key: str, rubric: dict, events: list[dict], context: dict) -> dict:
    """Gemini 근거 추출 호출 → scoring.py 입력 형태로 변환."""
    from google import genai

    # per-request 타임아웃(ms) — 단일 시도가 무한정 매달리지 않도록. 상위 스레드 데드라인과 이중 방어.
    client = genai.Client(api_key=api_key, http_options={'timeout': 60000})
    prompt_text = build_extraction_prompt(rubric, events, context)
    config = {
        'response_mime_type': 'application/json',
        'response_schema': RESPONSE_SCHEMA,
        'temperature': 0,  # 추출 재현성
    }
    # thinking 무제한이면 추출에 ~10분 소요(2026-07-10 실측, 527~752s) → 서비스 75s 타임아웃과 양립 불가.
    # 기본 0(비활성). 판정 품질 저하가 관찰되면 GEMINI_EVAL_THINKING_BUDGET로 소량 부여.
    budget = int(os.environ.get('GEMINI_EVAL_THINKING_BUDGET', '0'))
    config['thinking_config'] = {'thinking_budget': budget}
    resp = client.models.generate_content(
        model=EVAL_MODEL,
        contents=prompt_text,
        config=config,
    )
    raw = json.loads(resp.text)
    valid_ids = {i['id'] for s in rubric['sections'] if s['type'] != 'deduction' for i in s['items']}
    items = {}
    for item in raw.get('items', []):
        if item.get('id') in valid_ids:
            status = item.get('status')
            if status not in {'met', 'partial', 'not_met'}:
                status = 'met' if item.get('satisfied') else 'not_met'
            items[item['id']] = {
                'satisfied': status == 'met',
                'status': status,
                'evidence': item.get('evidence', []),
                'confidence': item.get('confidence', 'medium'),
            }
    # 판정 누락 항목은 미충족 처리 (추측 인정 금지 원칙과 일관)
    for missing in valid_ids - set(items):
        items[missing] = {'satisfied': False, 'status': 'not_met', 'evidence': [], 'confidence': 'low'}
    return {'items': items, 'violations': raw.get('violations', [])}


def build_feedback(rubric: dict, result: dict) -> dict:
    """결정론적 교정 피드백 — 놓친 항목을 영역별로 정리 (034 correctionFeedback 필드 충족)."""
    item_text = {i['id']: i['text'] for s in rubric['sections'] if s['type'] != 'deduction' for i in s['items']}
    missed = {}
    for s in result['sections']:
        pending = [*s.get('partialIds', []), *s.get('missedIds', [])]
        if pending:
            missed[s['name']] = [item_text[i] for i in pending]
    strengths = [s['name'] for s in result['sections'] if s['grade'] == 2]
    return {
        'strengths': strengths,
        'missedBySection': missed,
        'violationNotes': [v.get('reason') or v.get('evidence', '') for v in result['violations']],
    }
