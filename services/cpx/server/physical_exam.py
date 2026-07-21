"""신체진찰 버튼 → 케이스별 소견 카드 (§8).

데이터 소스: 케이스의 physicalExamRule (item/method/expectedFinding).
버튼을 키워드로 physicalExamRule 항목에 매칭한다. 매칭 없으면 정상 소견 기본 카드.
버튼 세트는 케이스 category별로 다르다 (Phase 8: 주호소마다 필수 진찰이 다름).

버튼 클릭은 채점 근거가 되므로(pe02 청진, pe03 구강/갑상샘/전립선 등) 세션 전사에
system 이벤트로 기록되어야 한다 → main.py에서 처리.
"""

# 버튼 정의: id, 라벨, 매칭 키워드(item/method에 포함되면 해당 버튼 소견), 선언 문구(전사 기록용)
SLEEP_BUTTONS = [
    {
        'id': 'oral',
        'label': '구강검사',
        'keywords': ['구강', '상기도', '두경부', '편도'],
        'declaration': '구강과 상기도를 살펴보겠습니다.',
        'defaultFinding': '구강·인두 특이소견 없음. 편도 비대 없음.',
    },
    {
        'id': 'bp',
        'label': '혈압/활력징후',
        'keywords': ['활력징후', '혈압', '전반적 외견', '비만'],
        'declaration': '활력징후와 전반적 상태를 확인하겠습니다.',
        'defaultFinding': '혈압·맥박·체온 정상 범위. 전반적 외견 양호.',
    },
    {
        'id': 'palpation',
        'label': '촉진검사',
        'keywords': ['갑상샘', '전립선', '촉진', '하지', '피부', '외상'],
        'declaration': '관련 부위를 촉진하겠습니다.',
        'defaultFinding': '갑상샘 비대 없음. 압통 없음.',
    },
    {
        'id': 'pulse',
        'label': '맥박/심음 청진',
        'keywords': ['부정맥', '심장', '맥박', '심음', '심폐'],
        'declaration': '맥박과 심음을 청진하겠습니다.',
        'defaultFinding': '심음 규칙적, 잡음 없음. 맥박 정상.',
    },
    {
        'id': 'auscultation',
        'label': '호흡음 청진',
        'keywords': ['호흡', '심폐', '폐'],
        'declaration': '호흡음을 청진하겠습니다.',
        'defaultFinding': '호흡음 깨끗함. 천명·수포음 없음.',
    },
    {
        'id': 'neuro',
        'label': '신경학적 진찰',
        'keywords': ['신경'],
        'declaration': '신경학적 진찰을 하겠습니다.',
        'defaultFinding': '국소 신경학적 이상 없음.',
    },
    {
        'id': 'psg',
        'label': '수면다원검사',
        'keywords': [],  # physicalExamRule에 없는 특수 항목 — 항상 안내 카드
        'declaration': '수면다원검사를 제안하겠습니다.',
        'defaultFinding': '수면다원검사는 병원에서 하룻밤 입원해 진행합니다. 일정을 조율해 안내해 드리겠습니다.',
    },
]

HEADACHE_BUTTONS = [
    {
        'id': 'bp',
        'label': '혈압/활력징후',
        'keywords': ['활력징후', '혈압', '체온', '맥박'],
        'declaration': '혈압과 체온, 맥박 등 활력징후를 확인하겠습니다.',
        'defaultFinding': '혈압·맥박·체온 정상 범위.',
    },
    {
        'id': 'meningeal',
        'label': '뇌막자극검사',
        'keywords': ['뇌막', '경부 강직', 'Kernig', 'Brudzinski'],
        'declaration': '목이 뻣뻣한지 뇌막자극징후를 확인하겠습니다.',
        'defaultFinding': '경부 강직 없음. Kernig·Brudzinski sign 음성.',
    },
    {
        'id': 'neuro',
        'label': '신경학적 진찰',
        'keywords': ['신경', '근력', '감각', '반사', 'Babinski'],
        'declaration': '팔다리 근력과 감각, 반사를 포함한 신경학적 진찰을 하겠습니다.',
        'defaultFinding': '근력·감각 정상. 병적 반사 없음.',
    },
    {
        'id': 'fundus',
        'label': '안저검사',
        'keywords': ['안저', '유두부종', '뇌압'],
        'declaration': '눈 안쪽을 보는 안저검사를 하겠습니다.',
        'defaultFinding': '유두부종 없음. 안저 정상.',
    },
    {
        'id': 'head_palpation',
        'label': '머리/목 촉진',
        'keywords': ['촉진', '관자동맥', '두피', '근육', '머리·목'],
        'declaration': '머리와 목 주변을 촉진하겠습니다.',
        'defaultFinding': '압통 없음. 관자동맥 특이소견 없음.',
    },
    {
        'id': 'sinus',
        'label': '부비동 압통',
        'keywords': ['부비동'],
        'declaration': '이마와 뺨의 부비동 압통을 확인하겠습니다.',
        'defaultFinding': '부비동 압통 없음.',
    },
    {
        'id': 'eye',
        'label': '눈 시진',
        'keywords': ['눈', '충혈', '동공', '안구운동'],
        'declaration': '눈의 충혈과 동공, 안구 움직임을 살펴보겠습니다.',
        'defaultFinding': '결막 충혈·눈물 없음. 동공·안구운동 정상.',
    },
]

DIZZINESS_BUTTONS = [
    {
        'id': 'bp',
        'label': '혈압/활력징후 (기립 포함)',
        'keywords': ['활력징후', '혈압', '기립'],
        'declaration': '혈압과 맥박을 확인하고, 일어설 때 혈압 변화도 재보겠습니다.',
        'defaultFinding': '활력징후 정상. 기립 시 혈압 변화 없음.',
    },
    {
        'id': 'nystagmus',
        'label': '안진 검사',
        'keywords': ['안진', '안구운동'],
        'declaration': '눈떨림이 있는지 안진 검사를 하겠습니다.',
        'defaultFinding': '자발·주시 안진 없음.',
    },
    {
        'id': 'dix_hallpike',
        'label': 'Dix-Hallpike 두위검사',
        'keywords': ['두위검사', 'Dix-Hallpike'],
        'declaration': '누운 상태에서 머리 위치를 바꾸는 두위검사를 하겠습니다.',
        'defaultFinding': 'Dix-Hallpike 음성.',
    },
    {
        'id': 'gait',
        'label': '직립/보행 검사',
        'keywords': ['평형', '보행', 'Romberg', 'Tandem'],
        'declaration': '똑바로 서기와 일자 걷기 검사를 해보겠습니다.',
        'defaultFinding': 'Romberg·Tandem gait 정상.',
    },
    {
        'id': 'neuro',
        'label': '신경학적 진찰',
        'keywords': ['신경', '소뇌', 'finger'],
        'declaration': '뇌신경과 소뇌 기능을 포함한 신경학적 진찰을 하겠습니다.',
        'defaultFinding': '뇌신경·소뇌기능 정상.',
    },
    {
        'id': 'eye',
        'label': '결막 확인',
        'keywords': ['빈혈', '결막'],
        'declaration': '빈혈이 있는지 눈 결막을 확인하겠습니다.',
        'defaultFinding': '결막 창백 없음.',
    },
    {
        'id': 'hearing',
        'label': '청력 검사',
        'keywords': ['청력', 'Weber', 'Rinne'],
        'declaration': '소리굽쇠로 간단한 청력 검사를 하겠습니다.',
        'defaultFinding': '청력 정상.',
    },
]

FATIGUE_BUTTONS = [
    {
        'id': 'bp',
        'label': '혈압/활력징후',
        'keywords': ['활력징후', '외양'],
        'declaration': '활력징후와 전반적인 상태를 확인하겠습니다.',
        'defaultFinding': '활력징후 정상. 전반적 외견 양호.',
    },
    {
        'id': 'head_neck',
        'label': '두경부 진찰',
        'keywords': ['두경부', '결막', '림프절'],
        'declaration': '눈 결막과 목의 림프절을 확인하겠습니다.',
        'defaultFinding': '빈혈·황달 없음. 림프절 종대 없음.',
    },
    {
        'id': 'thyroid',
        'label': '갑상샘 촉진',
        'keywords': ['갑상샘'],
        'declaration': '목 앞쪽 갑상샘을 촉진하겠습니다.',
        'defaultFinding': '갑상샘 비대 없음.',
    },
    {
        'id': 'heart_lung',
        'label': '심폐 청진',
        'keywords': ['심폐', '심장', '호흡'],
        'declaration': '심장과 호흡음을 청진하겠습니다.',
        'defaultFinding': '심음·호흡음 정상.',
    },
    {
        'id': 'abdomen',
        'label': '복부 촉진',
        'keywords': ['복부', '간', '비장'],
        'declaration': '배를 촉진해 간과 비장을 확인하겠습니다.',
        'defaultFinding': '간·비장 종대 없음. 압통 없음.',
    },
    {
        'id': 'edema',
        'label': '하지 부종 확인',
        'keywords': ['부종'],
        'declaration': '다리에 부종이 있는지 눌러 확인하겠습니다.',
        'defaultFinding': '함요부종 없음.',
    },
]

DYSPEPSIA_BUTTONS = [
    {
        'id': 'bp',
        'label': '혈압/활력징후',
        'keywords': ['활력징후'],
        'declaration': '활력징후를 확인하겠습니다.',
        'defaultFinding': '활력징후 정상.',
    },
    {
        'id': 'eye',
        'label': '눈 진찰 (결막/공막)',
        'keywords': ['결막', '공막', '눈'],
        'declaration': '빈혈과 황달이 있는지 눈을 확인하겠습니다.',
        'defaultFinding': '결막 창백·공막 황달 없음.',
    },
    {
        'id': 'auscultation',
        'label': '복부 청진 (장음)',
        'keywords': ['장음', '청진'],
        'declaration': '촉진하기 전에 배의 장음을 먼저 청진하겠습니다.',
        'defaultFinding': '장음 정상.',
    },
    {
        'id': 'palpation',
        'label': '복부 촉진 (4분면)',
        'keywords': ['촉진', '압통', '종괴'],
        'declaration': '무릎을 세우고 누워주세요. 배를 네 부분으로 나눠 촉진하겠습니다.',
        'defaultFinding': '압통·종괴 없음. 부드럽고 편평함.',
    },
    {
        'id': 'percussion',
        'label': '타진/간비장 확인',
        'keywords': ['타진', '간', '비장'],
        'declaration': '배를 두드려 보고 간과 비장 크기를 확인하겠습니다.',
        'defaultFinding': '간·비장 종대 없음.',
    },
    {
        'id': 'dre',
        'label': '직장수지검사 (DRE)',
        'keywords': ['직장수지', 'DRE'],
        'declaration': '항문을 통한 직장수지검사를 하겠습니다.',
        'defaultFinding': 'DRE 정상 소견.',
    },
]

SYNCOPE_BUTTONS = [
    {'id': 'bp', 'label': '활력징후/심박수', 'keywords': ['활력징후', '심박'],
     'declaration': '혈압과 맥박, 호흡수를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'positional_bp', 'label': '체위별 혈압', 'keywords': ['체위', '기립', '누운'],
     'declaration': '누운 자세와 앉은 자세, 선 자세에서 혈압을 각각 재보겠습니다.', 'defaultFinding': '체위별 혈압 변화 없음.'},
    {'id': 'both_arm_bp', 'label': '양팔 혈압 비교', 'keywords': ['양팔'],
     'declaration': '양쪽 팔의 혈압을 비교해 보겠습니다.', 'defaultFinding': '양팔 혈압 차이 없음.'},
    {'id': 'heart_ausc', 'label': '심음 청진', 'keywords': ['심음', '흉부'],
     'declaration': '심장 소리를 청진하겠습니다.', 'defaultFinding': '심음 규칙적, 잡음 없음.'},
    {'id': 'neuro', 'label': '신경학적 진찰', 'keywords': ['신경'],
     'declaration': '신경학적 진찰을 하겠습니다.', 'defaultFinding': '신경학적 이상 없음.'},
    {'id': 'eye', 'label': '결막 확인', 'keywords': ['결막', '빈혈', '출혈'],
     'declaration': '빈혈이 있는지 눈 결막을 확인하겠습니다.', 'defaultFinding': '결막 창백 없음.'},
    {'id': 'ecg', 'label': '심전도 검사', 'keywords': ['심전도'],
     'declaration': '심전도 검사를 하겠습니다.', 'defaultFinding': '정상 동율동.'},
]

