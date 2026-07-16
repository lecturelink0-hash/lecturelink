-- ====================================================================
-- 마스터 데이터 시드
-- ====================================================================
-- 학교, 과목, sub-topic 초기 데이터 삽입
-- 베타 단계에서 점진적으로 확장
-- ====================================================================

-- ──────────────────────────────────────────
-- 학교 (의대 일부 — 추후 확장)
-- ──────────────────────────────────────────
insert into public.schools (name, short_name, type) values
    ('서울대학교 의과대학', '서울대', 'medical'),
    ('연세대학교 의과대학', '연세대', 'medical'),
    ('고려대학교 의과대학', '고려대', 'medical'),
    ('성균관대학교 의과대학', '성균관대', 'medical'),
    ('울산대학교 의과대학', '울산대', 'medical'),
    ('가톨릭대학교 의과대학', '가톨릭대', 'medical'),
    ('한양대학교 의과대학', '한양대', 'medical'),
    ('경희대학교 의과대학', '경희대', 'medical'),
    ('중앙대학교 의과대학', '중앙대', 'medical'),
    ('이화여자대학교 의과대학', '이화여대', 'medical')
on conflict (name) do nothing;

-- ──────────────────────────────────────────
-- 과목 (MVP 단계 — 호흡기·순환기)
-- ──────────────────────────────────────────
insert into public.subjects (code, name, sort_order, is_active) values
    ('respiratory', '호흡기학', 10, true),
    ('cardiology', '순환기학', 20, true),
    ('gastroenterology', '소화기학', 30, false),  -- Phase 2
    ('nephrology', '신장학', 40, false),
    ('biochemistry', '생화학', 50, false),
    ('pathology', '병리학', 60, false),
    ('anatomy', '해부학', 70, false),
    ('pharmacology', '약리학', 80, false)
on conflict (code) do nothing;

-- ──────────────────────────────────────────
-- Sub-topics — 호흡기학
-- exam_relevance: 1(★) ~ 3(★★★)
-- is_risk_category: 환자 안전 직결 (응급·약물·금기)
-- ──────────────────────────────────────────
with respiratory as (select id from public.subjects where code = 'respiratory')
insert into public.sub_topics (subject_id, code, name, exam_relevance, is_risk_category, sort_order) values
    ((select id from respiratory), 'respiratory_physiology', '호흡 생리', 2, false, 10),
    ((select id from respiratory), 'copd_asthma', '폐쇄성 폐질환 (COPD·천식)', 3, true, 20),
    ((select id from respiratory), 'restrictive_lung', '제한성 폐질환', 2, false, 30),
    ((select id from respiratory), 'pneumothorax', '기흉', 3, true, 40),
    ((select id from respiratory), 'pleural_effusion', '흉수', 2, false, 50),
    ((select id from respiratory), 'pulmonary_embolism', '폐색전', 3, true, 60),
    ((select id from respiratory), 'lung_cancer', '폐암', 2, false, 70),
    ((select id from respiratory), 'lung_pathology', '폐 병리학', 2, false, 80),
    ((select id from respiratory), 'lung_anatomy', '폐 해부·조직학', 1, false, 90),
    ((select id from respiratory), 'mediastinal', '종격동 질환', 1, false, 100),
    ((select id from respiratory), 'chest_xray', '흉부 X-ray 판독', 3, false, 110)
on conflict (subject_id, code) do nothing;

-- ──────────────────────────────────────────
-- Sub-topics — 순환기학
-- ──────────────────────────────────────────
with cardiology as (select id from public.subjects where code = 'cardiology')
insert into public.sub_topics (subject_id, code, name, exam_relevance, is_risk_category, sort_order) values
    ((select id from cardiology), 'ecg', 'ECG 판독', 3, false, 10),
    ((select id from cardiology), 'arrhythmia', '부정맥', 3, true, 20),
    ((select id from cardiology), 'heart_failure', '심부전', 2, false, 30),
    ((select id from cardiology), 'cad', '관상동맥질환', 3, true, 40),
    ((select id from cardiology), 'valvular', '판막질환', 2, false, 50),
    ((select id from cardiology), 'hypertension', '고혈압', 2, true, 60),
    ((select id from cardiology), 'cardiomyopathy', '심근병증', 1, false, 70),
    ((select id from cardiology), 'pericardial', '심막질환', 1, false, 80),
    ((select id from cardiology), 'congenital_heart', '선천성 심질환', 1, false, 90)
on conflict (subject_id, code) do nothing;
