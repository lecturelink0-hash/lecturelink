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
        # 케이스가 명시적으로 false 를 선언한 경우에만 신체진찰 면제 (기본 True)
        'physicalExamRequired': case.get('physicalExamRequired', True) is not False,
    }


def format_transcript(events: list[dict]) -> str:
    lines = []
    for i, e in enumerate(events, 1):
        t = e['tOffsetMs'] / 1000
        role = {'student': '의사', 'patient': '환자', 'system': '시스템'}.get(e['role'], e['role'])
        lines.append(f'L{i:03d} [{int(t // 60):02d}:{int(t % 60):02d}] {role}: {e["text"]}')
    return '\n'.join(lines)


def rubric_sections_for_context(rubric: dict, context: dict) -> list[dict]:
    """컨텍스트상 판정 대상인 섹션 — 신체진찰 면제 케이스는 진찰 섹션을 통째로 뺀다."""
    return [
        s for s in rubric['sections']
        if not (s['id'] == 'physical_exam' and context.get('physicalExamRequired', True) is False)
    ]


def build_extraction_prompt(rubric: dict, events: list[dict], context: dict) -> str:
    sections_desc = []
    for s in rubric_sections_for_context(rubric, context):
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
5. 환자가 저항·거부하거나 정보를 숨기거나 모호하게 답했더라도, 의사가 해당 항목의 질문·설명·재질문·설득을 적절히 수행했다면 수행으로 인정하라. 환자의 협조 여부와 답변의 완성도는 의사 평가에 반영하지 않는다.
6. 임상예의 위반 탐지 시: 의료적 필수 인적사항 질문(성별·나이·생년월일·이름·경제수준·학력·직업·키·몸무게)은 절대 위반으로 보고하지 마라. 애매하면 exempt=true로 표시하라.
7. status는 met(충분히 수행), partial(일부만 수행하거나 안전상 불완전), not_met(근거 없음) 중 하나다. partial은 관련 질문·설명은 했지만 핵심 요소가 빠진 경우에만 쓴다.
8. 근거가 없으면 status=not_met, satisfied=false, evidence=[]로 하라. 추측으로 인정하지 마라.

[진료 단계 구분 — phases 필드]
진료는 보통 병력청취 → 신체진찰 → 환자교육(설명·계획) 순서로 진행된다. 각 단계가 시작된 로그 라인 번호(L001 형식의 숫자 부분)를 phases 배열로 보고하라.
- history_taking: 첫 문진이 시작된 라인 (보통 1).
- physical_exam: 의사가 처음 진찰을 선언·시행한 라인 ("~진찰하겠습니다", "청진하겠습니다" 등). 진찰이 전혀 없으면 항목을 생략하라.
- patient_education: 의사가 추정 진단·검사 계획·생활 교육 등 설명을 본격적으로 시작한 라인. 교육이 전혀 없으면 항목을 생략하라.
각 단계는 최초 시작 라인 1개만 보고한다. 중간에 잠깐 되돌아간 것은 무시하라.

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
        'phases': {
            'type': 'ARRAY',
            'items': {
                'type': 'OBJECT',
                'properties': {
                    'phase': {'type': 'STRING', 'enum': ['history_taking', 'physical_exam', 'patient_education']},
                    'startLine': {'type': 'INTEGER'},
                },
                'required': ['phase', 'startLine'],
            },
        },
    },
    'required': ['items', 'violations', 'phases'],
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
    # 채점 호출 토큰 사용량 — 세션 원가 실측(usage_events)에 기록된다. 실패해도 채점은 계속.
    usage = None
    meta = getattr(resp, 'usage_metadata', None)
    if meta is not None:
        prompt_tokens = int(getattr(meta, 'prompt_token_count', 0) or 0)
        candidates = int(getattr(meta, 'candidates_token_count', 0) or 0)
        thoughts = int(getattr(meta, 'thoughts_token_count', 0) or 0)  # thinking도 출력 단가로 청구됨
        usage = {
            'promptTokens': prompt_tokens,
            'responseTokens': candidates + thoughts,
            'totalTokens': int(getattr(meta, 'total_token_count', 0) or 0),
            'promptTextTokens': prompt_tokens,
            'responseTextTokens': candidates + thoughts,
        }
    valid_ids = {i['id'] for s in rubric_sections_for_context(rubric, context) if s['type'] != 'deduction' for i in s['items']}
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
    return {'items': items, 'violations': raw.get('violations', []), 'phases': raw.get('phases', []), 'usage': usage}