PALPITATION_BUTTONS = [
    {'id': 'bp', 'label': '활력징후/맥박', 'keywords': ['활력징후', '맥박'],
     'declaration': '혈압과 맥박의 빠르기, 규칙성을 확인하겠습니다.', 'defaultFinding': '활력징후 정상, 맥박 규칙적.'},
    {'id': 'heart_ausc', 'label': '심음 청진', 'keywords': ['심음', '흉부'],
     'declaration': '심장 소리를 청진하겠습니다.', 'defaultFinding': '심음 규칙적, 잡음 없음.'},
    {'id': 'jvp_edema', 'label': '경정맥/부종 확인', 'keywords': ['경정맥', '부종'],
     'declaration': '목 정맥이 확장됐는지, 다리에 부종이 있는지 확인하겠습니다.', 'defaultFinding': '경정맥 확장·부종 없음.'},
    {'id': 'thyroid_eye', 'label': '갑상선/눈꺼풀', 'keywords': ['갑상선', '눈꺼풀', '안구'],
     'declaration': '눈과 목 앞쪽 갑상선을 확인하겠습니다.', 'defaultFinding': '갑상선 비대·안구 돌출 없음.'},
    {'id': 'tremor', 'label': '손떨림 확인', 'keywords': ['손떨림', '떨림'],
     'declaration': '손을 앞으로 뻗어 떨림이 있는지 보겠습니다.', 'defaultFinding': '손떨림 없음.'},
    {'id': 'eye', 'label': '결막 확인', 'keywords': ['결막', '빈혈'],
     'declaration': '빈혈이 있는지 눈 결막을 확인하겠습니다.', 'defaultFinding': '결막 창백 없음.'},
    {'id': 'ecg', 'label': '심전도 검사', 'keywords': ['심전도'],
     'declaration': '심전도 검사를 하겠습니다.', 'defaultFinding': '정상 동율동.'},
]

MEMORY_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'mmse', 'label': '인지선별검사 (MMSE)', 'keywords': ['인지', 'MMSE'],
     'declaration': '기억력과 집중력을 보는 간단한 검사를 몇 가지 해보겠습니다.', 'defaultFinding': '인지기능 선별검사 정상 범위.'},
    {'id': 'neuro', 'label': '신경학적 진찰', 'keywords': ['신경', '보행'],
     'declaration': '걸음걸이와 팔다리 힘, 반사를 포함한 신경학적 진찰을 하겠습니다.', 'defaultFinding': '신경학적 이상 없음.'},
    {'id': 'thyroid', 'label': '갑상샘 촉진', 'keywords': ['갑상샘', '갑상선'],
     'declaration': '목 앞쪽 갑상샘을 촉진하겠습니다.', 'defaultFinding': '갑상샘 비대 없음.'},
]

BACKPAIN_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'spine_inspect', 'label': '척추 정렬 시진', 'keywords': ['척추', '정렬', '시진'],
     'declaration': '서 있는 자세에서 척추의 정렬 상태를 살펴보겠습니다.', 'defaultFinding': '측만·후만 없음.'},
    {'id': 'palpation', 'label': '허리 촉진/압통', 'keywords': ['촉진', '압통'],
     'declaration': '허리를 눌러 아픈 부위를 확인하겠습니다.', 'defaultFinding': '국소 압통 없음.'},
    {'id': 'slr', 'label': '하지직거상검사 (SLR)', 'keywords': ['하지직거상', 'SLR'],
     'declaration': '누운 상태에서 다리를 곧게 들어 올리는 검사를 양쪽 모두 하겠습니다.', 'defaultFinding': 'SLR 양측 음성.'},
    {'id': 'neuro_leg', 'label': '하지 신경 검사', 'keywords': ['감각', '근력', '반사', '하지 신경'],
     'declaration': '다리의 감각과 힘, 반사를 확인하겠습니다.', 'defaultFinding': '하지 감각·근력·반사 정상.'},
    {'id': 'gait', 'label': '보행 관찰', 'keywords': ['보행'],
     'declaration': '몇 걸음 걸어보시겠어요? 걸음걸이를 관찰하겠습니다.', 'defaultFinding': '보행 정상.'},
]

FEVER_BUTTONS = [
    {'id': 'bp', 'label': '활력징후/체온', 'keywords': ['활력징후', '체온'],
     'declaration': '체온을 포함한 활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'throat', 'label': '인후/구강 시진', 'keywords': ['인후', '구강'],
     'declaration': '목 안과 입 안을 살펴보겠습니다.', 'defaultFinding': '인후 발적·삼출물 없음.'},
    {'id': 'lymph_neck', 'label': '림프절/목 강직', 'keywords': ['림프절', '강직', '목'],
     'declaration': '목의 림프절과 목이 뻣뻣한지 확인하겠습니다.', 'defaultFinding': '림프절 종대·목 강직 없음.'},
    {'id': 'chest_ausc', 'label': '흉부 청진', 'keywords': ['흉부', '호흡음', '심음'],
     'declaration': '가슴의 호흡음과 심음을 청진하겠습니다.', 'defaultFinding': '호흡음·심음 정상.'},
    {'id': 'abdomen_cva', 'label': '복부/CVA 압통', 'keywords': ['복부', 'CVA', '옆구리'],
     'declaration': '배를 진찰하고 옆구리를 가볍게 두드려 보겠습니다.', 'defaultFinding': '복부 압통·CVA 압통 없음.'},
    {'id': 'skin', 'label': '피부 발진/가피', 'keywords': ['피부', '발진', '가피'],
     'declaration': '피부에 발진이나 물린 자국이 있는지 살펴보겠습니다.', 'defaultFinding': '발진·가피 없음.'},
]

WEIGHT_LOSS_BUTTONS = [
    {'id': 'bp', 'label': '활력징후/영양상태', 'keywords': ['활력징후', '영양', '체중'],
     'declaration': '활력징후와 체중, 전반적인 영양 상태를 확인하겠습니다.', 'defaultFinding': '활력징후 정상, 영양상태 양호.'},
    {'id': 'eye', 'label': '눈 진찰 (결막/공막)', 'keywords': ['결막', '공막', '눈'],
     'declaration': '빈혈과 황달이 있는지 눈을 확인하겠습니다.', 'defaultFinding': '결막 창백·공막 황달 없음.'},
    {'id': 'thyroid_lymph', 'label': '갑상샘/림프절', 'keywords': ['갑상샘', '림프절'],
     'declaration': '갑상샘과 림프절을 촉진하겠습니다.', 'defaultFinding': '갑상샘 비대·림프절 종대 없음.'},
    {'id': 'chest_ausc', 'label': '흉부 청진', 'keywords': ['흉부', '호흡음', '심음'],
     'declaration': '가슴의 호흡음과 심음을 청진하겠습니다.', 'defaultFinding': '호흡음·심음 정상.'},
    {'id': 'abdomen', 'label': '복부 진찰', 'keywords': ['복부', '종괴', '간비장'],
     'declaration': '배를 촉진해 압통이나 만져지는 것이 있는지 확인하겠습니다.', 'defaultFinding': '압통·종괴 없음.'},
    {'id': 'dre', 'label': '직장수지검사 (DRE)', 'keywords': ['직장수지', 'DRE'],
     'declaration': '항문을 통한 직장수지검사를 하겠습니다.', 'defaultFinding': 'DRE 정상 소견.'},
]

COUGH_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'throat', 'label': '인후 시진', 'keywords': ['인후'],
     'declaration': '목 안을 살펴보겠습니다.', 'defaultFinding': '인후 특이소견 없음.'},
    {'id': 'lymph', 'label': '경부 림프절', 'keywords': ['림프절'],
     'declaration': '목의 림프절을 촉진하겠습니다.', 'defaultFinding': '림프절 종대 없음.'},
    {'id': 'lung_ausc', 'label': '호흡음 청진', 'keywords': ['호흡음'],
     'declaration': '숨소리를 청진하겠습니다.', 'defaultFinding': '호흡음 깨끗함.'},
    {'id': 'heart_ausc', 'label': '심음 청진', 'keywords': ['심음'],
     'declaration': '심장 소리를 청진하겠습니다.', 'defaultFinding': '심음 정상.'},
    {'id': 'nose_sinus', 'label': '코/부비동 확인', 'keywords': ['코', '부비동'],
     'declaration': '코 안과 부비동 압통을 확인하겠습니다.', 'defaultFinding': '비점막·부비동 정상.'},
]

JOINT_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'joint_inspect', 'label': '관절 시진', 'keywords': ['시진', '부종', '발적', '변형'],
     'declaration': '아픈 관절의 붓기와 색, 모양을 살펴보겠습니다.', 'defaultFinding': '부종·발적·변형 없음.'},
    {'id': 'joint_palp', 'label': '관절 촉진 (열감/압통)', 'keywords': ['촉진', '열감', '압통'],
     'declaration': '관절을 만져 열감과 압통을 확인하겠습니다.', 'defaultFinding': '열감·압통 없음.'},
    {'id': 'rom', 'label': '운동범위 확인', 'keywords': ['운동범위', '운동 범위'],
     'declaration': '관절을 움직여 운동 범위를 확인하겠습니다.', 'defaultFinding': '운동범위 정상.'},
    {'id': 'other_joints', 'label': '다른 관절/대칭성', 'keywords': ['다른 관절', '대칭'],
     'declaration': '다른 관절들도 함께 확인하겠습니다.', 'defaultFinding': '다른 관절 정상.'},
    {'id': 'skin_eye', 'label': '피부/눈 확인', 'keywords': ['피부', '발진', '눈'],
     'declaration': '피부 발진과 눈 상태도 확인하겠습니다.', 'defaultFinding': '발진·건조 없음.'},
]

CONSTIPATION_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'abdomen', 'label': '복부 진찰', 'keywords': ['복부', '촉진', '타진'],
     'declaration': '배를 보고 듣고 만져서 진찰하겠습니다.', 'defaultFinding': '압통·종괴 없음, 장음 정상.'},
    {'id': 'dre', 'label': '직장수지검사 (DRE)', 'keywords': ['직장수지', 'DRE'],
     'declaration': '항문을 통한 직장수지검사를 하겠습니다.', 'defaultFinding': 'DRE 정상 소견.'},
    {'id': 'thyroid_general', 'label': '전신/갑상샘 확인', 'keywords': ['전신', '갑상샘'],
     'declaration': '얼굴과 목, 갑상샘 등 전신 상태를 확인하겠습니다.', 'defaultFinding': '전신·갑상샘 특이소견 없음.'},
]

DIARRHEA_BUTTONS = [
    {'id': 'bp', 'label': '활력징후 (탈수/발열)', 'keywords': ['활력징후', '탈수'],
     'declaration': '체온과 혈압, 맥박을 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'abdomen', 'label': '복부 진찰', 'keywords': ['복부', '촉진', '청진'],
     'declaration': '배를 보고 듣고 만져서 진찰하겠습니다.', 'defaultFinding': '압통 없음, 장음 정상.'},
    {'id': 'hydration', 'label': '탈수 평가 (구강/피부)', 'keywords': ['구강', '긴장도', '탈수 평가'],
     'declaration': '입 안과 피부 상태로 탈수 정도를 확인하겠습니다.', 'defaultFinding': '구강 점막 촉촉, 피부 긴장도 정상.'},
    {'id': 'general', 'label': '전신 확인', 'keywords': ['전신'],
     'declaration': '전신 상태를 확인하겠습니다.', 'defaultFinding': '특이소견 없음.'},
]

RHINORRHEA_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'nose_discharge', 'label': '콧물 성상/안면', 'keywords': ['콧물 성상', '안면', '얼굴'],
     'declaration': '콧물의 색과 얼굴 통증 여부를 확인하겠습니다.', 'defaultFinding': '맑은 콧물, 안면 통증 없음.'},
    {'id': 'throat', 'label': '인후/편도 확인', 'keywords': ['인후', '편도'],
     'declaration': '목 안과 편도를 살펴보겠습니다.', 'defaultFinding': '발적·부종 없음.'},
    {'id': 'nasal_cavity', 'label': '코 내부 검사', 'keywords': ['비점막', '비갑개', '코 내부'],
     'declaration': '코 안의 점막과 구조물을 살펴보겠습니다.', 'defaultFinding': '비점막·비갑개 정상.'},
    {'id': 'sinus', 'label': '부비동 압통', 'keywords': ['부비동'],
     'declaration': '이마와 광대뼈의 부비동 압통을 확인하겠습니다.', 'defaultFinding': '부비동 압통 없음.'},
]

NECK_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'palpation', 'label': '목/어깨 촉진', 'keywords': ['촉진', '압통점'],
     'declaration': '목과 어깨 근육을 눌러 아픈 곳을 확인하겠습니다.', 'defaultFinding': '압통점 없음.'},
    {'id': 'rom', 'label': '목 운동범위', 'keywords': ['운동범위', '운동 범위'],
     'declaration': '고개를 여러 방향으로 움직여 보겠습니다.', 'defaultFinding': '운동범위 정상.'},
    {'id': 'spurling', 'label': 'Spurling/압박 검사', 'keywords': ['Spurling', '압박'],
     'declaration': '고개를 기울여 누르는 신경 압박 검사를 하겠습니다.', 'defaultFinding': 'Spurling 음성.'},
    {'id': 'arm_neuro', 'label': '상지 신경 검사', 'keywords': ['상지', '감각', '근력', '반사'],
     'declaration': '팔과 손의 감각과 힘, 반사를 확인하겠습니다.', 'defaultFinding': '상지 감각·근력·반사 정상.'},
]

URINARY_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'lower_abdomen', 'label': '하복부 촉진', 'keywords': ['하복부'],
     'declaration': '아랫배를 눌러 확인하겠습니다.', 'defaultFinding': '하복부 압통·팽만 없음.'},
    {'id': 'flank', 'label': '옆구리 (CVA) 확인', 'keywords': ['옆구리', 'CVA'],
     'declaration': '옆구리를 가볍게 두드려 확인하겠습니다.', 'defaultFinding': 'CVA 압통 없음.'},
    {'id': 'dre', 'label': '직장수지검사 (DRE)', 'keywords': ['직장수지', 'DRE', '전립선'],
     'declaration': '항문을 통해 전립선을 확인하는 직장수지검사를 하겠습니다.', 'defaultFinding': 'DRE 정상 소견.'},
    {'id': 'urinalysis', 'label': '소변검사 (딥스틱)', 'keywords': ['소변검사', '요검사'],
     'declaration': '소변검사를 해보겠습니다.', 'defaultFinding': '요검사 정상.'},
]

RED_URINE_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'flank', 'label': '옆구리 (CVA) 확인', 'keywords': ['옆구리', 'CVA'],
     'declaration': '옆구리를 가볍게 두드려 확인하겠습니다.', 'defaultFinding': 'CVA 압통 없음.'},
    {'id': 'lower_abdomen', 'label': '하복부·방광 촉진', 'keywords': ['하복부', '방광'],
     'declaration': '아랫배와 방광 부위를 눌러 확인하겠습니다.', 'defaultFinding': '하복부 압통·팽만 없음.'},
    {'id': 'edema', 'label': '부종·혈압 (신염 징후)', 'keywords': ['부종', '신염', '눈꺼풀'],
     'declaration': '눈꺼풀·다리 부종과 혈압을 확인하겠습니다.', 'defaultFinding': '부종 없음, 혈압 정상.'},
    {'id': 'urinalysis', 'label': '소변검사 (딥스틱+현미경)', 'keywords': ['소변검사', '요검사', '현미경'],
     'declaration': '소변검사를 해보겠습니다.', 'defaultFinding': '요검사 정상.'},
]

INCONTINENCE_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'lower_abdomen', 'label': '하복부·방광 촉진', 'keywords': ['하복부', '방광'],
     'declaration': '아랫배와 방광 팽만 여부를 확인하겠습니다.', 'defaultFinding': '하복부 압통·방광 팽만 없음.'},
    {'id': 'neuro', 'label': '하지 신경학적 검사', 'keywords': ['신경학적', '하지 근력', '감각', '반사'],
     'declaration': '다리의 힘과 감각, 반사를 확인하겠습니다.', 'defaultFinding': '하지 신경학적 이상 없음.'},
    {'id': 'pelvic_floor', 'label': '골반저·기침 유발 검사', 'keywords': ['골반저', '기침 유발', '골반 진찰'],
     'declaration': '검사의 목적과 불편 가능성을 설명드린 뒤, 동의를 받고 골반저와 기침 유발 검사를 하겠습니다.',
     'defaultFinding': '골반저 진찰은 동의 후 시행하며 특이소견 없음.'},
    {'id': 'urinalysis', 'label': '소변검사 (딥스틱)', 'keywords': ['소변검사', '요검사'],
     'declaration': '소변검사를 해보겠습니다.', 'defaultFinding': '요검사 정상.'},
]

EASY_BRUISING_BUTTONS = [
    {'id': 'vitals', 'label': '활력징후/결막 확인', 'keywords': ['활력징후', '결막'],
     'declaration': '활력징후와 결막이 창백한지 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 결막 창백 없음.'},
    {'id': 'skin_bruise', 'label': '피부 멍·점상출혈 확인', 'keywords': ['점상출혈', '자반', '멍', '피부 출혈'],
     'declaration': '피부의 멍과 작은 출혈 반점이 있는지 살펴보겠습니다.', 'defaultFinding': '점상출혈·자반·이상 멍 없음.'},
    {'id': 'oral_bleeding', 'label': '구강·잇몸 출혈 확인', 'keywords': ['구강', '잇몸'],
     'declaration': '입 안과 잇몸에 출혈이 있는지 확인하겠습니다.', 'defaultFinding': '구강·잇몸 출혈 없음.'},
    {'id': 'neck_lymph', 'label': '경부 림프절 확인', 'keywords': ['림프절'],
     'declaration': '목의 림프절이 커져 있는지 부드럽게 만져보겠습니다.', 'defaultFinding': '경부 림프절 종대 없음.'},
    {'id': 'abdomen_liver_spleen', 'label': '복부·간비장 촉진', 'keywords': ['복부', '간비장', '간·비장'],
     'declaration': '배를 진찰해 간이나 비장이 커졌는지 확인하겠습니다.', 'defaultFinding': '복부 압통·간비장 비대 없음.'},
]

WEIGHT_GAIN_BUTTONS = [
    {'id': 'vitals_body', 'label': '활력징후/체형·허리둘레', 'keywords': ['활력징후', '체형', '허리둘레'],
     'declaration': '활력징후와 키·몸무게, 허리둘레를 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 체형과 허리둘레는 정상 범위.'},
    {'id': 'eye_skin', 'label': '결막·공막/피부·모발 확인', 'keywords': ['결막', '공막', '피부', '모발'],
     'declaration': '결막과 눈 흰자, 피부와 모발 상태를 살펴보겠습니다.', 'defaultFinding': '결막 창백·공막 황달·피부 이상 없음.'},
    {'id': 'thyroid_skin', 'label': '갑상샘/쿠싱 양상 확인', 'keywords': ['갑상샘', '자색선조', 'moon face', 'buffalo'],
     'declaration': '목 앞쪽 갑상샘과 피부의 자색선조, 얼굴 모양을 확인하겠습니다.', 'defaultFinding': '갑상샘 비대·자색선조·특이 얼굴 변화 없음.'},
    {'id': 'heart_lung', 'label': '심음·호흡음/경정맥 확인', 'keywords': ['심음', '호흡음', '경정맥'],
     'declaration': '심장과 폐 소리를 듣고 목 혈관이 팽창했는지 확인하겠습니다.', 'defaultFinding': '심음·호흡음 정상, 경정맥 팽대 없음.'},
    {'id': 'abdomen_edema', 'label': '복부·간비장/하지 부종 확인', 'keywords': ['복부', '복수', '간비장', '하지 부종'],
     'declaration': '배를 진찰해 복수나 간비장이 커졌는지 보고, 다리 부종도 확인하겠습니다.', 'defaultFinding': '복수·간비장 비대·하지 함요부종 없음.'},
]

SKIN_RASH_BUTTONS = [
    {'id': 'vitals', 'label': '활력징후/전신 상태', 'keywords': ['활력징후', '전신 상태'],
     'declaration': '활력징후와 전반적인 몸 상태를 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 전신 상태 양호.'},
    {'id': 'rash_inspection', 'label': '피부 발진 시진', 'keywords': ['피부 발진', '발진 분포', '인설', '물집', '가피', '삼출'],
     'declaration': '발진 부위의 분포와 모양, 물집·인설·진물이 있는지 살펴보겠습니다.', 'defaultFinding': '특이 피부 발진 없음.'},
    {'id': 'rash_palpation', 'label': '발진 촉진/피부묘기증', 'keywords': ['피부 촉진', '열감', '압통', '피부묘기증', '눌러'],
     'declaration': '발진을 부드럽게 만져 열감·압통을 보고, 눌렀을 때 변화를 확인하겠습니다.', 'defaultFinding': '열감·압통·피부묘기증 없음.'},
    {'id': 'eye_oral', 'label': '눈·구강 점막 확인', 'keywords': ['눈', '구강', '점막', '구강 궤양'],
     'declaration': '눈과 입 안 점막에 병변이나 부종이 있는지 확인하겠습니다.', 'defaultFinding': '눈·구강 점막 병변 없음.'},
    {'id': 'neck_lymph', 'label': '경부 림프절 확인', 'keywords': ['림프절'],
     'declaration': '목의 림프절이 커져 있는지 확인하겠습니다.', 'defaultFinding': '경부 림프절 종대 없음.'},
]

CONVULSION_BUTTONS = [
    {'id': 'vitals_o2', 'label': '활력징후/산소포화도·의식', 'keywords': ['활력징후', '산소포화도', '의식', '지남력'],
     'declaration': '활력징후와 산소포화도, 의식과 지남력을 먼저 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 산소포화도 정상, 의식 명료.'},
    {'id': 'eye_oral', 'label': '동공·안구/구강·혀 확인', 'keywords': ['동공', '안구운동', '구강', '혀', '외상'],
     'declaration': '동공과 눈 움직임, 입 안과 혀를 확인하고 외상 흔적도 살펴보겠습니다.', 'defaultFinding': '동공·안구운동 정상, 혀 깨물림·두부 외상 없음.'},
    {'id': 'meningeal', 'label': '수막자극징후 확인', 'keywords': ['수막', '경부 강직', 'Kernig', 'Brudzinski'],
     'declaration': '목이 뻣뻣한지와 수막자극징후를 확인하겠습니다.', 'defaultFinding': '경부 강직 없음. Kernig·Brudzinski sign 음성.'},
    {'id': 'neuro', 'label': '신경학적 진찰', 'keywords': ['신경', '근력', '감각', '반사', '소뇌', '보행'],
     'declaration': '팔다리 힘과 감각, 반사, 협응과 걸음걸이를 확인하겠습니다.', 'defaultFinding': '신경학적 이상 없음.'},
    {'id': 'glucose', 'label': '혈당 확인', 'keywords': ['혈당'],
     'declaration': '저혈당 여부를 확인하기 위해 혈당을 측정하겠습니다.', 'defaultFinding': '혈당 정상 범위.'},
]