# ── 진료 단계별 소요 시간 (§결과 기록 시간 분석) ────────────────────────────────
PHASE_ORDER = ['history_taking', 'physical_exam', 'patient_education']
PHASE_NAMES = {'history_taking': '병력청취', 'physical_exam': '신체진찰', 'patient_education': '환자교육'}


def compute_time_analysis(
    events: list[dict],
    raw_phases: list[dict] | None,
    time_limit_seconds: int | None = None,
    session: dict | None = None,
    exam_declarations: set[str] | None = None,
) -> dict | None:
    """전사 타임스탬프로 단계별 사용 시간을 계산한다 — 결정론적, LLM은 단계 경계만 제공.

    각 단계는 다음 단계 시작 전까지 이어진 것으로 본다(표준 진행 순서 가정).
    LLM이 신체진찰 경계를 못 찾았으면 진찰 버튼 선언 문구(정확 일치)를 폴백으로 쓴다.
    """
    if not events:
        return None
    last_ms = max(e['tOffsetMs'] for e in events)
    total_ms = last_ms
    # 세션 종료 시각이 있으면 마지막 발화 이후 침묵까지 포함 (비정상 값은 무시)
    if session and session.get('ended_at') and session.get('started_at'):
        wall_ms = (session['ended_at'] - session['started_at']) * 1000
        if last_ms <= wall_ms <= last_ms + 10 * 60 * 1000:
            total_ms = wall_ms

    starts: dict[str, int] = {}
    for p in sorted(raw_phases or [], key=lambda x: x.get('startLine') or 0):
        phase, line = p.get('phase'), p.get('startLine')
        if phase not in PHASE_NAMES or phase in starts:
            continue
        if not isinstance(line, int) or not (1 <= line <= len(events)):
            continue
        starts[phase] = events[line - 1]['tOffsetMs']
    source = 'llm' if starts else 'heuristic'
    # 폴백: 진찰 버튼 클릭은 선언 문구가 학생 발화로 기록되므로 정확한 시각을 안다
    if 'physical_exam' not in starts and exam_declarations:
        for e in events:
            if e.get('role') == 'student' and e.get('text') in exam_declarations:
                starts['physical_exam'] = e['tOffsetMs']
                break
    if not starts:
        return {
            'totalSeconds': round(total_ms / 1000),
            'timeLimitSeconds': time_limit_seconds,
            'phases': [],
            'source': 'unavailable',
        }
    # 병력청취 시작은 항상 첫 이벤트로 보정
    first_ms = events[0]['tOffsetMs']
    starts['history_taking'] = min(starts.get('history_taking', first_ms), first_ms)

    ordered = sorted(starts.items(), key=lambda kv: kv[1])
    phases_out = []
    for i, (phase, start_ms) in enumerate(ordered):
        end_ms = ordered[i + 1][1] if i + 1 < len(ordered) else max(total_ms, start_ms)
        phases_out.append({
            'id': phase,
            'name': PHASE_NAMES[phase],
            'startSeconds': round(start_ms / 1000),
            'seconds': max(0, round((end_ms - start_ms) / 1000)),
        })
    return {
        'totalSeconds': round(total_ms / 1000),
        'timeLimitSeconds': time_limit_seconds,
        'phases': phases_out,
        'source': source,
    }


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