WEAKNESS_PARESTHESIA_BUTTONS = [
    {'id': 'vitals_o2', 'label': '활력징후/의식·언어 확인', 'keywords': ['활력징후', '의식', '언어', '구음'],
     'declaration': '활력징후와 의식, 말이 어눌하지 않은지 먼저 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 의식·언어 명료.'},
    {'id': 'cranial_neuro', 'label': '뇌신경·동공 검사', 'keywords': ['동공', '시야', '안구운동', '얼굴', '뇌신경'],
     'declaration': '동공과 시야, 눈 움직임, 얼굴 감각과 표정을 확인하겠습니다.', 'defaultFinding': '뇌신경 특이소견 없음.'},
    {'id': 'neuro', 'label': '사지 근력·감각·반사', 'keywords': ['근력', '감각', '반사', 'Babinski'],
     'declaration': '양쪽 팔과 다리의 힘·감각·반사를 비교하겠습니다.', 'defaultFinding': '사지 근력·감각·반사 정상.'},
    {'id': 'cerebellar_gait', 'label': '소뇌기능·보행 검사', 'keywords': ['소뇌', '보행', 'Romberg', '협응'],
     'declaration': '협응과 균형, 걸음걸이를 확인하겠습니다.', 'defaultFinding': '협응·보행 정상.'},
    {'id': 'glucose', 'label': '혈당 확인', 'keywords': ['혈당'],
     'declaration': '저혈당 여부를 확인하기 위해 혈당을 측정하겠습니다.', 'defaultFinding': '혈당 정상 범위.'},
]

CLOUDED_CONSCIOUSNESS_BUTTONS = [
    {'id': 'abc_vitals', 'label': 'ABC/활력징후·산소포화도', 'keywords': ['기도', '호흡', '순환', '활력징후', '산소포화도'],
     'declaration': '기도·호흡·순환과 활력징후, 산소포화도를 즉시 확인하겠습니다.', 'defaultFinding': 'ABC 안정, 활력징후·산소포화도 정상.'},
    {'id': 'gcs', 'label': 'GCS·의식 수준 확인', 'keywords': ['GCS', '의식', '지남력', '눈뜨기', '운동 반응'],
     'declaration': '눈뜨기·말·운동 반응을 포함한 의식 수준을 확인하겠습니다.', 'defaultFinding': '의식 명료, GCS 15점.'},
    {'id': 'pupil_oral', 'label': '동공·구강/외상 확인', 'keywords': ['동공', '빛반사', '구강', '혀', '외상'],
     'declaration': '동공 반응과 입 안, 혀와 외상 흔적을 확인하겠습니다.', 'defaultFinding': '동공 반응 정상, 구강·외상 특이소견 없음.'},
    {'id': 'neuro', 'label': '신경학적 진찰', 'keywords': ['신경', '근력', '감각', '반사', '안구운동'],
     'declaration': '국소 신경학적 이상이 있는지 확인하겠습니다.', 'defaultFinding': '국소 신경학적 이상 없음.'},
    {'id': 'glucose', 'label': '혈당 확인', 'keywords': ['혈당'],
     'declaration': '즉시 혈당을 측정하겠습니다.', 'defaultFinding': '혈당 정상 범위.'},
]

HAND_TREMOR_BUTTONS = [
    {'id': 'vitals_thyroid', 'label': '활력징후/결막·갑상샘', 'keywords': ['활력징후', '결막', '갑상샘'],
     'declaration': '활력징후와 결막을 보고 목의 갑상샘이 커지거나 아픈 곳이 없는지 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 결막 창백·갑상샘 비대·압통 없음.'},
    {'id': 'rest_tremor', 'label': '안정떨림 관찰', 'keywords': ['안정떨림', '손떨림', '떨림'],
     'declaration': '손을 무릎이나 탁자 위에 편하게 올려두신 상태에서 떨림을 관찰하겠습니다.', 'defaultFinding': '안정 시 뚜렷한 떨림 없음.'},
    {'id': 'postural_action_tremor', 'label': '자세·동작 떨림/글씨 검사', 'keywords': ['자세떨림', '동작떨림', '나선', '글씨', '손떨림'],
     'declaration': '팔을 앞으로 뻗고 손바닥을 편 다음, 나선을 그리고 글씨를 써 보시며 떨림을 확인하겠습니다.', 'defaultFinding': '양손에서 자세·동작 시 미세하고 대칭적인 떨림이 관찰되며 글씨가 약간 흔들립니다.'},
    {'id': 'neuro_motor', 'label': '뇌신경·근력·반사/근경직', 'keywords': ['뇌신경', '안구운동', '근력', '감각', '반사', '근경직'],
     'declaration': '안구운동과 얼굴 움직임, 팔·다리의 힘·감각·반사와 근육이 뻣뻣한지 확인하겠습니다.', 'defaultFinding': '뇌신경·근력·감각·반사 정상, 근경직 없음.'},
    {'id': 'coordination_gait', 'label': '협응·보행·균형 검사', 'keywords': ['손가락-코', '교대운동', '보행', 'Tandem', 'Romberg', '소뇌'],
     'declaration': '손가락-코 검사와 빠른 교대운동, 일자 걷기와 균형 검사를 해보겠습니다.', 'defaultFinding': '손가락-코·빠른 교대운동·보행·Tandem/Romberg 정상.'},
]

BREAST_PAIN_MASS_BUTTONS = [
    {'id': 'vitals_general', 'label': '활력징후/전신 상태', 'keywords': ['활력징후', '전신 상태'],
     'declaration': '활력징후와 전반적인 상태를 먼저 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 전신 상태 양호.'},
    {'id': 'breast_inspect', 'label': '유방 시진 (설명·동의)', 'keywords': ['유방 시진', '유방 피부', '유두', '피부 함몰'],
     'declaration': '진찰 목적과 노출을 최소화하는 방법을 설명드리고, 동의하시면 앉은 자세에서 양쪽 유방 피부와 유두를 살펴보겠습니다.', 'defaultFinding': '동의 후 시행 시 양측 대칭, 피부 발적·함몰·유두 변화 없음.'},
    {'id': 'breast_palp', 'label': '유방 촉진 (설명·동의)', 'keywords': ['유방 촉진', '유방 멍울', '유방 종괴', '유방 압통'],
     'declaration': '누운 자세에서 유방을 체계적으로 만져 덩이와 압통을 확인하겠습니다. 괜찮으시면 시작하겠습니다.', 'defaultFinding': '왼쪽 유방 상외측에 약 2 cm의 경계가 비교적 분명하고 잘 움직이는 덩이가 촉지되며, 압통은 없습니다.'},
    {'id': 'axillary_nodes', 'label': '액와·쇄골상부 림프절 (설명·동의)', 'keywords': ['액와 림프절', '겨드랑이 림프절', '쇄골상부 림프절'],
     'declaration': '유방 주변 림프절도 확인하기 위해 겨드랑이와 쇄골 위를 촉진하겠습니다. 동의하시면 진행하겠습니다.', 'defaultFinding': '동의 후 시행 시 액와·쇄골상부 림프절 종대 없음.'},
    {'id': 'nipple_discharge', 'label': '유두 분비물 확인 (설명·동의)', 'keywords': ['유두 분비물', '유두', '분비물'],
     'declaration': '유두 분비물이 있는지 확인해야 한다면 이유를 설명드린 뒤, 동의하실 때만 확인하겠습니다.', 'defaultFinding': '자발적 유두 분비물 없음.'},
]

VAGINAL_DISCHARGE_BUTTONS = [
    {'id': 'vitals_abdomen', 'label': '활력징후/하복부 확인', 'keywords': ['활력징후', '하복부', '복부 촉진'],
     'declaration': '활력징후를 확인하고 배를 부드럽게 눌러 하복부 압통이 있는지 보겠습니다.', 'defaultFinding': '활력징후 안정, 하복부 압통·반발통 없음.'},
    {'id': 'external_genital', 'label': '외음부 시진 (설명·동의)', 'keywords': ['외음부', '질 분비물', '분비물'],
     'declaration': '진찰 목적과 노출 최소화 방법을 설명드리고, 동의와 원하시는 동반인 확인 후 외음부를 살펴보겠습니다.', 'defaultFinding': '동의 후 시행 시 외음부 궤양·심한 발적·부종 없음.'},
    {'id': 'speculum', 'label': '질경 진찰/검체 채취 (설명·동의)', 'keywords': ['질경', '질분비물', '자궁경부', '검체'],
     'declaration': '질과 자궁경부, 분비물을 확인하고 필요한 검체를 채취하기 위해 질경 진찰을 하겠습니다. 언제든 중단하실 수 있습니다.', 'defaultFinding': '동의 후 시행 시 묽고 회백색 분비물이 보이며 자궁경부 출혈·화농성 분비물은 없습니다.'},
    {'id': 'bimanual', 'label': '양손 골반진찰 (설명·동의)', 'keywords': ['양손 골반진찰', '양손 진찰', '골반 진찰', '내진', '자궁 압통', '부속기 압통'],
     'declaration': '자궁과 난소 주변 압통을 확인하기 위해 양손 골반진찰을 하겠습니다. 동의하시면 진행하겠습니다.', 'defaultFinding': '동의 후 시행 시 자궁·부속기·경부 이동 압통 없음.'},
]

MENSTRUAL_DISORDER_BUTTONS = [
    {'id': 'vitals_abdomen', 'label': '활력징후/결막·하복부 확인', 'keywords': ['활력징후', '결막', '하복부', '복부 촉진'],
     'declaration': '활력징후와 결막 창백을 보고, 배를 부드럽게 눌러 하복부 압통이 있는지 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 결막 창백·하복부 압통·반발통 없음.'},
    {'id': 'pregnancy_test', 'label': '임신 가능성/임신검사 설명', 'keywords': ['임신', '임신검사'],
     'declaration': '가임기 월경 이상에서는 먼저 임신 가능성을 확인하고, 동의하시면 임신검사를 시행하겠습니다.', 'defaultFinding': '임신 가능성 낮고 소변 임신검사 음성.'},
    {'id': 'speculum', 'label': '질경 진찰 (설명·동의)', 'keywords': ['질경', '자궁경부', '출혈', '질분비물'],
     'declaration': '출혈 원인을 확인하기 위해 질과 자궁경부를 살피는 진찰이 필요할 수 있습니다. 동의하시면 진행하고 언제든 중단하실 수 있습니다.', 'defaultFinding': '동의 후 시행 시 활동성 출혈·자궁경부 병변·비정상 분비물 없음.'},
    {'id': 'bimanual', 'label': '양손 골반진찰 (설명·동의)', 'keywords': ['양손 골반진찰', '양손 진찰', '골반 진찰', '내진', '자궁 압통', '부속기 압통'],
     'declaration': '자궁과 난소 주변의 압통이나 덩이를 확인하기 위해 양손 골반진찰을 하겠습니다. 동의하시면 진행하겠습니다.', 'defaultFinding': '동의 후 시행 시 자궁·부속기 종괴·압통·경부 이동 압통 없음.'},
]

ANTENATAL_CARE_BUTTONS = [
    {'id': 'vitals_edema', 'label': '혈압·체중·부종 확인', 'keywords': ['활력징후', '혈압', '체중', '부종'],
     'declaration': '혈압과 체중을 확인하고 손발 부종이 있는지 보겠습니다.', 'defaultFinding': '혈압 안정, 급격한 체중 증가·함요부종 없음.'},
    {'id': 'fundal_height', 'label': '자궁저부 높이 측정', 'keywords': ['자궁저부', '자궁 높이', '배 크기'],
     'declaration': '편안히 누우신 자세에서 자궁저부 높이를 측정해 임신 주수와 비교하겠습니다.', 'defaultFinding': '자궁저부 높이가 임신 주수에 대체로 부합합니다.'},
    {'id': 'leopold', 'label': 'Leopold 촉진', 'keywords': ['Leopold', '레오폴드', '태위', '태향'],
     'declaration': '복부를 부드럽게 촉진해 아기 위치를 확인하겠습니다.', 'defaultFinding': '태위·태향에서 특이소견 없습니다.'},
    {'id': 'fetal_heart', 'label': '태아 심음 확인', 'keywords': ['태아 심음', '태아 심박', '아기 심장소리'],
     'declaration': '도플러로 태아 심장소리를 확인하겠습니다.', 'defaultFinding': '태아 심박동이 규칙적으로 들립니다.'},
    {'id': 'urine_screen', 'label': '소변 단백·당 검사', 'keywords': ['소변검사', '요검사', '딥스틱'],
     'declaration': '산전 진찰의 일부로 소변 단백과 당을 확인하겠습니다.', 'defaultFinding': '소변 단백·당 음성.'},
]

DEVELOPMENTAL_DELAY_BUTTONS = [
    {'id': 'growth', 'label': '키·체중·두위/성장곡선', 'keywords': ['키', '체중', '두위', '성장곡선'],
     'declaration': '키와 몸무게, 머리둘레를 재고 성장곡선에서 변화를 확인하겠습니다.', 'defaultFinding': '키·체중·두위가 성장곡선의 추적 범위 안에 있습니다.'},
    {'id': 'development', 'label': '놀이·언어·사회성 관찰', 'keywords': ['발달 관찰', '운동 발달', '언어 발달', '사회성', '놀이'],
     'declaration': '아이와 놀이를 하며 눈맞춤·이해·표현 언어와 사회적 상호작용을 관찰하겠습니다.', 'defaultFinding': '두 단계 지시를 이해하나 자발적 두 단어 조합 표현이 적습니다.'},
    {'id': 'hearing_vision', 'label': '시청각 반응 확인', 'keywords': ['청력', '시력', '시청각'],
     'declaration': '소리와 시각 자극에 반응하는지, 이름을 부르면 돌아보는지 확인하겠습니다.', 'defaultFinding': '시청각 자극 반응은 대체로 적절합니다.'},
    {'id': 'neuro_gait', 'label': '신경·근긴장·보행 확인', 'keywords': ['신경', '근력', '근긴장', '반사', '보행'],
     'declaration': '팔다리 힘과 근육 긴장, 반사와 걸음걸이를 확인하겠습니다.', 'defaultFinding': '근력·근긴장·반사·보행에서 뚜렷한 이상 없습니다.'},
]

SUBSTANCE_MISUSE_BUTTONS = [
    {'id': 'vitals_consciousness', 'label': '활력징후·산소포화도·의식', 'keywords': ['활력징후', '산소포화도', '의식수준', '의식 상태'],
     'declaration': '혈압과 맥박, 호흡수, 체온, 산소포화도와 의식 상태를 먼저 확인하겠습니다.', 'defaultFinding': '활력징후와 산소포화도 안정, 의식은 명료합니다.'},
    {'id': 'pupil_neuro', 'label': '동공·신경·떨림·보행', 'keywords': ['동공', '신경', '근력', '반사', '떨림', '보행'],
     'declaration': '동공과 눈 움직임, 팔다리 힘과 반사, 떨림과 걸음걸이를 확인하겠습니다.', 'defaultFinding': '동공과 신경학적 진찰은 정상이며 가벼운 손떨림이 관찰됩니다.'},
    {'id': 'heart_lung', 'label': '심음·호흡음 청진', 'keywords': ['심음', '호흡음', '심폐'],
     'declaration': '심장 소리와 호흡음을 청진하겠습니다.', 'defaultFinding': '심음은 규칙적이고 호흡음은 깨끗합니다.'},
    {'id': 'skin_injury', 'label': '피부·주사 흔적 확인', 'keywords': ['피부', '주사 흔적', '자해 흔적'],
     'declaration': '동의를 구한 뒤 피부 손상과 주사 또는 자해 흔적이 있는지 필요한 범위에서 확인하겠습니다.', 'defaultFinding': '주사 흔적과 자해 흔적은 보이지 않습니다.'},
]

DOMESTIC_VIOLENCE_BUTTONS = [
    {'id': 'vitals_consciousness', 'label': '활력징후·의식·응급 손상', 'keywords': ['활력징후', '의식수준', '응급 손상'],
     'declaration': '활력징후와 의식 상태를 확인하고 즉시 치료가 필요한 손상이 있는지 먼저 보겠습니다.', 'defaultFinding': '활력징후 안정, 의식 명료하며 즉시 처치가 필요한 손상은 보이지 않습니다.'},
    {'id': 'skin_injury', 'label': '피부·사지 손상 (설명·동의)', 'keywords': ['피부', '사지', '손상', '멍'],
     'declaration': '환자분이 허용하시는 범위에서 피부와 팔다리의 상처를 확인하겠습니다. 언제든 중단하실 수 있습니다.', 'defaultFinding': '왼쪽 아래팔에 시기가 다른 타원형 멍 두 곳과 압통이 있으나 변형은 없습니다.'},
    {'id': 'head_neck', 'label': '머리·목·호흡/발성 확인', 'keywords': ['머리', '목', '호흡', '발성', '연하'],
     'declaration': '머리와 목의 손상을 보고 목소리, 호흡과 삼킴에 불편이 있는지 확인하겠습니다.', 'defaultFinding': '머리·목의 외상, 쉰목소리, 호흡·연하곤란은 없습니다.'},
    {'id': 'neuro', 'label': '신경학적 진찰', 'keywords': ['신경학적', '신경'],
     'declaration': '팔다리 힘과 감각, 동공과 보행을 포함한 신경학적 진찰을 하겠습니다.', 'defaultFinding': '신경학적 이상은 없습니다.'},
    {'id': 'chest_abdomen', 'label': '흉부·복부 손상 (설명·동의)', 'keywords': ['흉부', '복부'],
     'declaration': '동의하시면 가슴과 배의 압통이나 손상을 확인하겠습니다.', 'defaultFinding': '흉부·복부 압통과 외상 소견은 없습니다.'},
]

SEXUAL_VIOLENCE_BUTTONS = [
    {'id': 'vitals_consciousness', 'label': '활력징후·의식·응급 손상', 'keywords': ['활력징후', '의식수준', '응급 손상'],
     'declaration': '활력징후와 의식 상태를 확인하고 즉시 치료가 필요한 손상이 있는지 먼저 보겠습니다.', 'defaultFinding': '활력징후 안정, 의식 명료하며 즉시 처치가 필요한 손상은 보이지 않습니다.'},
    {'id': 'skin_injury', 'label': '전신·피부 손상 (설명·동의)', 'keywords': ['전신', '피부', '손상', '멍'],
     'declaration': '환자분이 허용하시는 범위에서 노출을 최소화하며 전신의 상처를 확인하겠습니다.', 'defaultFinding': '오른쪽 손목에 작은 멍과 압통이 있으나 변형은 없습니다.'},
    {'id': 'oral_exam', 'label': '구강 진찰 (설명·동의)', 'keywords': ['구강', '입안'],
     'declaration': '필요한 이유를 설명드리고 동의하시면 입안의 상처를 확인하겠습니다.', 'defaultFinding': '구강 점막의 출혈과 상처는 없습니다.'},
    {'id': 'external_genital', 'label': '외음부 진찰 (별도 동의)', 'keywords': ['외음부', '생식기'],
     'declaration': '외음부 진찰은 별도로 설명드린 뒤 동의하실 때만 시행하며 언제든 중단할 수 있습니다.', 'defaultFinding': '별도 동의 후 확인 시 외음부에 작은 표재성 찰과상과 국소 압통이 있습니다.'},
    {'id': 'specimen_exam', 'label': '접촉 부위 검체·골반 진찰 (별도 동의)', 'keywords': ['검체', '골반', '질경'],
     'declaration': '검체 채취와 골반 진찰의 목적을 각각 설명드리고 원하시는 절차에 별도로 동의를 받겠습니다.', 'defaultFinding': '선택한 검체를 채취했으며, 동의한 범위의 골반 진찰에서 활동성 출혈은 없습니다.'},
]

ANXIETY_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'thyroid_tremor', 'label': '갑상샘/손떨림', 'keywords': ['갑상샘', '손떨림'],
     'declaration': '갑상샘과 손떨림을 확인하겠습니다.', 'defaultFinding': '갑상샘·손떨림 정상.'},
    {'id': 'heart_lung', 'label': '심폐 청진', 'keywords': ['심장', '호흡', '심폐'],
     'declaration': '심장과 호흡음을 청진하겠습니다.', 'defaultFinding': '심음·호흡음 정상.'},
    {'id': 'mse', 'label': '정신상태 평가 (MSE)', 'keywords': ['정신상태', 'MSE'],
     'declaration': '지금 기분과 생각을 몇 가지 여쭤보며 상태를 살피겠습니다.', 'defaultFinding': '정신상태 특이소견 없음.'},
]

ALCOHOL_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'tremor_sweat', 'label': '손떨림/발한 (금단)', 'keywords': ['손떨림', '발한', '금단'],
     'declaration': '손을 앞으로 뻗어 떨림이 있는지 보겠습니다.', 'defaultFinding': '손떨림·발한 없음.'},
    {'id': 'abdomen_liver', 'label': '복부/간 촉진', 'keywords': ['복부', '간'],
     'declaration': '배를 촉진해 간 상태를 확인하겠습니다.', 'defaultFinding': '간비대 없음.'},
    {'id': 'jaundice', 'label': '황달/영양 확인', 'keywords': ['황달', '영양', '공막'],
     'declaration': '눈과 피부, 영양 상태를 확인하겠습니다.', 'defaultFinding': '황달 없음, 영양 양호.'},
]

MOOD_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'mse', 'label': '정신상태 평가 (MSE)', 'keywords': ['정신상태', 'MSE'],
     'declaration': '지금 기분과 생각을 몇 가지 여쭤보며 상태를 살피겠습니다.', 'defaultFinding': '정신상태 특이소견 없음.'},
    {'id': 'thyroid', 'label': '갑상샘 촉진', 'keywords': ['갑상샘'],
     'declaration': '목 앞쪽 갑상샘을 촉진하겠습니다.', 'defaultFinding': '갑상샘 비대 없음.'},
    {'id': 'general', 'label': '전신 상태 확인', 'keywords': ['전신', '전반'],
     'declaration': '전반적인 몸 상태를 확인하겠습니다.', 'defaultFinding': '특이소견 없음.'},
]

SUICIDE_BUTTONS = [
    {'id': 'bp', 'label': '혈압/활력징후', 'keywords': ['활력징후'],
     'declaration': '활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상.'},
    {'id': 'self_harm', 'label': '자해 흔적 확인', 'keywords': ['자해'],
     'declaration': '실례가 안 된다면 팔을 잠깐 살펴보겠습니다.', 'defaultFinding': '자해 흔적 없음.'},
    {'id': 'mse', 'label': '정신상태 평가 (MSE)', 'keywords': ['정신상태', '절망감'],
     'declaration': '지금 마음 상태를 몇 가지 여쭤보며 살피겠습니다.', 'defaultFinding': '정신상태 특이소견 없음.'},
]

CHEST_PAIN_BUTTONS = [
    {'id': 'vitals', 'label': '생명징후/SpO2', 'keywords': ['생명징후', '산소포화도', '활력'],
     'declaration': '혈압과 맥박, 호흡수, 산소포화도를 확인하겠습니다.', 'defaultFinding': '생명징후 안정적.'},
    {'id': 'chest_palp', 'label': '흉부 시진/촉진', 'keywords': ['흉벽', '흉부 시진', '촉진'],
     'declaration': '가슴을 살펴보고 눌러서 아픈 곳이 있는지 확인하겠습니다.', 'defaultFinding': '흉벽 압통 없음.'},
    {'id': 'heart_ausc', 'label': '심음 청진', 'keywords': ['심음'],
     'declaration': '심장 소리를 청진하겠습니다.', 'defaultFinding': '심음 규칙적, 잡음 없음.'},
    {'id': 'lung_ausc', 'label': '호흡음 청진 (양측)', 'keywords': ['호흡음'],
     'declaration': '양쪽 숨소리를 비교해 청진하겠습니다.', 'defaultFinding': '양측 호흡음 대칭, 깨끗함.'},
    {'id': 'both_arm', 'label': '양팔 혈압/말초맥박', 'keywords': ['양팔', '말초'],
     'declaration': '양쪽 팔의 혈압과 맥박을 비교하겠습니다.', 'defaultFinding': '양팔 차이 없음, 맥박 대칭.'},
    {'id': 'ecg', 'label': '심전도 검사', 'keywords': ['심전도'],
     'declaration': '심전도 검사를 하겠습니다.', 'defaultFinding': '정상 동율동.'},
]

DYSPNEA_BUTTONS = [
    {'id': 'vitals', 'label': '생체징후/SpO2', 'keywords': ['생체징후', '산소포화도', '활력'],
     'declaration': '혈압과 맥박, 호흡수, 산소포화도를 확인하겠습니다.', 'defaultFinding': '생체징후 정상.'},
    {'id': 'chest_exam', 'label': '흉부 진찰 (시진~청진)', 'keywords': ['흉부', '호흡음', '타진'],
     'declaration': '가슴을 살펴보고 두드리고 숨소리를 청진하겠습니다.', 'defaultFinding': '흉곽 대칭, 호흡음 깨끗함.'},
    {'id': 'conjunctiva', 'label': '결막 확인', 'keywords': ['결막', '빈혈'],
     'declaration': '빈혈이 있는지 눈 결막을 확인하겠습니다.', 'defaultFinding': '결막 창백 없음.'},
    {'id': 'neck', 'label': '경부 (갑상샘/JVD)', 'keywords': ['경정맥', '갑상샘', '림프절'],
     'declaration': '목의 갑상샘과 정맥 팽창을 확인하겠습니다.', 'defaultFinding': '갑상샘 정상, JVD 없음.'},
    {'id': 'limbs', 'label': '사지 (부종/곤봉지/청색증)', 'keywords': ['부종', '곤봉지', '청색증', '사지'],
     'declaration': '다리 부종과 손가락 끝 모양, 입술 색을 확인하겠습니다.', 'defaultFinding': '부종·곤봉지·청색증 없음.'},
    {'id': 'neuro', 'label': '신경학적 확인', 'keywords': ['신경', '근력', '쇠약'],
     'declaration': '전신 근력과 신경학적 상태를 확인하겠습니다.', 'defaultFinding': '정상.'},
]

HTN_BUTTONS = [
    {'id': 'bp_proper', 'label': '혈압 재측정 (올바른 방법)', 'keywords': ['혈압 재측정', '재측정', '혈압 측정'],
     'declaration': '5분 안정 후 올바른 자세로 혈압을 다시 재보겠습니다.', 'defaultFinding': '재측정 혈압 정상 범위.'},
    {'id': 'both_arm', 'label': '양팔 혈압 비교', 'keywords': ['양팔'],
     'declaration': '양쪽 팔의 혈압을 비교하겠습니다.', 'defaultFinding': '양팔 차이 없음.'},
    {'id': 'heart', 'label': '심장 청진/촉진', 'keywords': ['심장'],
     'declaration': '심장을 청진하고 심첨박동을 확인하겠습니다.', 'defaultFinding': '심음 정상, 심첨박동 정상 위치.'},
    {'id': 'peripheral', 'label': '말초/대퇴 맥박', 'keywords': ['말초', '대퇴'],
     'declaration': '팔다리의 맥박을 확인하겠습니다.', 'defaultFinding': '말초·대퇴 맥박 대칭.'},
    {'id': 'abdomen_bruit', 'label': '복부 청진/촉진 (잡음)', 'keywords': ['복부'],
     'declaration': '배에서 혈관 잡음이 들리는지 청진하겠습니다.', 'defaultFinding': '복부 잡음 없음.'},
    {'id': 'target_organ', 'label': '안저/부종 (표적기관)', 'keywords': ['안저', '표적기관', '부종'],
     'declaration': '눈 안쪽 혈관과 다리 부종을 확인하겠습니다.', 'defaultFinding': '안저 정상, 부종 없음.'},
]

ACUTE_ABDOMEN_BUTTONS = [
    {'id': 'vitals', 'label': '활력징후/탈수 평가', 'keywords': ['활력', '탈수'],
     'declaration': '혈압과 맥박, 체온을 재고 탈수 정도를 확인하겠습니다.', 'defaultFinding': '활력 안정, 탈수 없음.'},
    {'id': 'position', 'label': '진찰 자세 (눕히고 무릎)', 'keywords': ['자세', '무릎'],
     'declaration': '침대에 바로 누워 무릎을 세워주세요. 오른쪽에서 진찰하겠습니다.', 'defaultFinding': '자세 협조됨.'},
    {'id': 'inspect', 'label': '복부 시진', 'keywords': ['시진', '팽만'],
     'declaration': '배 모양과 움직임을 살펴보겠습니다.', 'defaultFinding': '팽만·수술 흉터 없음.'},
    {'id': 'auscult', 'label': '복부 청진', 'keywords': ['청진'],
     'declaration': '배에서 장 움직이는 소리를 들어보겠습니다.', 'defaultFinding': '장음 정상.'},
    {'id': 'palp', 'label': '복부 촉진 (압통/반발통)', 'keywords': ['촉진', '압통', '반발통'],
     'declaration': '배를 부드럽게 눌러 아픈 곳과 반발통을 확인하겠습니다.', 'defaultFinding': '압통·반발통 없음.'},
    {'id': 'percuss', 'label': '복부 타진', 'keywords': ['타진'],
     'declaration': '배를 가볍게 두드려 보겠습니다.', 'defaultFinding': '타진음 정상.'},
    {'id': 'special', 'label': '특수 징후 (Murphy 등)', 'keywords': ['특수', 'Murphy', 'Rovsing', 'Psoas'],
     'declaration': '의심되는 부위에 특수 검사를 해보겠습니다.', 'defaultFinding': '특수 징후 음성.'},
]

HEMATEMESIS_BUTTONS = [
    {'id': 'vitals', 'label': '활력징후/기립 증상', 'keywords': ['활력징후', '기립'],
     'declaration': '혈압과 맥박, 호흡수, 산소포화도를 확인하고 일어설 때 어지러운지도 보겠습니다.', 'defaultFinding': '활력징후 안정, 기립 시 어지럼 없음.'},
    {'id': 'general', 'label': '전신 상태/의식', 'keywords': ['전반적 외견', '전반 신체', '전반 신체 상태'],
     'declaration': '창백하거나 식은땀이 나는지, 의식 상태를 확인하겠습니다.', 'defaultFinding': '의식 명료하고 전신 상태 안정적.'},
    {'id': 'eye', 'label': '결막/공막 확인', 'keywords': ['결막', '공막'],
     'declaration': '빈혈과 황달 단서가 있는지 결막과 공막을 확인하겠습니다.', 'defaultFinding': '결막 창백·공막 황달 없음.'},
    {'id': 'oral_nasal', 'label': '구강·비강 출혈 확인', 'keywords': ['구강', '비강 출혈'],
     'declaration': '입안이나 코에서 난 피를 삼킨 것은 아닌지 구강과 비강을 확인하겠습니다.', 'defaultFinding': '구강·비강의 활동성 출혈 없음.'},
    {'id': 'abdomen_inspect', 'label': '복부 시진/장음', 'keywords': ['복부 시진', '장음'],
     'declaration': '배 모양을 살피고 장 움직이는 소리를 들어보겠습니다.', 'defaultFinding': '복부 팽만 없고 장음 정상.'},
    {'id': 'abdomen_palp', 'label': '복부 촉진', 'keywords': ['복부 촉진'],
     'declaration': '배를 부드럽게 눌러 아픈 곳이나 단단한 곳이 있는지 확인하겠습니다.', 'defaultFinding': '압통·반발통·종괴 없음.'},
    {'id': 'dre', 'label': '직장수지검사 (동의)', 'keywords': ['직장수지검사'],
     'declaration': '검은 변 여부를 확인하기 위해 이유를 설명드린 뒤, 동의하시면 직장수지검사를 하겠습니다.', 'defaultFinding': '동의 후 시행 시 뚜렷한 흑색변·선혈 없음.'},
]

HEMATOCHEZIA_BUTTONS = [
    {'id': 'vitals', 'label': '활력징후/기립 증상', 'keywords': ['활력징후', '기립'],
     'declaration': '혈압과 맥박, 호흡수, 산소포화도를 확인하고 일어설 때 어지러운지도 보겠습니다.', 'defaultFinding': '활력징후 안정, 기립 시 어지럼 없음.'},
    {'id': 'general', 'label': '전신 상태/결막', 'keywords': ['전반적 외견', '전신', '결막'],
     'declaration': '창백하거나 식은땀이 나는지, 결막과 전신 상태를 확인하겠습니다.', 'defaultFinding': '의식 명료하고 결막 창백 없음.'},
    {'id': 'abdomen_inspect', 'label': '복부 시진/장음', 'keywords': ['복부 시진', '장음'],
     'declaration': '배 모양을 살피고 장 움직이는 소리를 들어보겠습니다.', 'defaultFinding': '복부 팽만 없고 장음 정상.'},
    {'id': 'abdomen_palp', 'label': '복부 촉진', 'keywords': ['복부 촉진'],
     'declaration': '배를 부드럽게 눌러 아픈 곳이나 단단한 곳이 있는지 확인하겠습니다.', 'defaultFinding': '압통·반발통·종괴 없음.'},
    {'id': 'perianal', 'label': '항문 주위 시진 (동의)', 'keywords': ['항문 주위', '항문'],
     'declaration': '출혈 원인을 확인하기 위해 이유를 설명드린 뒤, 동의하시면 항문 주위를 살펴보겠습니다.', 'defaultFinding': '동의 후 시행 시 뚜렷한 항문 주위 병변 없음.'},
    {'id': 'dre', 'label': '직장수지검사 (동의)', 'keywords': ['직장수지검사'],
     'declaration': '직장 안의 출혈 여부를 확인하기 위해 이유를 설명드린 뒤, 동의하시면 직장수지검사를 하겠습니다.', 'defaultFinding': '동의 후 시행 시 뚜렷한 선혈·종괴 없음.'},
]

VOMITING_BUTTONS = [
    {'id': 'vitals', 'label': '활력징후/탈수 평가', 'keywords': ['활력징후', '탈수'],
     'declaration': '혈압과 맥박, 체온을 재고 탈수 징후를 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 뚜렷한 탈수 없음.'},
    {'id': 'general', 'label': '전신 상태/의식', 'keywords': ['전반적 외견', '전신 상태', '의식'],
     'declaration': '전반적인 상태와 의식이 또렷한지 확인하겠습니다.', 'defaultFinding': '의식 명료하고 전신 상태 안정적.'},
    {'id': 'oral', 'label': '구강 점막/피부 확인', 'keywords': ['구강', '점막', '피부'],
     'declaration': '입안이 마르거나 피부가 건조한지 확인하겠습니다.', 'defaultFinding': '구강 점막이 촉촉하고 피부 긴장도 정상.'},
    {'id': 'abdomen_inspect', 'label': '복부 시진/장음', 'keywords': ['복부 시진', '장음'],
     'declaration': '배 모양을 살피고 장 움직이는 소리를 들어보겠습니다.', 'defaultFinding': '복부 팽만 없고 장음 정상.'},
    {'id': 'abdomen_palp', 'label': '복부 촉진', 'keywords': ['복부 촉진'],
     'declaration': '배를 부드럽게 눌러 아픈 곳이나 단단한 곳이 있는지 확인하겠습니다.', 'defaultFinding': '압통·반발통·종괴 없음.'},
    {'id': 'neuro', 'label': '신경학적 상태 확인', 'keywords': ['신경', '의식'],
     'declaration': '두통이나 의식 변화가 없는지 포함해 간단한 신경학적 상태를 확인하겠습니다.', 'defaultFinding': '의식 명료, 국소 신경학적 이상 없음.'},
]

JAUNDICE_BUTTONS = [
    {'id': 'vitals', 'label': '활력징후/전신 상태', 'keywords': ['활력징후', '전반적 외견'], 'declaration': '활력징후와 전반적인 상태를 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 의식 명료.'},
    {'id': 'eye', 'label': '공막/결막 확인', 'keywords': ['공막', '결막'], 'declaration': '눈 흰자와 결막을 살펴 황달과 빈혈 단서를 확인하겠습니다.', 'defaultFinding': '공막 황달·결막 창백 없음.'},
    {'id': 'hands', 'label': '피부/손바닥 관찰', 'keywords': ['피부', '손바닥', '손'], 'declaration': '피부와 손바닥의 황달·긁힌 자국·출혈 반점을 확인하겠습니다.', 'defaultFinding': '피부 황달·출혈 반점·긁힌 자국 없음.'},
    {'id': 'abdomen_inspect', 'label': '복부 시진/장음', 'keywords': ['복부 시진', '장음', '복수'], 'declaration': '배 모양과 장음을 확인하고 복수가 있는지 살펴보겠습니다.', 'defaultFinding': '팽만·복수 없고 장음 정상.'},
    {'id': 'abdomen_palp', 'label': '복부 촉진/간·담낭', 'keywords': ['복부 촉진', '간', '담낭', 'Murphy', 'Courvoisier'], 'declaration': '오른쪽 윗배와 간·담낭 부위를 부드럽게 촉진하겠습니다.', 'defaultFinding': '압통·간비대·종괴 없음.'},
    {'id': 'neuro', 'label': '의식/손떨림 확인', 'keywords': ['의식', 'flapping', '신경'], 'declaration': '의식 상태와 손을 폈을 때 떨림이 있는지 확인하겠습니다.', 'defaultFinding': '의식 명료, flapping tremor 없음.'},
]

DYSPLIPIDEMIA_BUTTONS = [
    {'id': 'vitals_body', 'label': '활력징후/체형·허리둘레', 'keywords': ['활력징후', '체형', '허리둘레'],
     'declaration': '활력징후와 키·몸무게, 허리둘레를 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 체형과 허리둘레는 정상 범위.'},
    {'id': 'eye_skin', 'label': '눈·피부 황색종 확인', 'keywords': ['황색종', '황색판종', '각막환', '눈 주위', '손바닥'],
     'declaration': '눈 주위와 눈 흰자, 손바닥·힘줄에 노란 침착이 있는지 살펴보겠습니다.', 'defaultFinding': '황색종·황색판종·각막환이 보이지 않습니다.'},
    {'id': 'thyroid_skin', 'label': '갑상샘/피부 확인', 'keywords': ['갑상샘', '피부 건조'],
     'declaration': '목 앞쪽 갑상샘과 피부가 건조한지 확인하겠습니다.', 'defaultFinding': '갑상샘 비대 없고 피부 건조 소견 없습니다.'},
    {'id': 'carotid_heart', 'label': '경동맥/심음/맥박 청진', 'keywords': ['경동맥', '심음', '말초 맥박'],
     'declaration': '목 혈관 잡음과 심장 소리, 팔다리 맥박을 확인하겠습니다.', 'defaultFinding': '경동맥 잡음 없고 심음과 말초 맥박이 정상입니다.'},
    {'id': 'abdomen_edema', 'label': '복부/하지 부종 확인', 'keywords': ['복부', '간비대', '복수', '하지 부종'],
     'declaration': '배를 진찰해 간이 커졌는지 보고 다리 부종도 확인하겠습니다.', 'defaultFinding': '간비대·복수·하지 함요부종이 없습니다.'},
]

HEMOPTYSIS_BUTTONS = [
    {'id': 'vitals_o2', 'label': '활력징후/산소포화도·의식', 'keywords': ['활력징후', '산소포화도', '전신 상태', '의식'],
     'declaration': '혈압·맥박·산소포화도와 의식이 또렷한지 먼저 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 산소포화도 정상, 의식 명료.'},
    {'id': 'upper_airway', 'label': '코·구강·인두/결막 확인', 'keywords': ['비강', '구강', '인두', '결막'],
     'declaration': '코피나 잇몸 출혈이 아닌지 코와 입 안, 결막을 확인하겠습니다.', 'defaultFinding': '비강·구강·인두 출혈 및 결막 창백 없음.'},
    {'id': 'neck_skin', 'label': '경부 림프절/피부 출혈 확인', 'keywords': ['림프절', '점상출혈', '멍', '피부 출혈'],
     'declaration': '목의 림프절과 피부에 멍이나 출혈 반점이 있는지 보겠습니다.', 'defaultFinding': '경부 림프절 종대·점상출혈·멍 없음.'},
    {'id': 'chest_exam', 'label': '흉부 시진·타진·호흡음 청진', 'keywords': ['흉부', '호흡음', '폐 청진', '타진'],
     'declaration': '가슴을 살피고 두드린 뒤 양쪽 호흡음을 청진하겠습니다.', 'defaultFinding': '흉곽 대칭, 호흡음 깨끗하고 타진음 정상.'},
    {'id': 'abdomen_limbs', 'label': '복부/간비장·다리 확인', 'keywords': ['복부', '간비장', '부종', '곤봉지', '청색증'],
     'declaration': '배를 진찰해 간과 비장이 커졌는지 보고, 다리 부종과 손끝도 확인하겠습니다.', 'defaultFinding': '간비장 비대·복수·하지 부종·곤봉지·청색증 없음.'},
]

POLYURIA_BUTTONS = [
    {'id': 'vitals_hydration', 'label': '활력징후/탈수·구강 점막', 'keywords': ['활력징후', '탈수', '구강 점막'], 'declaration': '활력징후와 탈수, 입안이 마른지 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 뚜렷한 탈수·구강 건조 없음.'},
    {'id': 'eye_skin_edema', 'label': '결막/피부·하지 부종', 'keywords': ['결막', '피부', '하지 부종'], 'declaration': '결막과 피부, 다리 부종을 확인하겠습니다.', 'defaultFinding': '결막 창백·피부 이상·하지 부종 없음.'},
    {'id': 'abdomen_bladder', 'label': '복부/방광·CVA 압통', 'keywords': ['복부', '방광', 'CVA', '늑골척추각'], 'declaration': '배와 방광이 팽만한지 보고 옆구리 압통도 확인하겠습니다.', 'defaultFinding': '복부 종괴·방광 팽만·CVA 압통 없음.'},
    {'id': 'neuro_vision', 'label': '시야/신경학적 확인', 'keywords': ['시야', '신경'], 'declaration': '시야 변화와 간단한 신경학적 상태를 확인하겠습니다.', 'defaultFinding': '시야·신경학적 이상 없음.'},
]

OLIGURIA_BUTTONS = [
    {'id': 'vitals_hydration', 'label': '활력징후/탈수·구강 점막', 'keywords': ['활력징후', '탈수', '구강 점막'], 'declaration': '혈압·맥박과 탈수, 입안이 마른지 확인하겠습니다.', 'defaultFinding': '활력징후 안정, 뚜렷한 탈수·구강 건조 없음.'},
    {'id': 'edema_conjunctiva', 'label': '결막/피부·하지 부종', 'keywords': ['결막', '피부', '하지 부종'], 'declaration': '결막과 피부 상태, 다리 부종을 확인하겠습니다.', 'defaultFinding': '결막 창백·피부 출혈·하지 부종 없음.'},
    {'id': 'heart_lung', 'label': '심음/호흡음·경정맥', 'keywords': ['심음', '호흡음', '경정맥'], 'declaration': '심장과 호흡음을 듣고 목정맥이 팽창했는지 보겠습니다.', 'defaultFinding': '심음·호흡음 정상, 경정맥 팽대 없음.'},
    {'id': 'abdomen_bladder', 'label': '복부/방광·CVA 압통', 'keywords': ['복부', '방광', 'CVA', '늑골척추각'], 'declaration': '배와 방광이 팽만한지 보고 옆구리 압통도 확인하겠습니다.', 'defaultFinding': '복부 종괴·방광 팽만·CVA 압통 없음.'},
]

# category → 버튼 세트. 미등록 카테고리는 수면 세트로 폴백(기존 동작 보존).
BAD_NEWS_BUTTONS = [
    {'id': 'vitals', 'label': '활력징후 확인', 'keywords': ['활력징후', '혈압', '맥박'],
     'declaration': '먼저 혈압과 맥박 등 활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상 범위입니다.'},
    {'id': 'general_condition', 'label': '전신 상태 확인', 'keywords': ['전신 상태', '안색', '외양'],
     'declaration': '전반적인 상태와 안색을 살펴보겠습니다.', 'defaultFinding': '급성 병색은 없습니다.'},
]

VACCINATION_BUTTONS = [
    {'id': 'vitals_temp', 'label': '활력징후·체온 확인', 'keywords': ['활력징후', '체온', '발열', '생체 징후'],
     'declaration': '접종 전에 체온과 활력징후를 확인하겠습니다.', 'defaultFinding': '체온 정상, 활력징후 안정적입니다.'},
    {'id': 'growth_status', 'label': '발육·전신 상태 확인', 'keywords': ['발육', '체중', '신장', '두위', '전신 상태', '전반적인 상태'],
     'declaration': '체중과 키 등 발육 상태와 전반적인 상태를 확인하겠습니다.', 'defaultFinding': '발육과 전신 상태 양호합니다.'},
    {'id': 'throat_skin', 'label': '인후·피부 확인', 'keywords': ['인후', '목 안', '피부', '발진'],
     'declaration': '목 안과 피부에 급성 질환의 징후가 없는지 확인하겠습니다.', 'defaultFinding': '인후·피부 특이소견 없습니다.'},
]

SMOKING_BUTTONS = [
    {'id': 'vitals', 'label': '활력징후 확인', 'keywords': ['활력징후', '혈압', '맥박', '생체 징후'],
     'declaration': '혈압과 맥박 등 활력징후를 확인하겠습니다.', 'defaultFinding': '활력징후 정상 범위입니다.'},
    {'id': 'oral_finger', 'label': '구강·손가락 확인', 'keywords': ['구강', '치아', '착색', '손가락', '변색'],
     'declaration': '입안 치아 착색과 손가락 변색 등 흡연 흔적을 확인하겠습니다.', 'defaultFinding': '치아 착색과 손가락 변색이 관찰됩니다.'},
    {'id': 'lung_sound', 'label': '호흡음 청진', 'keywords': ['호흡음', '청진', '폐'],
     'declaration': '가슴에서 호흡음을 청진하겠습니다.', 'defaultFinding': '호흡음 깨끗합니다.'},
    {'id': 'co_test', 'label': '호기 일산화탄소 측정', 'keywords': ['일산화탄소', 'CO', '코티닌'],
     'declaration': '내쉬는 숨의 일산화탄소 농도를 측정하겠습니다.', 'defaultFinding': '호기 일산화탄소가 흡연자 수준으로 상승해 있습니다.'},
]

BUTTON_SETS = {
    '수면장애': SLEEP_BUTTONS,
    '두통': HEADACHE_BUTTONS,
    '어지럼': DIZZINESS_BUTTONS,
    '피로': FATIGUE_BUTTONS,
    '소화불량/만성복통': DYSPEPSIA_BUTTONS,
    '실신': SYNCOPE_BUTTONS,
    '두근거림': PALPITATION_BUTTONS,
    '기억력 저하': MEMORY_BUTTONS,
    '허리 통증': BACKPAIN_BUTTONS,
    '발열': FEVER_BUTTONS,
    '체중 감소': WEIGHT_LOSS_BUTTONS,
    '기침': COUGH_BUTTONS,
    '관절 통증': JOINT_BUTTONS,
    '변비': CONSTIPATION_BUTTONS,
    '설사': DIARRHEA_BUTTONS,
    '콧물/코막힘': RHINORRHEA_BUTTONS,
    '목 통증': NECK_BUTTONS,
    '배뇨 이상': URINARY_BUTTONS,
    '붉은색 소변': RED_URINE_BUTTONS,
    '불안': ANXIETY_BUTTONS,
    '음주 문제': ALCOHOL_BUTTONS,
    '기분 변화': MOOD_BUTTONS,
    '자살': SUICIDE_BUTTONS,
    '가슴 통증': CHEST_PAIN_BUTTONS,
    '호흡곤란': DYSPNEA_BUTTONS,
    '고혈압': HTN_BUTTONS,
    '급성 복통': ACUTE_ABDOMEN_BUTTONS,
    '토혈': HEMATEMESIS_BUTTONS,
    '혈변': HEMATOCHEZIA_BUTTONS,
    '구토': VOMITING_BUTTONS,
    '황달': JAUNDICE_BUTTONS,
    '이상지질혈증': DYSPLIPIDEMIA_BUTTONS,
    '객혈': HEMOPTYSIS_BUTTONS,
    '다뇨': POLYURIA_BUTTONS,
    '핍뇨': OLIGURIA_BUTTONS,
    '요실금': INCONTINENCE_BUTTONS,
    '쉽게 멍이 듦': EASY_BRUISING_BUTTONS,
    '체중 증가': WEIGHT_GAIN_BUTTONS,
    '피부 발진': SKIN_RASH_BUTTONS,
    '경련': CONVULSION_BUTTONS,
    '팔다리 근력 약화 및 감각 이상': WEAKNESS_PARESTHESIA_BUTTONS,
    '의식장애': CLOUDED_CONSCIOUSNESS_BUTTONS,
    '손떨림': HAND_TREMOR_BUTTONS,
    '유방통/유방덩이': BREAST_PAIN_MASS_BUTTONS,
    '질 분비물': VAGINAL_DISCHARGE_BUTTONS,
    '월경 이상/월경통': MENSTRUAL_DISORDER_BUTTONS,
    '산전 진찰': ANTENATAL_CARE_BUTTONS,
    '발달 지연': DEVELOPMENTAL_DELAY_BUTTONS,
    '물질 오남용': SUBSTANCE_MISUSE_BUTTONS,
    '가정폭력': DOMESTIC_VIOLENCE_BUTTONS,
    '성폭력': SEXUAL_VIOLENCE_BUTTONS,
    '나쁜소식 전하기': BAD_NEWS_BUTTONS,
    '예방접종': VACCINATION_BUTTONS,
    '금연 상담': SMOKING_BUTTONS,
}


def buttons_for(case: dict | None) -> list[dict]:
    category = (case or {}).get('category', '수면장애')
    return BUTTON_SETS.get(category, SLEEP_BUTTONS)


def _body_region_for_button(case: dict | None, button: dict) -> tuple[str, str, str]:
    """케이스별 진찰 방법을 사용자에게 보이는 신체 부위로 묶는다.

    기존 버튼 데이터의 호환성을 유지하면서도 UI가 `부위 선택 → 방법 선택`을 제공하도록
    파생 메타데이터를 만든다. ``avatarTarget``은 누운 환자 모델의 카메라 초점이다.
    """
    category = (case or {}).get('category', '')
    button_id = button['id']
    label = button['label']

    if button_id in {'bp', 'vitals', 'bp_proper', 'general', 'hydration', 'vitals_body', 'vitals_o2', 'vitals_hydration'}:
        return 'general', '전신·활력', 'chest'
    if category == '허리 통증':
        if button_id in {'spine_inspect', 'palpation'}:
            return 'back', '허리·척추', 'pelvis'
        if button_id in {'slr', 'neuro_leg', 'gait'}:
            return 'legs', '다리·발·신경', 'legs'
    if category == '관절 통증':
        if button_id == 'skin_eye':
            return 'head_neck', '머리·눈', 'head'
        return 'legs', '다리·발·관절', 'legs'
    if category == '이상지질혈증' and button_id == 'abdomen_edema':
        return 'abdomen', '복부·다리', 'abdomen'
    if category == '객혈' and button_id == 'abdomen_limbs':
        return 'abdomen', '복부·다리', 'abdomen'
    if category == '다뇨' and button_id == 'abdomen_bladder':
        return 'abdomen', '복부·방광', 'abdomen'
    if category == '핍뇨' and button_id == 'abdomen_bladder':
        return 'abdomen', '복부·방광', 'abdomen'
    if category == '요실금' and button_id == 'lower_abdomen':
        return 'abdomen', '복부·방광', 'abdomen'
    if category == '요실금' and button_id == 'pelvic_floor':
        return 'pelvis', '골반저', 'pelvis'
    if category == '쉽게 멍이 듦' and button_id == 'skin_bruise':
        return 'skin', '피부', 'chest'
    if category == '쉽게 멍이 듦' and button_id == 'abdomen_liver_spleen':
        return 'abdomen', '복부·간비장', 'abdomen'
    if category == '체중 증가' and button_id == 'abdomen_edema':
        return 'abdomen', '복부·다리', 'abdomen'
    if category == '피부 발진' and button_id in {'rash_inspection', 'rash_palpation'}:
        return 'skin', '피부', 'chest'
    if category == '경련' and button_id in {'eye_oral', 'meningeal'}:
        return 'head_neck', '머리·눈·목', 'head'
    if category == '팔다리 근력 약화 및 감각 이상' and button_id == 'cranial_neuro':
        return 'head_neck', '머리·눈·얼굴', 'head'
    if category == '의식장애' and button_id == 'pupil_oral':
        return 'head_neck', '머리·눈·구강', 'head'
    if category == '손떨림':
        if button_id == 'vitals_thyroid':
            return 'head_neck', '전신·눈·목', 'head'
        if button_id in {'rest_tremor', 'postural_action_tremor'}:
            return 'arm', '팔·손목', 'chest'
        if button_id in {'neuro_motor', 'coordination_gait'}:
            return 'neuro', '신경계·보행', 'legs'
    if category == '유방통/유방덩이':
        if button_id == 'vitals_general':
            return 'general', '전신·활력', 'chest'
        return 'breast', '유방·액와', 'chest'
    if category == '질 분비물':
        if button_id == 'vitals_abdomen':
            return 'abdomen', '전신·하복부', 'abdomen'
        return 'pelvis', '골반·외음부', 'pelvis'
    if category == '월경 이상/월경통':
        if button_id in {'vitals_abdomen', 'pregnancy_test'}:
            return 'abdomen', '전신·하복부', 'abdomen'
        return 'pelvis', '골반·자궁', 'pelvis'
    if category == '산전 진찰':
        if button_id in {'vitals_edema', 'urine_screen'}:
            return 'general', '전신·활력', 'chest'
        return 'abdomen', '복부·태아', 'abdomen'
    if category == '발달 지연':
        if button_id == 'growth':
            return 'general', '전신·성장', 'chest'
        if button_id == 'development':
            return 'neuro', '발달·상호작용', 'head'
        return 'neuro', '신경계·보행', 'legs'
    if category == '물질 오남용':
        if button_id == 'vitals_consciousness':
            return 'general', '전신·활력', 'chest'
        if button_id == 'pupil_neuro':
            return 'neuro', '머리·신경계·보행', 'head'
        if button_id == 'skin_injury':
            return 'skin', '피부·팔', 'chest'
    if category == '가정폭력':
        if button_id == 'skin_injury':
            return 'skin', '피부·사지', 'chest'
        if button_id == 'head_neck':
            return 'head_neck', '머리·목', 'head'
        if button_id == 'chest_abdomen':
            return 'abdomen', '흉부·복부', 'abdomen'
    if category == '성폭력':
        if button_id == 'skin_injury':
            return 'skin', '전신·피부', 'chest'
        if button_id == 'oral_exam':
            return 'head_neck', '구강', 'head'
        if button_id in {'external_genital', 'specimen_exam'}:
            return 'pelvis', '골반·외음부', 'pelvis'
    if button_id in {'pulse', 'both_arm', 'peripheral', 'arm_neuro', 'self_harm', 'hands'}:
        return 'arm', '팔·손목', 'chest'
    if button_id in {'heart_lung', 'heart_ausc', 'lung_ausc', 'heart', 'chest_palp', 'chest_exam', 'ecg', 'carotid_heart'}:
        return 'chest', '흉부', 'chest'
    if button_id in {'meningeal', 'head_palpation', 'sinus', 'eye', 'fundus', 'hearing', 'nystagmus', 'dix_hallpike', 'eye_skin', 'upper_airway', 'eye_skin_edema', 'edema_conjunctiva'}:
        return 'head_neck', '머리·목', 'head'
    if button_id in {'neuro', 'mse'}:
        return 'neuro', '신경계·정신상태', 'legs'
    if button_id in {'spurling', 'rom'}:
        return 'neck', '목·어깨', 'neck'
    if button_id in {'flank'}:
        return 'back', '허리·옆구리', 'pelvis'

    if category == '혈변' and button_id in {'perianal', 'dre'}:
        return 'abdomen', '복부·항문', 'pelvis'

    digestive_categories = {'급성 복통', '소화불량/만성복통', '변비', '설사', '배뇨 이상', '붉은색 소변', '혈변', '황달'}
    if category in digestive_categories or button_id in {'abdomen', 'lower_abdomen', 'abdomen_liver', 'abdomen_bruit', 'abdomen_inspect', 'abdomen_palp', 'dre', 'position', 'inspect', 'auscult', 'palp', 'percuss', 'special'}:
        return 'abdomen', '복부', 'abdomen'
    if category in {'관절 통증'} or button_id in {'gait', 'edema', 'limbs'}:
        return 'legs', '다리·발·관절', 'legs'
    if category in {'목 통증'} or '목' in label or '갑상샘' in label or button_id == 'neck_skin':
        return 'neck', '목·어깨', 'neck'
    if category in {'기침', '호흡곤란', '가슴 통증', '객혈'}:
        return 'chest', '흉부', 'chest'
    return 'general', '전신·활력', 'chest'

# 비정상 소견을 시사하는 단어
_ABNORMAL_WORDS = ('비대', '폐쇄', '이상', '양성', '저하', '항진', '빈맥', '서맥', '부종', '늘어', '좁', '종괴', '압통 있', '잡음', '강직 (+', '높음')
# 부정된 표현은 비정상 단어 검사 전에 제거 ('이상 없음'의 '이상'이 비정상으로 오판되는 것 방지)
_NEGATED_PHRASES = ('이상 없음', '압통 없음', '문제 없음', '특이소견 없음', '부종 없음', '비대 없음',
                    '잡음 없음', '강직 없음', '마비 없음', '반사 없음', '충혈·눈물 없음', '발열 없음',
                    '종괴 없음', '종대 없음', '창백 없음', '황달 없음', '안진 없음', '난청 없음',
                    '저하 없음', '뚜렷하지 않음', '비대·종대 없음', '발적·부종·변형 없음',
                    '수양성')  # '수양성'은 '양성' 오매칭 방지용 선제거 (판정 중립 단어)


def _is_abnormal(pe: dict) -> bool:
    if pe.get('polarity') == 'positive':
        return True
    finding = pe.get('expectedFinding', '')
    stripped = finding
    for n in sorted(_NEGATED_PHRASES, key=len, reverse=True):  # 긴 구부터 제거 ('비대·종대 없음' > '종대 없음')
        stripped = stripped.replace(n, '')
    if any(w in stripped for w in _ABNORMAL_WORDS):
        return True
    # 명시적 정상/음성/부재 표현이 있으면 정상
    return not any(w in finding for w in ('정상', '없음', '깨끗', '음성', '않음', '안정적', '양호', '협조'))


def button_catalog(case: dict | None = None) -> list[dict]:
    catalog = []
    for button in buttons_for(case):
        body_region, body_region_label, avatar_target = _body_region_for_button(case, button)
        catalog.append({
            'id': button['id'],
            'label': button['label'],
            'bodyRegion': body_region,
            'bodyRegionLabel': body_region_label,
            'avatarTarget': avatar_target,
        })
    return catalog


def resolve_exam(case: dict, button_id: str) -> dict:
    """버튼 클릭 → 소견 카드. 케이스 physicalExamRule에서 매칭 소견을 모은다."""
    button = next((b for b in buttons_for(case) if b['id'] == button_id), None)
    if not button:
        raise KeyError(f'알 수 없는 진찰 버튼: {button_id}')

    findings = []
    for pe in case.get('physicalExamRule', []):
        haystack = f"{pe.get('item', '')} {pe.get('method', '')}"
        if any(kw in haystack for kw in button['keywords']):
            findings.append({
                'item': pe['item'],
                'method': pe['method'],
                'finding': pe['expectedFinding'],
                'abnormal': _is_abnormal(pe),
            })

    return {
        'buttonId': button_id,
        'label': button['label'],
        'declaration': button['declaration'],
        'findings': findings if findings else [{'item': button['label'], 'method': '', 'finding': button['defaultFinding'], 'abnormal': False}],
    }
