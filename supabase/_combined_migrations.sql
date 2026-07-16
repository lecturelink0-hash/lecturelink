-- 렉처링크 통합 마이그레이션 (00001~00021, pg_cron(00011) 제외)
-- 새 Supabase 프로젝트 SQL Editor 에 전체 붙여넣고 Run


-- ====================== 00001_initial_schema.sql ======================
-- ====================================================================
-- Medical AI Learning Engine — 초기 스키마
-- ====================================================================
-- 의료 교육 특화 AI 학습 인프라의 핵심 데이터 모델
-- 마이그레이션 순서: 00001
-- ====================================================================

-- ──────────────────────────────────────────
-- 확장 활성화
-- ──────────────────────────────────────────
create extension if not exists "uuid-ossp";
create extension if not exists "vector";  -- pgvector for embeddings
create extension if not exists "pg_trgm"; -- text search

-- ──────────────────────────────────────────
-- ENUM 타입
-- ──────────────────────────────────────────

-- 학년
create type grade_level as enum (
    'pre_1',  -- 예과 1
    'pre_2',  -- 예과 2
    'med_1',  -- 본과 1
    'med_2',  -- 본과 2
    'med_3',  -- 본과 3
    'med_4'   -- 본과 4
);

-- 학기
create type semester_term as enum ('spring', 'fall');

-- 결제 플랜
create type plan_tier as enum ('free', 'lite', 'standard', 'pro');

-- 콘텐츠 출처
create type content_source as enum (
    'team_seed',         -- 팀 자체 제작 (위험 영역)
    'ai_generated',      -- AI 단독 생성
    'ai_user_triggered', -- 사용자 오답 기반 AI 생성
    'doctor_reviewed',   -- 의사 검수단 검수 완료
    'kmle_style_seed'    -- KMLE few-shot 학습용 시드
);

-- 콘텐츠 신뢰 등급 (UI 배지에 대응)
create type content_tier as enum (
    'curated',    -- 의사 검수 완료 (UI: ✓ 의사 검수 완료)
    'community',  -- AI 2-pass 검증 통과 (UI: AI 검증)
    'beta'        -- 검증 미완 베타 (UI: ⚠ 베타)
);

-- 콘텐츠 상태
create type content_status as enum ('active', 'flagged', 'deprecated');

-- 사용자 풀이 트랙
create type attempt_track as enum (
    'smart_practice',    -- 맞춤 풀이 (Track B)
    'lecture_note'       -- 내 강의 노트 (Track A)
);

-- 업로드 처리 상태
create type upload_status as enum (
    'uploaded',   -- 업로드 완료
    'processing', -- 처리 중
    'completed',  -- 분석 완료
    'failed'      -- 실패
);

-- 의료 이미지 유형
create type medical_image_type as enum (
    'xray',
    'ct',
    'mri',
    'ecg',
    'pathology',
    'microscope',
    'ultrasound',
    'other'
);

-- ──────────────────────────────────────────
-- 마스터 테이블
-- ──────────────────────────────────────────

-- 학교
create table public.schools (
    id          uuid primary key default uuid_generate_v4(),
    name        text not null unique,         -- 예: '서울대학교 의과대학'
    short_name  text not null,                -- 예: '서울대'
    type        text not null default 'medical', -- medical / nursing / dental ...
    created_at  timestamptz not null default now()
);

create index idx_schools_type on public.schools(type);

-- 과목 마스터 (호흡기, 순환기, ...)
create table public.subjects (
    id          uuid primary key default uuid_generate_v4(),
    code        text not null unique,         -- 예: 'respiratory'
    name        text not null,                -- 예: '호흡기학'
    sort_order  smallint not null default 0,
    is_active   boolean not null default true,
    created_at  timestamptz not null default now()
);

-- Sub-topic 마스터 (호흡 생리, 폐쇄성 폐질환, ...)
create table public.sub_topics (
    id                 uuid primary key default uuid_generate_v4(),
    subject_id         uuid not null references public.subjects(id) on delete cascade,
    code               text not null,         -- 예: 'copd'
    name               text not null,         -- 예: '폐쇄성 폐질환'
    exam_relevance     smallint not null default 2 check (exam_relevance between 1 and 3),
    is_risk_category   boolean not null default false, -- 위험 영역 (약물·금기·응급)
    sort_order         smallint not null default 0,
    created_at         timestamptz not null default now(),

    unique (subject_id, code)
);

create index idx_sub_topics_subject on public.sub_topics(subject_id);
create index idx_sub_topics_risk on public.sub_topics(is_risk_category) where is_risk_category = true;

-- ──────────────────────────────────────────
-- 사용자 (Supabase auth.users 확장)
-- ──────────────────────────────────────────
create table public.users (
    id               uuid primary key references auth.users(id) on delete cascade,
    display_name     text,
    school_id        uuid references public.schools(id),
    grade            grade_level,
    current_semester semester_term,
    current_year     smallint,                -- 예: 2026
    plan_tier        plan_tier not null default 'free',
    onboarded_at     timestamptz,
    created_at       timestamptz not null default now(),
    updated_at       timestamptz not null default now()
);

create index idx_users_school_grade on public.users(school_id, grade);
create index idx_users_plan_tier on public.users(plan_tier);

-- ──────────────────────────────────────────
-- 코호트 (학교 + 학년 + 학기 + 과목)
-- 한 학교의 한 학년이 특정 학기에 듣는 특정 과목 단위
-- ──────────────────────────────────────────
create table public.cohorts (
    id          uuid primary key default uuid_generate_v4(),
    school_id   uuid not null references public.schools(id) on delete cascade,
    grade       grade_level not null,
    year        smallint not null,            -- 2026
    semester    semester_term not null,
    subject_id  uuid not null references public.subjects(id) on delete cascade,
    created_at  timestamptz not null default now(),

    unique (school_id, grade, year, semester, subject_id)
);

create index idx_cohorts_lookup on public.cohorts(school_id, grade, year, semester);

-- ──────────────────────────────────────────
-- 문항 풀 (Track B의 공유 풀)
-- ──────────────────────────────────────────
create table public.questions (
    id                 uuid primary key default uuid_generate_v4(),
    sub_topic_id       uuid not null references public.sub_topics(id),

    -- 콘텐츠
    stem               text not null,                       -- 문제 본문
    choices            jsonb not null,                       -- ["선지1", "선지2", ...]
    answer_index       smallint not null,                    -- 정답 인덱스 (0-base)
    explanation        text,                                 -- 해설

    -- 메타데이터
    concepts           text[] not null default '{}',         -- ['COPD', 'GOLD', 'FEV1']
    difficulty         smallint not null default 2 check (difficulty between 1 and 3),
    image_url          text,
    image_type         medical_image_type,

    -- 분류
    source             content_source not null,
    tier               content_tier not null default 'community',
    status             content_status not null default 'active',

    -- 검수
    reviewed_by        uuid references public.users(id),     -- 의사 검수자
    reviewed_at        timestamptz,
    review_notes       text,

    -- 임베딩 (중복 체크 + 약점 매칭)
    embedding          vector(1536),

    -- 통계 (배치로 업데이트)
    times_answered     integer not null default 0,
    times_correct      integer not null default 0,

    -- 타임스탬프
    created_at         timestamptz not null default now(),
    created_by         uuid references public.users(id),
    updated_at         timestamptz not null default now()
);

create index idx_questions_sub_topic on public.questions(sub_topic_id);
create index idx_questions_tier_status on public.questions(tier, status);
create index idx_questions_concepts on public.questions using gin(concepts);
create index idx_questions_embedding on public.questions
    using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

-- ──────────────────────────────────────────
-- 코호트별 Sub-topic 포함 점수
-- 학교 시험 범위 학습의 핵심 — '시험 범위 아니에요' 클릭 데이터 집계
-- ──────────────────────────────────────────
create table public.cohort_sub_topic_scores (
    cohort_id       uuid not null references public.cohorts(id) on delete cascade,
    sub_topic_id    uuid not null references public.sub_topics(id) on delete cascade,

    inclusion_score real not null default 0.5,   -- 0(범위 X) ~ 1(범위 O)
    sample_size     integer not null default 0,  -- 데이터 누적 사용자 수
    confidence      real not null default 0.3,   -- 신뢰도 (sample_size로 결정)

    -- 추천 알고리즘 가중치 (실시간 계산 캐시)
    weighted_score  real generated always as (inclusion_score * confidence) stored,

    updated_at      timestamptz not null default now(),

    primary key (cohort_id, sub_topic_id)
);

create index idx_cohort_scores_weighted on public.cohort_sub_topic_scores(cohort_id, weighted_score desc);

-- ──────────────────────────────────────────
-- 사용자 풀이 기록
-- ──────────────────────────────────────────
create table public.user_attempts (
    id                  uuid primary key default uuid_generate_v4(),
    user_id             uuid not null references public.users(id) on delete cascade,
    question_id         uuid not null references public.questions(id) on delete cascade,
    cohort_id           uuid references public.cohorts(id),

    track               attempt_track not null,
    selected_index      smallint not null,
    is_correct          boolean not null,
    time_spent_seconds  integer,

    created_at          timestamptz not null default now()
);

create index idx_attempts_user_created on public.user_attempts(user_id, created_at desc);
create index idx_attempts_question on public.user_attempts(question_id);
create index idx_attempts_cohort on public.user_attempts(cohort_id) where cohort_id is not null;

-- ──────────────────────────────────────────
-- '시험 범위 아니에요' 피드백
-- 코호트 학습의 입력 신호
-- ──────────────────────────────────────────
create table public.out_of_scope_feedback (
    id              uuid primary key default uuid_generate_v4(),
    user_id         uuid not null references public.users(id) on delete cascade,
    question_id     uuid not null references public.questions(id) on delete cascade,
    sub_topic_id    uuid not null references public.sub_topics(id),
    cohort_id       uuid not null references public.cohorts(id),
    created_at      timestamptz not null default now(),

    unique (user_id, question_id)  -- 한 문제당 한 번만 피드백 가능
);

create index idx_oos_cohort_subtopic on public.out_of_scope_feedback(cohort_id, sub_topic_id);

-- ──────────────────────────────────────────
-- 사용자 약점 영역
-- 오답 패턴 자동 분류 결과 (주기적 배치 업데이트)
-- ──────────────────────────────────────────
create table public.user_weak_areas (
    user_id        uuid not null references public.users(id) on delete cascade,
    sub_topic_id   uuid not null references public.sub_topics(id) on delete cascade,

    error_count    integer not null default 0,
    attempt_count  integer not null default 0,
    error_rate     real generated always as (
        case when attempt_count = 0 then 0
             else error_count::real / attempt_count::real
        end
    ) stored,

    severity       smallint not null default 1 check (severity between 1 and 3),
    last_updated   timestamptz not null default now(),

    primary key (user_id, sub_topic_id)
);

create index idx_weak_areas_user_severity on public.user_weak_areas(user_id, severity desc, error_rate desc);

-- ──────────────────────────────────────────
-- Track A: 사용자 업로드
-- ──────────────────────────────────────────
create table public.user_uploads (
    id              uuid primary key default uuid_generate_v4(),
    user_id         uuid not null references public.users(id) on delete cascade,
    file_name       text not null,
    file_type       text not null,              -- 'pdf', 'pptx', 'image', 'dicom'
    file_size_bytes bigint not null,
    storage_path    text not null,              -- Supabase Storage 경로
    status          upload_status not null default 'uploaded',

    -- 처리 결과
    extracted_text  text,                       -- OCR 결과
    page_count      integer,
    error_message   text,

    processed_at    timestamptz,
    created_at      timestamptz not null default now()
);

create index idx_uploads_user_created on public.user_uploads(user_id, created_at desc);
create index idx_uploads_status on public.user_uploads(status);

-- ──────────────────────────────────────────
-- Track A: 개인 풀 (Private — 본인만 접근)
-- ──────────────────────────────────────────
create table public.private_questions (
    id             uuid primary key default uuid_generate_v4(),
    user_id        uuid not null references public.users(id) on delete cascade,
    upload_id      uuid not null references public.user_uploads(id) on delete cascade,
    sub_topic_id   uuid references public.sub_topics(id),

    stem           text not null,
    choices        jsonb not null,
    answer_index   smallint not null,
    explanation    text,

    concepts       text[] not null default '{}',
    difficulty     smallint not null default 2,

    created_at     timestamptz not null default now()
);

create index idx_private_q_user_upload on public.private_questions(user_id, upload_id);

-- ──────────────────────────────────────────
-- 구독 및 결제
-- ──────────────────────────────────────────
create table public.subscriptions (
    id                  uuid primary key default uuid_generate_v4(),
    user_id             uuid not null references public.users(id) on delete cascade,
    plan_tier           plan_tier not null,
    status              text not null default 'active', -- active, cancelled, expired, past_due
    started_at          timestamptz not null default now(),
    expires_at          timestamptz,
    auto_renew          boolean not null default true,

    -- 결제 제공자
    payment_provider    text,                          -- 'tosspayments', 'stripe'
    provider_subscription_id text,

    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index idx_subscriptions_user_status on public.subscriptions(user_id, status);

-- ──────────────────────────────────────────
-- 사용량 추적 (월간 캡 적용)
-- ──────────────────────────────────────────
create table public.usage_quotas (
    user_id             uuid not null references public.users(id) on delete cascade,
    period_start        date not null,                -- 월의 첫날
    period_end          date not null,

    questions_used      integer not null default 0,
    uploads_used        integer not null default 0,
    images_used         integer not null default 0,
    weakness_reports_used integer not null default 0,

    -- 크레딧 잔액
    bonus_questions     integer not null default 0,
    bonus_uploads       integer not null default 0,
    bonus_images        integer not null default 0,

    updated_at          timestamptz not null default now(),

    primary key (user_id, period_start)
);

-- ──────────────────────────────────────────
-- 트리거: updated_at 자동 갱신
-- ──────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger as $$
begin
    new.updated_at = now();
    return new;
end;
$$ language plpgsql;

create trigger set_users_updated_at
    before update on public.users
    for each row execute function public.set_updated_at();

create trigger set_questions_updated_at
    before update on public.questions
    for each row execute function public.set_updated_at();

create trigger set_subscriptions_updated_at
    before update on public.subscriptions
    for each row execute function public.set_updated_at();

-- ──────────────────────────────────────────
-- RLS (Row Level Security)
-- 다음 마이그레이션(00002)에서 정책 설정
-- 일단 RLS만 활성화
-- ──────────────────────────────────────────
alter table public.users enable row level security;
alter table public.user_attempts enable row level security;
alter table public.out_of_scope_feedback enable row level security;
alter table public.user_weak_areas enable row level security;
alter table public.user_uploads enable row level security;
alter table public.private_questions enable row level security;
alter table public.subscriptions enable row level security;
alter table public.usage_quotas enable row level security;

-- 공용 테이블(학교, 과목, 코호트 점수 등)은 읽기 공개
alter table public.schools enable row level security;
create policy "schools_public_read" on public.schools for select using (true);

alter table public.subjects enable row level security;
create policy "subjects_public_read" on public.subjects for select using (true);

alter table public.sub_topics enable row level security;
create policy "sub_topics_public_read" on public.sub_topics for select using (true);

alter table public.cohorts enable row level security;
create policy "cohorts_public_read" on public.cohorts for select using (true);

alter table public.cohort_sub_topic_scores enable row level security;
create policy "cohort_scores_public_read" on public.cohort_sub_topic_scores for select using (true);

-- questions 풀은 인증된 사용자에게만
alter table public.questions enable row level security;
create policy "questions_authenticated_read" on public.questions
    for select using (auth.role() = 'authenticated' and status = 'active');


-- ====================== 00002_rls_policies.sql ======================
-- ====================================================================
-- RLS 정책 — 데이터 접근 제어
-- ====================================================================
-- 원칙:
--   1. 사용자는 본인 데이터만 read/write
--   2. 마스터·집계 데이터는 인증된 사용자에게 read 공개
--   3. Service Role 은 자동으로 RLS 우회 (Admin 작업용)
-- ====================================================================

-- ──────────────────────────────────────────
-- public.users — 본인 데이터만
-- ──────────────────────────────────────────
create policy "users_read_own" on public.users
    for select using (auth.uid() = id);

create policy "users_insert_own" on public.users
    for insert with check (auth.uid() = id);

-- UPDATE: 본인 행만, 그리고 id 변조 금지.
-- 컬럼 단위 보호(role/plan_tier 변경 차단)는 00012_user_privilege_lock.sql 의 트리거로 강제됨.
create policy "users_update_own" on public.users
    for update
    using (auth.uid() = id)
    with check (auth.uid() = id);

-- ──────────────────────────────────────────
-- user_attempts — 본인 풀이 기록만
-- ──────────────────────────────────────────
create policy "attempts_read_own" on public.user_attempts
    for select using (auth.uid() = user_id);

create policy "attempts_insert_own" on public.user_attempts
    for insert with check (auth.uid() = user_id);

-- ──────────────────────────────────────────
-- out_of_scope_feedback — 본인 클릭 기록만
-- ──────────────────────────────────────────
create policy "oos_read_own" on public.out_of_scope_feedback
    for select using (auth.uid() = user_id);

create policy "oos_insert_own" on public.out_of_scope_feedback
    for insert with check (auth.uid() = user_id);

-- 일단 update/delete 미허용 (한 번 누른 피드백은 변경 불가)

-- ──────────────────────────────────────────
-- user_weak_areas — 본인 약점 데이터만
-- ──────────────────────────────────────────
create policy "weak_areas_read_own" on public.user_weak_areas
    for select using (auth.uid() = user_id);

-- write 는 서버 측 배치 작업(service role) 전용
-- 사용자가 직접 insert/update 하지 않음

-- ──────────────────────────────────────────
-- user_uploads — 본인 업로드만
-- ──────────────────────────────────────────
create policy "uploads_read_own" on public.user_uploads
    for select using (auth.uid() = user_id);

create policy "uploads_insert_own" on public.user_uploads
    for insert with check (auth.uid() = user_id);

create policy "uploads_update_own" on public.user_uploads
    for update using (auth.uid() = user_id);

create policy "uploads_delete_own" on public.user_uploads
    for delete using (auth.uid() = user_id);

-- ──────────────────────────────────────────
-- private_questions — 본인 Private 풀만
-- 절대 다른 사용자에게 노출 X (강의자료 IP 보호)
-- ──────────────────────────────────────────
create policy "private_q_read_own" on public.private_questions
    for select using (auth.uid() = user_id);

create policy "private_q_insert_own" on public.private_questions
    for insert with check (auth.uid() = user_id);

create policy "private_q_delete_own" on public.private_questions
    for delete using (auth.uid() = user_id);

-- ──────────────────────────────────────────
-- subscriptions — 본인 구독만 read (write 는 결제 webhook)
-- ──────────────────────────────────────────
create policy "subs_read_own" on public.subscriptions
    for select using (auth.uid() = user_id);

-- ──────────────────────────────────────────
-- usage_quotas — 본인 사용량만 read (write 는 서버 측)
-- ──────────────────────────────────────────
create policy "quotas_read_own" on public.usage_quotas
    for select using (auth.uid() = user_id);

-- ──────────────────────────────────────────
-- public.users 자동 생성 트리거
-- auth.users 에 새 행이 생성될 때 public.users 도 자동 생성
-- ──────────────────────────────────────────
create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.users (id, display_name)
    values (
        new.id,
        coalesce(new.raw_user_meta_data->>'display_name', new.email)
    );
    return new;
end;
$$;

create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_auth_user();


-- ====================== 00003_master_seed.sql ======================
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


-- ====================== 00004_embedding_dim.sql ======================
-- ====================================================================
-- 임베딩 차원 조정 — Voyage AI voyage-3 (1024 차원)
-- ====================================================================
-- 기존 vector(1536) 는 OpenAI text-embedding-3-small 기준이었으나
-- Anthropic 권장 Voyage AI 와 일치하도록 1024 로 변경.
--
-- 데이터 없는 상태에서 컬럼 재생성 (HNSW 인덱스 포함).
-- ====================================================================

-- HNSW 인덱스 먼저 제거
drop index if exists idx_questions_embedding;

-- 임베딩 컬럼 재생성
alter table public.questions drop column if exists embedding;
alter table public.questions add column embedding vector(1024);

-- HNSW 인덱스 재생성
create index idx_questions_embedding on public.questions
    using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

-- ──────────────────────────────────────────
-- 유사도 검색 함수 — pgvector 의 <=> 연산자 래핑
-- (Postgres RPC 로 호출 가능)
-- ──────────────────────────────────────────
create or replace function public.match_questions(
    query_embedding vector(1024),
    match_threshold real default 0.85,
    match_count integer default 10,
    exclude_ids uuid[] default '{}',
    sub_topic_filter uuid[] default null
)
returns table (
    id uuid,
    sub_topic_id uuid,
    stem text,
    similarity real
)
language sql stable
as $$
    select
        q.id,
        q.sub_topic_id,
        q.stem,
        1 - (q.embedding <=> query_embedding) as similarity
    from public.questions q
    where q.embedding is not null
      and q.status = 'active'
      and (sub_topic_filter is null or q.sub_topic_id = any(sub_topic_filter))
      and not (q.id = any(exclude_ids))
      and 1 - (q.embedding <=> query_embedding) > match_threshold
    order by q.embedding <=> query_embedding
    limit match_count;
$$;

-- ──────────────────────────────────────────
-- 문항 통계 증가 — 풀이 결과 누적
-- ──────────────────────────────────────────
create or replace function public.increment_question_stats(
    p_question_id uuid,
    p_is_correct boolean
)
returns void
language sql
as $$
    update public.questions
    set times_answered = times_answered + 1,
        times_correct = times_correct + (case when p_is_correct then 1 else 0 end)
    where id = p_question_id;
$$;


-- ====================== 00005_cohort_learning.sql ======================
-- ====================================================================
-- 코호트 학습 RPC — '시험 범위 아니에요' 피드백 처리
-- ====================================================================
-- 학교 코호트 단위로 sub_topic 의 inclusion_score 를 갱신.
--
-- 주요 함수:
--   1. calc_user_weight              — 사용자 신뢰 가중치 계산
--   2. recalc_cohort_subtopic_score  — 코호트 점수 재계산
--   3. detect_curriculum_drift       — 교육과정 개편 감지
-- ====================================================================

-- ──────────────────────────────────────────
-- 사용자 신뢰 가중치 (0 ~ 1)
--   - 정상 사용자: 1.0
--   - 신규 사용자 (< 30일): 0.3
--   - Outlier (총 시도 30회 이상 & out_of_scope 클릭률 > 70%): × 0.2
--
-- 두 조건 동시 적용 가능 (신규 + outlier → 0.06)
-- ──────────────────────────────────────────
create or replace function public.calc_user_weight(
    p_user_id uuid
)
returns real
language plpgsql
stable
as $$
declare
    v_age_days   integer;
    v_attempts   integer;
    v_oos_clicks integer;
    v_oos_rate   real;
    v_weight     real := 1.0;
begin
    -- 사용자 가입일 확인
    select extract(day from (now() - created_at))::int
      into v_age_days
      from public.users
     where id = p_user_id;

    if v_age_days is null then
        return 0;  -- 존재하지 않는 사용자
    end if;

    -- 신규 사용자 (< 30일) 가중치 감소
    if v_age_days < 30 then
        v_weight := 0.3;
    end if;

    -- Outlier 감지
    select count(*) into v_attempts
      from public.user_attempts
     where user_id = p_user_id;

    select count(*) into v_oos_clicks
      from public.out_of_scope_feedback
     where user_id = p_user_id;

    if v_attempts >= 30 then
        v_oos_rate := v_oos_clicks::real / v_attempts::real;
        if v_oos_rate > 0.7 then
            v_weight := v_weight * 0.2;
        end if;
    end if;

    return v_weight;
end;
$$;

-- ──────────────────────────────────────────
-- 코호트 sub_topic 점수 재계산
--
-- 호출 시점:
--   - out_of_scope_feedback insert 직후 (인라인)
--   - 배치 작업으로 주기적 (스케일 시)
--
-- 알고리즘:
--   inclusion_score = 1 - (가중 out_of_scope 클릭 수 / 가중 시도 사용자 수)
--   confidence: sample_size 기반 step function
-- ──────────────────────────────────────────
create or replace function public.recalc_cohort_subtopic_score(
    p_cohort_id    uuid,
    p_sub_topic_id uuid
)
returns void
language plpgsql
as $$
declare
    v_total_weight    real    := 0;
    v_oos_weight      real    := 0;
    v_sample_size     integer := 0;
    v_inclusion_score real;
    v_confidence      real;
begin
    -- 시도한 distinct 사용자의 가중 합산
    select count(distinct ua.user_id),
           coalesce(sum(distinct_weights.w), 0)
      into v_sample_size, v_total_weight
      from public.user_attempts ua
      join public.questions q on q.id = ua.question_id
      cross join lateral (
          select public.calc_user_weight(ua.user_id) as w
      ) distinct_weights
     where ua.cohort_id = p_cohort_id
       and q.sub_topic_id = p_sub_topic_id;

    -- out_of_scope 클릭의 가중 합산
    select coalesce(sum(public.calc_user_weight(user_id)), 0)
      into v_oos_weight
      from public.out_of_scope_feedback
     where cohort_id = p_cohort_id
       and sub_topic_id = p_sub_topic_id;

    if v_total_weight = 0 then
        return;
    end if;

    v_inclusion_score := 1.0 - (v_oos_weight / v_total_weight);
    v_inclusion_score := greatest(0.0, least(1.0, v_inclusion_score));

    -- Confidence: sample_size 기반 step function
    if v_sample_size < 3 then
        v_confidence := 0.3;
    elsif v_sample_size < 10 then
        v_confidence := 0.6;
    else
        v_confidence := 1.0;
    end if;

    insert into public.cohort_sub_topic_scores
        (cohort_id, sub_topic_id, inclusion_score, sample_size, confidence)
    values
        (p_cohort_id, p_sub_topic_id, v_inclusion_score, v_sample_size, v_confidence)
    on conflict (cohort_id, sub_topic_id) do update
        set inclusion_score = excluded.inclusion_score,
            sample_size     = excluded.sample_size,
            confidence      = excluded.confidence,
            updated_at      = now();
end;
$$;

-- ──────────────────────────────────────────
-- 교육과정 개편 자동 감지
--
-- 같은 학교 + 학년 + 과목의 직전 학기·년도 코호트와 비교하여
-- sub_topic inclusion_score 가 ±0.3 이상 변동한 항목 반환.
--
-- bandit 의 exploration 비율 임시 상향 트리거로 활용 가능.
-- ──────────────────────────────────────────
create or replace function public.detect_curriculum_drift(
    p_cohort_id uuid
)
returns table (
    sub_topic_id     uuid,
    sub_topic_name   text,
    current_score    real,
    previous_score   real,
    delta            real,
    direction        text
)
language sql
stable
as $$
    with current_cohort as (
        select c.school_id, c.grade, c.year, c.semester, c.subject_id
          from public.cohorts c
         where c.id = p_cohort_id
    ),
    previous_cohort as (
        select c.id
          from public.cohorts c, current_cohort cc
         where c.school_id  = cc.school_id
           and c.grade      = cc.grade
           and c.subject_id = cc.subject_id
           and (
               (cc.semester = 'fall'   and c.year = cc.year     and c.semester = 'spring')
            or (cc.semester = 'spring' and c.year = cc.year - 1 and c.semester = 'fall')
           )
         limit 1
    )
    select
        curr.sub_topic_id,
        st.name as sub_topic_name,
        curr.inclusion_score as current_score,
        coalesce(prev.inclusion_score, 0.5) as previous_score,
        abs(curr.inclusion_score - coalesce(prev.inclusion_score, 0.5)) as delta,
        case
            when curr.inclusion_score > coalesce(prev.inclusion_score, 0.5)
            then 'expanded'   -- 범위 확장 (포함 ↑)
            else 'narrowed'   -- 범위 축소 (포함 ↓)
        end as direction
      from public.cohort_sub_topic_scores curr
      join public.sub_topics st on st.id = curr.sub_topic_id
      left join public.cohort_sub_topic_scores prev
        on prev.sub_topic_id = curr.sub_topic_id
       and prev.cohort_id    = (select id from previous_cohort)
     where curr.cohort_id = p_cohort_id
       and abs(curr.inclusion_score - coalesce(prev.inclusion_score, 0.5)) > 0.3
     order by delta desc;
$$;

-- ──────────────────────────────────────────
-- 코호트 활성 사용자 수 — 30일 이내 풀이 활동
-- ──────────────────────────────────────────
create or replace function public.cohort_active_users(
    p_cohort_id uuid,
    p_days      integer default 30
)
returns integer
language sql
stable
as $$
    select count(distinct user_id)::int
      from public.user_attempts
     where cohort_id = p_cohort_id
       and created_at > now() - (p_days || ' days')::interval;
$$;


-- ====================== 00006_storage.sql ======================
-- ====================================================================
-- Storage 버킷 — 사용자 업로드 자료 (Track A · 내 강의 노트)
-- ====================================================================
-- 경로 규칙: {user_id}/{upload_id}/{filename}
-- RLS 정책: 사용자는 본인 폴더만 read/write/delete
-- ====================================================================

-- ──────────────────────────────────────────
-- 버킷 생성
-- ──────────────────────────────────────────
insert into storage.buckets (
    id, name, public, file_size_limit, allowed_mime_types
) values (
    'user_uploads',
    'user_uploads',
    false,                          -- private
    524288000,                      -- 500MB 제한
    array[
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.ms-powerpoint',
        'image/png',
        'image/jpeg',
        'image/webp',
        'application/dicom'
    ]
) on conflict (id) do update set
    public            = excluded.public,
    file_size_limit   = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ──────────────────────────────────────────
-- RLS 정책 — 본인 폴더만 접근
-- ──────────────────────────────────────────

-- SELECT
drop policy if exists "user_uploads_select_own" on storage.objects;
create policy "user_uploads_select_own"
on storage.objects for select
to authenticated
using (
    bucket_id = 'user_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
);

-- INSERT
drop policy if exists "user_uploads_insert_own" on storage.objects;
create policy "user_uploads_insert_own"
on storage.objects for insert
to authenticated
with check (
    bucket_id = 'user_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
);

-- UPDATE
drop policy if exists "user_uploads_update_own" on storage.objects;
create policy "user_uploads_update_own"
on storage.objects for update
to authenticated
using (
    bucket_id = 'user_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
);

-- DELETE
drop policy if exists "user_uploads_delete_own" on storage.objects;
create policy "user_uploads_delete_own"
on storage.objects for delete
to authenticated
using (
    bucket_id = 'user_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
);


-- ====================== 00007_quota_and_payments.sql ======================
-- ====================================================================
-- 사용량 quota + 결제 인프라
-- ====================================================================

-- ──────────────────────────────────────────
-- 결제 트랜잭션 (Audit log)
-- ──────────────────────────────────────────
create type payment_kind as enum (
    'subscription_initial',  -- 구독 첫 결제
    'subscription_renewal',  -- 구독 갱신
    'credit_questions',      -- 문항 크레딧
    'credit_uploads',        -- 자료 업로드 크레딧
    'credit_images'          -- 이미지 크레딧
);

create type payment_status as enum (
    'pending',    -- 결제 초기화, 사용자 입력 대기
    'approved',   -- 승인 완료
    'failed',     -- 실패
    'cancelled',  -- 취소
    'refunded'    -- 환불
);

create table public.payments (
    id                    uuid primary key default uuid_generate_v4(),
    user_id               uuid not null references public.users(id) on delete cascade,
    kind                  payment_kind not null,
    status                payment_status not null default 'pending',

    -- 결제 정보
    amount_krw            integer not null,
    plan_tier             plan_tier,                    -- 구독 종류 (kind = subscription_*)
    credit_amount         integer,                      -- 크레딧 충전량 (kind = credit_*)

    -- 토스 결제 키
    toss_order_id         text not null unique,         -- 우리가 생성한 주문 ID
    toss_payment_key      text,                         -- 토스가 부여한 결제 키 (승인 후)

    -- 메타
    failure_reason        text,
    raw_response          jsonb,                        -- 토스 응답 전체 저장

    approved_at           timestamptz,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now()
);

create index idx_payments_user_status on public.payments(user_id, status);
create index idx_payments_toss_order  on public.payments(toss_order_id);

alter table public.payments enable row level security;
create policy "payments_read_own" on public.payments
    for select using (auth.uid() = user_id);

create trigger set_payments_updated_at
    before update on public.payments
    for each row execute function public.set_updated_at();

-- ──────────────────────────────────────────
-- 사용량 quota 체크 함수
--
-- 호출 흐름:
--   AI 호출 전 → check_user_quota(user_id, resource, amount)
--   결과 ok=false 면 402 응답 반환
--   ok=true 면 호출 진행 → 성공 후 consume_quota 로 차감
--
-- 현재 월 quota 정보 자동 생성 (없으면 insert).
-- ──────────────────────────────────────────

-- 사용자의 현재 quota period 시작/종료일
create or replace function public.current_quota_period(p_now timestamptz default now())
returns table (period_start date, period_end date)
language sql
stable
as $$
    select
        date_trunc('month', p_now)::date as period_start,
        (date_trunc('month', p_now) + interval '1 month - 1 day')::date as period_end;
$$;

-- quota 행 lookup-or-create
create or replace function public.ensure_quota_row(p_user_id uuid)
returns public.usage_quotas
language plpgsql
as $$
declare
    v_period record;
    v_row    public.usage_quotas;
begin
    select * into v_period from public.current_quota_period();

    select * into v_row
      from public.usage_quotas
     where user_id = p_user_id
       and period_start = v_period.period_start;

    if not found then
        insert into public.usage_quotas (user_id, period_start, period_end)
        values (p_user_id, v_period.period_start, v_period.period_end)
        on conflict (user_id, period_start) do nothing
        returning * into v_row;

        -- onConflict 발생 시 재조회
        if not found then
            select * into v_row
              from public.usage_quotas
             where user_id = p_user_id
               and period_start = v_period.period_start;
        end if;
    end if;

    return v_row;
end;
$$;

-- 사용량 체크
create or replace function public.check_user_quota(
    p_user_id  uuid,
    p_resource text,             -- 'questions' | 'uploads' | 'images'
    p_amount   integer default 1
)
returns table (
    ok                boolean,
    plan_tier         plan_tier,
    limit_amount      integer,
    used_amount       integer,
    bonus_amount      integer,
    remaining         integer
)
language plpgsql
as $$
declare
    v_quota   public.usage_quotas;
    v_user    public.users;
    v_limit   integer;
    v_used    integer;
    v_bonus   integer;
    v_remain  integer;
begin
    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    -- 플랜별 한도
    v_limit := case v_user.plan_tier
        when 'free'     then case p_resource when 'questions' then 50   when 'uploads' then 1  when 'images' then 5   else 0 end
        when 'lite'     then case p_resource when 'questions' then 150  when 'uploads' then 5  when 'images' then 20  else 0 end
        when 'standard' then case p_resource when 'questions' then 400  when 'uploads' then 15 when 'images' then 60  else 0 end
        when 'pro'      then case p_resource when 'questions' then 1000 when 'uploads' then 50 when 'images' then 200 else 0 end
        else 0
    end;

    -- 사용량·보너스 조회
    v_used  := case p_resource
        when 'questions' then v_quota.questions_used
        when 'uploads'   then v_quota.uploads_used
        when 'images'    then v_quota.images_used
        else 0 end;
    v_bonus := case p_resource
        when 'questions' then v_quota.bonus_questions
        when 'uploads'   then v_quota.bonus_uploads
        when 'images'    then v_quota.bonus_images
        else 0 end;

    v_remain := (v_limit + v_bonus) - v_used;

    return query select
        (v_remain >= p_amount) as ok,
        v_user.plan_tier,
        v_limit,
        v_used,
        v_bonus,
        greatest(0, v_remain);
end;
$$;

-- 사용량 차감
create or replace function public.consume_quota(
    p_user_id  uuid,
    p_resource text,
    p_amount   integer default 1
)
returns void
language plpgsql
as $$
declare
    v_quota public.usage_quotas;
begin
    v_quota := public.ensure_quota_row(p_user_id);

    update public.usage_quotas
       set questions_used = case when p_resource = 'questions' then questions_used + p_amount else questions_used end,
           uploads_used   = case when p_resource = 'uploads'   then uploads_used + p_amount   else uploads_used   end,
           images_used    = case when p_resource = 'images'    then images_used + p_amount    else images_used    end,
           updated_at     = now()
     where user_id = p_user_id
       and period_start = v_quota.period_start;
end;
$$;

-- 크레딧 보너스 추가
create or replace function public.add_bonus_credits(
    p_user_id  uuid,
    p_resource text,
    p_amount   integer
)
returns void
language plpgsql
as $$
declare
    v_quota public.usage_quotas;
begin
    v_quota := public.ensure_quota_row(p_user_id);

    update public.usage_quotas
       set bonus_questions = case when p_resource = 'questions' then bonus_questions + p_amount else bonus_questions end,
           bonus_uploads   = case when p_resource = 'uploads'   then bonus_uploads + p_amount   else bonus_uploads   end,
           bonus_images    = case when p_resource = 'images'    then bonus_images + p_amount    else bonus_images    end,
           updated_at      = now()
     where user_id = p_user_id
       and period_start = v_quota.period_start;
end;
$$;

-- 월간 자동 reset (cron 으로 매월 1일 호출)
-- 현재 월의 quota 행은 ensure_quota_row 가 lazy 생성하므로 별도 reset 불필요.
-- 단, 만료된 보너스 처리: 1개월 이월 후 소멸.
create or replace function public.reset_expired_bonuses()
returns void
language sql
as $$
    -- 이전 달 quota 행의 bonus 를 0 으로 (1개월 이월 정책)
    update public.usage_quotas
       set bonus_questions = 0,
           bonus_uploads   = 0,
           bonus_images    = 0,
           updated_at      = now()
     where period_end < current_date - interval '1 month';
$$;


-- ====================== 00008_admin_role_and_cost_cap.sql ======================
-- ============================================
-- 00008_admin_role_and_cost_cap.sql
--
-- P0-2: users.role 컬럼 + admin 가드용 헬퍼 함수
-- P0-3: ai_cost_log 테이블 + 일일 비용 캡 RPC
-- P0-6: requireQuota 보조 RPC (사전 체크용)
-- Day2-am: payments.subscription_id FK (최소 마이그레이션)
-- ============================================

-- ──────────────────────────────────────────
-- (1) 사용자 역할 (admin / user)
-- ──────────────────────────────────────────
do $$ begin
    create type user_role as enum ('user', 'admin');
exception when duplicate_object then null; end $$;

alter table public.users
    add column if not exists role user_role not null default 'user';

create index if not exists idx_users_role on public.users(role) where role = 'admin';

-- 현재 사용자가 admin 인지 확인
create or replace function public.is_admin(user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    select coalesce((select role = 'admin' from public.users where id = user_id), false);
$$;

-- ──────────────────────────────────────────
-- (2) AI 비용 로그 + 일일 캡
-- ──────────────────────────────────────────
create table if not exists public.ai_cost_log (
    id           uuid primary key default uuid_generate_v4(),
    user_id      uuid references public.users(id) on delete set null,
    endpoint     text not null,        -- 'questions.generate', 'uploads.process' 등
    model        text not null,
    cost_usd     numeric(10, 6) not null,
    input_tokens integer not null default 0,
    output_tokens integer not null default 0,
    metadata     jsonb,
    created_at   timestamptz not null default now()
);

create index if not exists idx_ai_cost_log_created_at on public.ai_cost_log(created_at desc);
create index if not exists idx_ai_cost_log_user_date on public.ai_cost_log(user_id, created_at desc);

-- 일일 누적 비용 (UTC 기준 자정)
create or replace function public.daily_ai_cost_usd()
returns numeric
language sql
stable
security definer
set search_path = public
as $$
    select coalesce(sum(cost_usd), 0)
    from public.ai_cost_log
    where created_at >= date_trunc('day', now() at time zone 'utc');
$$;

-- 일일 캡 체크 — 환경변수 MAX_DAILY_AI_COST_USD 와 비교는 앱 레이어에서
-- (Postgres 에서 env var 읽는 건 안티패턴이라 RPC 는 누적치만 반환)
create or replace function public.check_daily_cost_within(threshold_usd numeric)
returns table(within_cap boolean, current_usd numeric, threshold numeric)
language sql
stable
security definer
set search_path = public
as $$
    select
        coalesce(sum(cost_usd), 0) < threshold_usd as within_cap,
        coalesce(sum(cost_usd), 0) as current_usd,
        threshold_usd as threshold
    from public.ai_cost_log
    where created_at >= date_trunc('day', now() at time zone 'utc');
$$;

-- RLS — admin 만 조회 가능
alter table public.ai_cost_log enable row level security;

create policy "ai_cost_log_admin_read"
    on public.ai_cost_log
    for select
    using (public.is_admin(auth.uid()));

-- 서비스 롤은 RLS 우회 (admin client 가 insert 함)

-- ──────────────────────────────────────────
-- (3) payments.subscription_id FK (최소)
-- ──────────────────────────────────────────
alter table public.payments
    add column if not exists subscription_id uuid references public.subscriptions(id) on delete set null;

create index if not exists idx_payments_subscription on public.payments(subscription_id);

comment on column public.payments.subscription_id is
    '결제와 연결된 구독 ID. 구독 결제(initial/renewal)만 채워짐. 환불 시 정확한 구독 식별용.';

-- ──────────────────────────────────────────
-- (4) upload_status 에 'queued' 추가 (P1-A9 큐화)
-- ──────────────────────────────────────────
do $$ begin
    alter type upload_status add value if not exists 'queued' before 'processing';
exception when others then null; end $$;


-- ====================== 00009_ops_alerts.sql ======================
-- ============================================
-- 00009_ops_alerts.sql
--
-- 운영 알림 큐 (webhook 서명 실패, queue dead, cost cap 근접 등)
-- ============================================

do $$ begin
    create type alert_severity as enum ('low', 'medium', 'high', 'critical');
exception when duplicate_object then null; end $$;

create table if not exists public.ops_alerts (
    id          uuid primary key default uuid_generate_v4(),
    severity    alert_severity not null,
    source      text not null,
    message     text not null,
    payload     jsonb,
    resolved_at timestamptz,
    created_at  timestamptz not null default now()
);

create index if not exists idx_ops_alerts_unresolved
    on public.ops_alerts(created_at desc)
    where resolved_at is null;

create index if not exists idx_ops_alerts_severity
    on public.ops_alerts(severity, created_at desc)
    where resolved_at is null;

alter table public.ops_alerts enable row level security;

create policy "ops_alerts_admin_only"
    on public.ops_alerts
    for all
    using (public.is_admin(auth.uid()))
    with check (public.is_admin(auth.uid()));


-- ====================== 00010_open_images.sql ======================
-- ============================================
-- 00010_open_images.sql
--
-- 오픈 라이선스 의료 이미지 풀.
-- 인제스트는 admin 만, 사용은 모든 인증 사용자.
-- 라이선스 자동 표기를 위해 attribution_text/license/original_url 필수.
-- ============================================

do $$ begin
    create type open_image_source as enum (
        'roco_v2',
        'nih_chestxray14',
        'pmc_open_access',
        'wikipedia_commons',
        'manual_upload'
    );
exception when duplicate_object then null; end $$;

do $$ begin
    create type open_image_license as enum (
        'cc0',
        'cc_by',
        'cc_by_sa',
        'public_domain',
        'pmc_oa',
        'nih_open_access'
    );
exception when duplicate_object then null; end $$;

create table if not exists public.open_images (
    id                uuid primary key default uuid_generate_v4(),
    source            open_image_source not null,
    source_id         text not null,                       -- 원본 데이터셋 내 ID
    modality          medical_image_type not null,         -- 기존 enum 재사용
    sub_topic_id      uuid references public.sub_topics(id) on delete set null,
    license           open_image_license not null,
    attribution_text  text not null,                       -- "Smith et al. (2019), PMC1234567" 같은 인용
    original_url      text not null,                       -- 원본 페이지 URL (표기 의무)
    storage_path      text,                                -- Supabase Storage 내 사본 경로 (선택)
    caption           text,
    keywords          text[],
    embedding         vector(1024),
    width_px          integer,
    height_px         integer,
    file_size_bytes   integer,
    ingested_at       timestamptz not null default now(),
    ingested_by       uuid references public.users(id) on delete set null,
    is_active         boolean not null default true,       -- 라이선스 분쟁 시 false 로 즉시 비활성화

    unique (source, source_id)
);

create index if not exists idx_open_images_modality_active
    on public.open_images(modality, is_active)
    where is_active = true;

create index if not exists idx_open_images_sub_topic
    on public.open_images(sub_topic_id)
    where sub_topic_id is not null and is_active = true;

-- pgvector HNSW
create index if not exists idx_open_images_embedding
    on public.open_images
    using hnsw (embedding vector_cosine_ops)
    with (m = 16, ef_construction = 64);

-- RLS
alter table public.open_images enable row level security;

-- 인증된 사용자는 활성 이미지만 read
create policy "open_images_read_active"
    on public.open_images
    for select
    using (auth.role() = 'authenticated' and is_active = true);

-- 쓰기는 admin 전용
create policy "open_images_admin_write"
    on public.open_images
    for all
    using (public.is_admin(auth.uid()))
    with check (public.is_admin(auth.uid()));

-- questions 에 open_image 출처 추적 (FK)
alter table public.questions
    add column if not exists open_image_id uuid references public.open_images(id) on delete set null;

create index if not exists idx_questions_open_image
    on public.questions(open_image_id)
    where open_image_id is not null;

-- 유사 이미지 검색 RPC
create or replace function public.match_open_images(
    query_embedding vector(1024),
    match_threshold float default 0.85,
    match_count int default 5,
    modality_filter medical_image_type default null,
    sub_topic_filter uuid[] default null
)
returns table (
    id uuid,
    similarity float,
    modality medical_image_type,
    sub_topic_id uuid,
    caption text,
    original_url text,
    attribution_text text,
    license open_image_license
)
language sql
stable
as $$
    select
        oi.id,
        1 - (oi.embedding <=> query_embedding) as similarity,
        oi.modality,
        oi.sub_topic_id,
        oi.caption,
        oi.original_url,
        oi.attribution_text,
        oi.license
    from public.open_images oi
    where oi.is_active = true
      and oi.embedding is not null
      and 1 - (oi.embedding <=> query_embedding) >= match_threshold
      and (modality_filter is null or oi.modality = modality_filter)
      and (sub_topic_filter is null or oi.sub_topic_id = any(sub_topic_filter))
    order by oi.embedding <=> query_embedding
    limit match_count;
$$;


-- ====================== 00012_user_privilege_lock.sql ======================
-- ============================================
-- 00012_user_privilege_lock.sql
--
-- public.users 의 권한 컬럼(role, plan_tier) 자기 변경 차단.
-- INSERT 와 UPDATE 모두 보호.
--   - UPDATE: 일반 사용자가 role/plan_tier 를 변경할 수 없음.
--   - INSERT: 일반 사용자가 본인 행을 직접 insert 할 때 role 은 'user', plan_tier 는 'free' 만 허용.
--     (handle_new_auth_user 트리거의 기본값과 동일하므로 정상 회원가입은 영향 없음.)
-- service_role (admin client) 은 통과시켜 결제 확정·운영 작업이 동작하도록 함.
--
-- 의존: 00008_admin_role_and_cost_cap.sql 가 users.role 컬럼을 추가해야 함.
-- ============================================

create or replace function public.prevent_user_privilege_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_role text;
begin
    -- Supabase 의 auth.role() 은 JWT 의 role claim 을 반환.
    -- service_role 키로 호출한 admin client 는 'service_role',
    -- 일반 사용자는 'authenticated'.
    -- auth 스키마가 없는 환경(테스트)에서는 NULL 일 수 있으므로 안전하게 처리.
    begin
        v_role := auth.role();
    exception when others then
        v_role := null;
    end;

    -- service_role 은 그대로 통과 (결제 확정 / 운영 / admin client).
    if v_role = 'service_role' then
        return new;
    end if;

    -- handle_new_auth_user 같은 SECURITY DEFINER 트리거는 auth.role() 이
    -- service_role 이 아닌 값(또는 NULL)을 반환할 수 있으나, 그 경로의
    -- INSERT 는 role/plan_tier 컬럼을 명시하지 않아 DEFAULT 인 'user'/'free'
    -- 가 들어오므로 아래 INSERT 체크를 자연스럽게 통과한다.

    if tg_op = 'INSERT' then
        if new.role is distinct from 'user'::user_role then
            raise exception 'users.role 은 사용자가 직접 설정할 수 없습니다.'
                using errcode = '42501';
        end if;
        if new.plan_tier is distinct from 'free'::plan_tier then
            raise exception 'users.plan_tier 은 사용자가 직접 설정할 수 없습니다.'
                using errcode = '42501';
        end if;
        return new;
    end if;

    -- UPDATE 경로: role / plan_tier 변경 금지.
    -- 단, school_id / grade / current_semester / current_year / onboarded_at /
    -- display_name 등 일반 컬럼 변경은 영향 없음.
    if new.role is distinct from old.role then
        raise exception 'users.role 은 사용자가 직접 변경할 수 없습니다.'
            using errcode = '42501';
    end if;

    if new.plan_tier is distinct from old.plan_tier then
        raise exception 'users.plan_tier 은 사용자가 직접 변경할 수 없습니다.'
            using errcode = '42501';
    end if;

    return new;
end;
$$;

drop trigger if exists trg_prevent_user_privilege_escalation on public.users;
create trigger trg_prevent_user_privilege_escalation
    before insert or update on public.users
    for each row
    execute function public.prevent_user_privilege_escalation();


-- ====================== 00013_payment_entitlement_tracking.sql ======================
-- ============================================
-- 00013_payment_entitlement_tracking.sql
--
-- payments 결제 승인(approved) 후 실제 혜택(users.plan_tier 갱신 / bonus credit 지급)
-- 적용 여부를 추적해 confirm 재호출 시 reconcile 할 수 있게 한다.
--
-- 결제 confirm 라우트는 다음 규칙을 따른다:
--   1. 첫 호출 — Toss 승인 → subscription/credit 적용 → entitlement_granted_at 마킹.
--      마지막 단계 실패 시 ApiException 으로 클라이언트에 실패 응답.
--   2. 재호출 (이미 approved) — entitlement_granted_at 이 NULL 이면
--      누락된 혜택을 재시도하고, 성공 시에만 마킹 + ok 응답.
--      여전히 실패하면 사용자에게 실패 응답.
--
-- 크레딧(bonus) 결제는 add_bonus_credits 호출과 entitlement_granted_at 마킹을
-- 단일 트랜잭션 안에서 실행해야 안전(부분 성공 시 중복 지급 방지). 그래서
-- apply_payment_credit_bonus RPC 를 추가해 confirm 라우트에서 호출하도록 한다.
-- ============================================

alter table public.payments
    add column if not exists entitlement_granted_at timestamptz;

comment on column public.payments.entitlement_granted_at is
    'subscription/credit 혜택이 사용자 계정에 적용된 시각. NULL 이면 미적용/미reconcile 상태.';

-- 운영 reconciliation 쿼리 편의용: approved 인데 entitlement 미적용 결제 빠르게 조회.
create index if not exists idx_payments_entitlement_pending
    on public.payments(approved_at)
    where status = 'approved' and entitlement_granted_at is null;

-- ──────────────────────────────────────────
-- 크레딧 결제 원자 적용 RPC
--
-- 동작:
--   1. payments 행을 FOR UPDATE 로 잠근 뒤 상태 확인.
--   2. 이미 entitlement_granted_at 이 설정되어 있으면 applied=false 반환 (idempotent).
--   3. status='approved' + kind='credit_*' + credit_amount > 0 일 때만 진행.
--   4. add_bonus_credits 호출 → entitlement_granted_at = now() 갱신.
--   5. 두 작업이 동일 트랜잭션에 묶여 부분 성공이 없다.
--
-- 호출자(payments/confirm)는 error 가 나면 throw, applied=false 이면 이미 처리됨으로 간주.
-- ──────────────────────────────────────────
create or replace function public.apply_payment_credit_bonus(p_payment_id uuid)
returns table (
    applied        boolean,
    kind           text,
    credit_amount  integer
)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_payment   public.payments;
    v_resource  text;
    v_now       timestamptz := now();
begin
    select * into v_payment
      from public.payments
     where id = p_payment_id
     for update;

    if not found then
        raise exception 'payment % not found', p_payment_id
            using errcode = 'P0002';
    end if;

    if v_payment.status <> 'approved' then
        raise exception 'payment % is not approved (status=%)',
            p_payment_id, v_payment.status
            using errcode = '22023';
    end if;

    -- 이미 적용된 결제 — 두번째 호출은 no-op
    if v_payment.entitlement_granted_at is not null then
        return query select false, v_payment.kind::text, v_payment.credit_amount;
        return;
    end if;

    if v_payment.kind::text not like 'credit_%' then
        raise exception 'payment % is not a credit kind (%)',
            p_payment_id, v_payment.kind
            using errcode = '22023';
    end if;

    if v_payment.credit_amount is null or v_payment.credit_amount <= 0 then
        raise exception 'payment % has invalid credit_amount (%)',
            p_payment_id, v_payment.credit_amount
            using errcode = '22023';
    end if;

    -- 'credit_questions' → 'questions' 같은 식으로 자른다.
    v_resource := substring(v_payment.kind::text from 8);

    perform public.add_bonus_credits(
        v_payment.user_id,
        v_resource,
        v_payment.credit_amount
    );

    update public.payments
       set entitlement_granted_at = v_now
     where id = p_payment_id;

    return query select true, v_payment.kind::text, v_payment.credit_amount;
end;
$$;


-- ====================== 00014_atomic_quota_consume.sql ======================
-- ============================================
-- 00014_atomic_quota_consume.sql
--
-- consume_quota 는 한도 확인 없이 used 를 증가시키므로, 사전 check_user_quota 와
-- 분리된 상태에서 동시 요청이 동일 사용자에 대해 둘 다 사전 체크를 통과한 뒤
-- 동시에 차감되어 한도를 초과할 수 있다.
--
-- consume_quota_checked 는 한 트랜잭션 안에서 usage_quotas 행을 FOR UPDATE 로 잠그고
-- 한도 확인 → 차감을 원자적으로 수행한다. 한도 초과면 ok=false 를 반환하고 used 는
-- 증가시키지 않는다.
--
-- 기존 consume_quota / check_user_quota 는 그대로 유지 — checkQuota 는 UI 표시 등
-- non-enforcing 경로에서 계속 사용 가능.
-- ============================================

create or replace function public.consume_quota_checked(
    p_user_id  uuid,
    p_resource text,             -- 'questions' | 'uploads' | 'images'
    p_amount   integer default 1
)
returns table (
    ok                boolean,
    plan_tier         plan_tier,
    limit_amount      integer,
    used_amount       integer,
    bonus_amount      integer,
    remaining         integer
)
language plpgsql
as $$
declare
    v_quota   public.usage_quotas;
    v_user    public.users;
    v_limit   integer;
    v_used    integer;
    v_bonus   integer;
    v_remain  integer;
    v_period  record;
begin
    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    select * into v_period from public.current_quota_period();

    -- 행이 없으면 먼저 생성 (race-safe: on conflict do nothing).
    insert into public.usage_quotas (user_id, period_start, period_end)
    values (p_user_id, v_period.period_start, v_period.period_end)
    on conflict (user_id, period_start) do nothing;

    -- 행 잠금 — 동일 사용자에 대한 동시 호출은 여기서 직렬화.
    select * into v_quota
      from public.usage_quotas
     where user_id = p_user_id
       and period_start = v_period.period_start
     for update;

    -- 플랜별 한도
    v_limit := case v_user.plan_tier
        when 'free'     then case p_resource when 'questions' then 50   when 'uploads' then 1  when 'images' then 5   else 0 end
        when 'lite'     then case p_resource when 'questions' then 150  when 'uploads' then 5  when 'images' then 20  else 0 end
        when 'standard' then case p_resource when 'questions' then 400  when 'uploads' then 15 when 'images' then 60  else 0 end
        when 'pro'      then case p_resource when 'questions' then 1000 when 'uploads' then 50 when 'images' then 200 else 0 end
        else 0
    end;

    v_used := case p_resource
        when 'questions' then v_quota.questions_used
        when 'uploads'   then v_quota.uploads_used
        when 'images'    then v_quota.images_used
        else 0 end;
    v_bonus := case p_resource
        when 'questions' then v_quota.bonus_questions
        when 'uploads'   then v_quota.bonus_uploads
        when 'images'    then v_quota.bonus_images
        else 0 end;

    v_remain := (v_limit + v_bonus) - v_used;

    if v_remain < p_amount then
        -- 한도 초과 — used 는 그대로 두고 ok=false 반환.
        return query select
            false,
            v_user.plan_tier,
            v_limit,
            v_used,
            v_bonus,
            greatest(0, v_remain);
        return;
    end if;

    -- 한도 내 → 원자적으로 차감.
    update public.usage_quotas
       set questions_used = case when p_resource = 'questions' then questions_used + p_amount else questions_used end,
           uploads_used   = case when p_resource = 'uploads'   then uploads_used + p_amount   else uploads_used   end,
           images_used    = case when p_resource = 'images'    then images_used + p_amount    else images_used    end,
           updated_at     = now()
     where user_id = p_user_id
       and period_start = v_period.period_start;

    return query select
        true,
        v_user.plan_tier,
        v_limit,
        v_used + p_amount,
        v_bonus,
        greatest(0, v_remain - p_amount);
end;
$$;


-- ====================== 00015_lock_sensitive_rpc_privileges.sql ======================
-- ============================================
-- 00015_lock_sensitive_rpc_privileges.sql
--
-- 모든 quota / payment / operational RPC 의 EXECUTE 권한을 잠근다.
-- Postgres 함수는 기본적으로 PUBLIC 에 EXECUTE 가 GRANT 되어 있어 anon /
-- authenticated 등 클라이언트가 직접 호출할 수 있다. PostgREST 의 /rest/v1/rpc/...
-- 엔드포인트도 이 권한으로 판단되므로, 로그인한 사용자가 본인 보너스 크레딧을
-- 늘리거나 음수 amount 로 사용량을 줄이는 식의 abuse 가 가능하다.
--
-- 본 마이그레이션은:
--   1) PUBLIC / anon / authenticated 의 EXECUTE 를 REVOKE
--   2) service_role 에만 GRANT
-- 함으로써 클라이언트 직접 RPC 호출을 차단하고, 서버 측 admin client
-- (createAdminClient) 경로만 통과시킨다.
--
-- 예외:
--   - public.is_admin(uuid)
--       RLS 정책(ai_cost_log_admin_read, ops_alerts admin, open_images admin)에서
--       authenticated 가 admin 인지 평가할 때 호출되므로 authenticated 에 EXECUTE
--       를 유지해야 한다. anon 에는 GRANT 하지 않음 (anon 은 정의상 admin 일 수 없음).
--
--   - 트리거 함수(set_updated_at, handle_new_auth_user,
--     prevent_user_privilege_escalation, enqueue_cohort_score_recalc)
--       DB 엔진이 직접 fire 하므로 호출자 EXECUTE 검사를 거치지 않지만, 명시적
--       직접 호출(보안 우회 시도)을 차단하기 위해 동일하게 잠근다.
--
--   - pg_cron 잡(reset_expired_bonuses, process_cohort_score_recalc_queue)
--       postgres 슈퍼유저가 cron 으로 실행하므로 EXECUTE 검사를 우회한다.
--       명시적 직접 호출은 같은 정책으로 차단.
--
--   - 내부 helper(calc_user_weight, current_quota_period, ensure_quota_row)
--       다른 RPC 본문에서 호출된다. SECURITY INVOKER 라 호출자(service_role)
--       권한이 필요하므로 service_role 에만 GRANT.
--
-- 주의: 본 마이그레이션을 적용한 뒤에는 createBrowserClient / createServerClient
-- 에서 위 함수들을 .rpc(...) 로 직접 호출하면 실패한다. 모든 RPC 호출은
-- createAdminClient (service_role) 를 통해야 한다. 현재 코드 베이스는 이미
-- 모든 .rpc(...) 호출이 admin client 경로를 사용하도록 정리돼 있다.
-- ============================================

do $$
declare
    fn        text;
    sensitive text[] := array[
        -- quota / bonus
        'public.ensure_quota_row(uuid)',
        'public.current_quota_period(timestamptz)',
        'public.check_user_quota(uuid, text, integer)',
        'public.consume_quota(uuid, text, integer)',
        'public.consume_quota_checked(uuid, text, integer)',
        'public.add_bonus_credits(uuid, text, integer)',
        'public.apply_payment_credit_bonus(uuid)',
        'public.reset_expired_bonuses()',

        -- AI cost / admin
        'public.daily_ai_cost_usd()',
        'public.check_daily_cost_within(numeric)',

        -- 코호트 / bandit
        'public.calc_user_weight(uuid)',
        'public.recalc_cohort_subtopic_score(uuid, uuid)',
        'public.detect_curriculum_drift(uuid)',
        'public.cohort_active_users(uuid, integer)',
        'public.process_cohort_score_recalc_queue()',

        -- 임베딩 검색 / 통계
        'public.match_questions(vector, real, integer, uuid[], uuid[])',
        'public.match_open_images(vector, double precision, integer, medical_image_type, uuid[])',
        'public.increment_question_stats(uuid, boolean)',

        -- 트리거 함수 (직접 호출 차단용)
        'public.set_updated_at()',
        'public.handle_new_auth_user()',
        'public.prevent_user_privilege_escalation()',
        'public.enqueue_cohort_score_recalc()'
    ];
begin
    foreach fn in array sensitive loop
        execute format('revoke execute on function %s from public;', fn);
        execute format('revoke execute on function %s from anon;', fn);
        execute format('revoke execute on function %s from authenticated;', fn);
        execute format('grant execute on function %s to service_role;', fn);
    end loop;
end $$;

-- ──────────────────────────────────────────
-- is_admin(uuid) — RLS 정책 평가용. authenticated 에 EXECUTE 권한 유지.
-- ──────────────────────────────────────────
revoke execute on function public.is_admin(uuid) from public;
revoke execute on function public.is_admin(uuid) from anon;
grant  execute on function public.is_admin(uuid) to authenticated;
grant  execute on function public.is_admin(uuid) to service_role;


-- ====================== 00016_quota_rpc_input_validation.sql ======================
-- ============================================
-- 00016_quota_rpc_input_validation.sql
--
-- quota / bonus RPC 에 입력 검증 추가.
--   - p_amount: NOT NULL, > 0
--   - p_resource: NOT NULL, in ('questions', 'uploads', 'images')
--
-- 잘못된 입력은 프로그래밍/abuse 오류이므로 SQL state 22023(invalid_parameter_value)
-- 으로 raise exception. 한도 초과는 기존 정책 그대로 consume_quota_checked 에서
-- ok=false 로 반환 (정책 변경 없음).
--
-- 00015 가 EXECUTE 권한을 service_role 로 잠그긴 했지만, 운영 코드(서버)에서도
-- amount=0 / 음수 / 잘못된 resource 가 들어오면 즉시 실패하도록 방어선을 둔다.
-- ============================================

create or replace function public.check_user_quota(
    p_user_id  uuid,
    p_resource text,
    p_amount   integer default 1
)
returns table (
    ok                boolean,
    plan_tier         plan_tier,
    limit_amount      integer,
    used_amount       integer,
    bonus_amount      integer,
    remaining         integer
)
language plpgsql
as $$
declare
    v_quota   public.usage_quotas;
    v_user    public.users;
    v_limit   integer;
    v_used    integer;
    v_bonus   integer;
    v_remain  integer;
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images', p_resource
            using errcode = '22023';
    end if;

    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    v_limit := case v_user.plan_tier
        when 'free'     then case p_resource when 'questions' then 50   when 'uploads' then 1  when 'images' then 5   else 0 end
        when 'lite'     then case p_resource when 'questions' then 150  when 'uploads' then 5  when 'images' then 20  else 0 end
        when 'standard' then case p_resource when 'questions' then 400  when 'uploads' then 15 when 'images' then 60  else 0 end
        when 'pro'      then case p_resource when 'questions' then 1000 when 'uploads' then 50 when 'images' then 200 else 0 end
        else 0
    end;

    v_used  := case p_resource
        when 'questions' then v_quota.questions_used
        when 'uploads'   then v_quota.uploads_used
        when 'images'    then v_quota.images_used
        else 0 end;
    v_bonus := case p_resource
        when 'questions' then v_quota.bonus_questions
        when 'uploads'   then v_quota.bonus_uploads
        when 'images'    then v_quota.bonus_images
        else 0 end;

    v_remain := (v_limit + v_bonus) - v_used;

    return query select
        (v_remain >= p_amount) as ok,
        v_user.plan_tier,
        v_limit,
        v_used,
        v_bonus,
        greatest(0, v_remain);
end;
$$;

create or replace function public.consume_quota(
    p_user_id  uuid,
    p_resource text,
    p_amount   integer default 1
)
returns void
language plpgsql
as $$
declare
    v_quota public.usage_quotas;
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images', p_resource
            using errcode = '22023';
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    update public.usage_quotas
       set questions_used = case when p_resource = 'questions' then questions_used + p_amount else questions_used end,
           uploads_used   = case when p_resource = 'uploads'   then uploads_used + p_amount   else uploads_used   end,
           images_used    = case when p_resource = 'images'    then images_used + p_amount    else images_used    end,
           updated_at     = now()
     where user_id = p_user_id
       and period_start = v_quota.period_start;
end;
$$;

create or replace function public.add_bonus_credits(
    p_user_id  uuid,
    p_resource text,
    p_amount   integer
)
returns void
language plpgsql
as $$
declare
    v_quota public.usage_quotas;
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images', p_resource
            using errcode = '22023';
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    update public.usage_quotas
       set bonus_questions = case when p_resource = 'questions' then bonus_questions + p_amount else bonus_questions end,
           bonus_uploads   = case when p_resource = 'uploads'   then bonus_uploads + p_amount   else bonus_uploads   end,
           bonus_images    = case when p_resource = 'images'    then bonus_images + p_amount    else bonus_images    end,
           updated_at      = now()
     where user_id = p_user_id
       and period_start = v_quota.period_start;
end;
$$;

create or replace function public.consume_quota_checked(
    p_user_id  uuid,
    p_resource text,
    p_amount   integer default 1
)
returns table (
    ok                boolean,
    plan_tier         plan_tier,
    limit_amount      integer,
    used_amount       integer,
    bonus_amount      integer,
    remaining         integer
)
language plpgsql
as $$
declare
    v_quota   public.usage_quotas;
    v_user    public.users;
    v_limit   integer;
    v_used    integer;
    v_bonus   integer;
    v_remain  integer;
    v_period  record;
begin
    if p_amount is null or p_amount <= 0 then
        raise exception 'p_amount must be a positive integer (got %)', p_amount
            using errcode = '22023';
    end if;
    if p_resource is null or p_resource not in ('questions', 'uploads', 'images') then
        raise exception 'invalid p_resource (%): must be one of questions|uploads|images', p_resource
            using errcode = '22023';
    end if;

    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    select * into v_period from public.current_quota_period();

    insert into public.usage_quotas (user_id, period_start, period_end)
    values (p_user_id, v_period.period_start, v_period.period_end)
    on conflict (user_id, period_start) do nothing;

    select * into v_quota
      from public.usage_quotas
     where user_id = p_user_id
       and period_start = v_period.period_start
     for update;

    v_limit := case v_user.plan_tier
        when 'free'     then case p_resource when 'questions' then 50   when 'uploads' then 1  when 'images' then 5   else 0 end
        when 'lite'     then case p_resource when 'questions' then 150  when 'uploads' then 5  when 'images' then 20  else 0 end
        when 'standard' then case p_resource when 'questions' then 400  when 'uploads' then 15 when 'images' then 60  else 0 end
        when 'pro'      then case p_resource when 'questions' then 1000 when 'uploads' then 50 when 'images' then 200 else 0 end
        else 0
    end;

    v_used := case p_resource
        when 'questions' then v_quota.questions_used
        when 'uploads'   then v_quota.uploads_used
        when 'images'    then v_quota.images_used
        else 0 end;
    v_bonus := case p_resource
        when 'questions' then v_quota.bonus_questions
        when 'uploads'   then v_quota.bonus_uploads
        when 'images'    then v_quota.bonus_images
        else 0 end;

    v_remain := (v_limit + v_bonus) - v_used;

    if v_remain < p_amount then
        return query select
            false,
            v_user.plan_tier,
            v_limit,
            v_used,
            v_bonus,
            greatest(0, v_remain);
        return;
    end if;

    update public.usage_quotas
       set questions_used = case when p_resource = 'questions' then questions_used + p_amount else questions_used end,
           uploads_used   = case when p_resource = 'uploads'   then uploads_used + p_amount   else uploads_used   end,
           images_used    = case when p_resource = 'images'    then images_used + p_amount    else images_used    end,
           updated_at     = now()
     where user_id = p_user_id
       and period_start = v_period.period_start;

    return query select
        true,
        v_user.plan_tier,
        v_limit,
        v_used + p_amount,
        v_bonus,
        greatest(0, v_remain - p_amount);
end;
$$;


-- ====================== 00017_private_question_images.sql ======================
-- ──────────────────────────────────────────
-- private_question_images — 개인 문제에 연결된 의료 이미지
-- ──────────────────────────────────────────
-- 강의록 PDF 에서 검출·crop 한 의료 이미지(EKG, X-ray, CT, 해부도 등)를
-- Storage(user_uploads 버킷)에 저장하고 생성된 문제에 연결한다.
-- 한 문제에 여러 이미지(EKG+CXR 비교, CT 다중 slice, gross+micro 등)가
-- 가능하도록 1:N 연결 테이블로 둔다.
-- 풀이 화면은 storage_path 로 signed URL 을 만들어 렌더링한다.

create table public.private_question_images (
    id                  uuid primary key default uuid_generate_v4(),
    private_question_id uuid not null references public.private_questions(id) on delete cascade,
    user_id             uuid not null references public.users(id) on delete cascade,
    upload_id           uuid not null references public.user_uploads(id) on delete cascade,
    storage_path        text not null,
    source_page         integer,
    kind                text,
    caption             text,
    sort_order          smallint not null default 0,
    created_at          timestamptz not null default now()
);

create index idx_pq_images_question
    on public.private_question_images(private_question_id, sort_order);
create index idx_pq_images_upload
    on public.private_question_images(upload_id);

comment on table public.private_question_images is
    '개인 문제(private_questions)에 연결된 의료 이미지. Storage(user_uploads 버킷) 경로 참조.';

-- RLS — 본인 것만 (private_questions 정책과 동일 패턴)
alter table public.private_question_images enable row level security;

create policy "pq_images_read_own" on public.private_question_images
    for select using (auth.uid() = user_id);

create policy "pq_images_insert_own" on public.private_question_images
    for insert with check (auth.uid() = user_id);

create policy "pq_images_delete_own" on public.private_question_images
    for delete using (auth.uid() = user_id);


-- ====================== 00018_private_attempts.sql ======================
-- ──────────────────────────────────────────
-- user_attempts 를 private 문제 풀이도 기록하도록 확장
-- ──────────────────────────────────────────
-- 기존 question_id 는 public questions 전용(NOT NULL FK)이라 private_questions
-- 풀이를 기록할 수 없었다. private_question_id 를 추가하고 question_id 를 nullable 로
-- 풀어, track 에 따라 정확히 한 쪽만 채우게 한다.
--   - track='smart_practice' → question_id (public)
--   - track='lecture_note'   → private_question_id (개인)

alter table public.user_attempts
  alter column question_id drop not null;

alter table public.user_attempts
  add column private_question_id uuid
    references public.private_questions(id) on delete cascade;

-- 정확히 한 쪽만 채워져야 한다 (XOR).
alter table public.user_attempts
  add constraint user_attempts_question_xor check (
    (question_id is not null and private_question_id is null) or
    (question_id is null and private_question_id is not null)
  );

create index idx_attempts_private_question
  on public.user_attempts(private_question_id)
  where private_question_id is not null;


-- ====================== 00019_app_features.sql ======================
-- ====================================================================
-- 00019_app_features.sql
-- 렉처링크 웹 개발 기획서 반영 — 앱 기능 테이블
--   1) 회원가입 추가 필드 (이용 목적 / 추천인 / 알게된 경로)
--   2) 시험 일정 (마이페이지 캘린더)
--   3) 오답노트 저장 (사용자가 체크한 오답만)
--   4) 모의고사 세션 (CBT)
-- ====================================================================

-- ──────────────────────────────────────────
-- 1) 회원가입 추가 필드
--    기획서: 학교/학년/이용 목적(내신·국시·기타)/추천인 코드(선택)/알게된 경로(선택)
-- ──────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'study_purpose') then
    create type study_purpose as enum ('naesin', 'kmle', 'usmle', 'other');
  end if;
end$$;

alter table public.users
  add column if not exists study_purpose       study_purpose,
  add column if not exists referral_code        text,
  add column if not exists acquisition_channel  text;

-- ──────────────────────────────────────────
-- 2) 시험 일정 (캘린더)
--    각 사용자가 직접 시험 일정을 추가, D-day 알림 + 학습 진행도 시각화 기준점
-- ──────────────────────────────────────────
create table if not exists public.exam_schedules (
    id          uuid primary key default uuid_generate_v4(),
    user_id     uuid not null references public.users(id) on delete cascade,
    title       text not null,                 -- 예: '순환기 중간고사'
    exam_date   date not null,
    subject_id  uuid references public.subjects(id),
    memo        text,
    color       text not null default 'sage',  -- UI 색상 키
    created_at  timestamptz not null default now()
);

create index if not exists idx_exam_schedules_user_date
    on public.exam_schedules(user_id, exam_date);

-- ──────────────────────────────────────────
-- 3) 오답노트 저장
--    기획서: 문제 풀이 후 '체크한 문제 한정' 오답노트 생성.
--    question_id 또는 private_question_id 중 하나가 채워진다.
-- ──────────────────────────────────────────
create table if not exists public.saved_wrong_questions (
    id                   uuid primary key default uuid_generate_v4(),
    user_id              uuid not null references public.users(id) on delete cascade,
    question_id          uuid references public.questions(id) on delete cascade,
    private_question_id  uuid references public.private_questions(id) on delete cascade,
    sub_topic_id         uuid references public.sub_topics(id),
    -- 풀이 당시 사용자가 고른 오답 인덱스 (다시 풀기 비교용)
    selected_index       smallint,
    source               text not null default 'exam',  -- exam | mock | practice | lecture_note
    resolved             boolean not null default false, -- 다시 풀어서 맞춤
    created_at           timestamptz not null default now(),

    -- 같은 문제는 한 번만 노트에 담기 (question / private 각각)
    unique (user_id, question_id),
    unique (user_id, private_question_id)
);

create index if not exists idx_saved_wrong_user
    on public.saved_wrong_questions(user_id, created_at desc);
create index if not exists idx_saved_wrong_subtopic
    on public.saved_wrong_questions(user_id, sub_topic_id);

-- ──────────────────────────────────────────
-- 4) 모의고사 세션 (CBT)
--    국가고시 대비 이상 플랜에서 사용. 저장된 풀에서 문항을 가져와 세트 구성.
-- ──────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'mock_exam_status') then
    create type mock_exam_status as enum ('in_progress', 'submitted', 'abandoned');
  end if;
end$$;

create table if not exists public.mock_exam_sessions (
    id                uuid primary key default uuid_generate_v4(),
    user_id           uuid not null references public.users(id) on delete cascade,
    title             text not null,
    subject_ids       uuid[] not null default '{}',
    question_ids      uuid[] not null default '{}',   -- 출제 순서대로
    -- answers[i] = 사용자가 i번 문항에 선택한 index (-1 = 미응답)
    answers           jsonb not null default '[]',
    flagged           jsonb not null default '[]',    -- 표시한 문항 index 배열
    memo              text,
    status            mock_exam_status not null default 'in_progress',
    score             integer,                        -- 맞힌 개수 (제출 후)
    total             integer not null default 0,
    duration_seconds  integer,                        -- 제한 시간 (있으면)
    started_at        timestamptz not null default now(),
    submitted_at      timestamptz,
    created_at        timestamptz not null default now()
);

create index if not exists idx_mock_sessions_user
    on public.mock_exam_sessions(user_id, created_at desc);

-- ──────────────────────────────────────────
-- RLS — 모두 본인 데이터만 접근
-- ──────────────────────────────────────────
alter table public.exam_schedules        enable row level security;
alter table public.saved_wrong_questions  enable row level security;
alter table public.mock_exam_sessions     enable row level security;

drop policy if exists "exam_schedules_own" on public.exam_schedules;
create policy "exam_schedules_own" on public.exam_schedules
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "saved_wrong_own" on public.saved_wrong_questions;
create policy "saved_wrong_own" on public.saved_wrong_questions
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "mock_sessions_own" on public.mock_exam_sessions;
create policy "mock_sessions_own" on public.mock_exam_sessions
    for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- ====================== 00020_kmle_toc_hierarchy.sql ======================
-- ====================================================================
-- 00020_kmle_toc_hierarchy.sql
-- 국시 KMLE 목차 반영 — sub_topics 3단계 계층화
--   과목(subjects) > 중주제(sub_topics level=1) > 소주제(sub_topics level=2)
-- ====================================================================

-- sub_topics 에 self-reference parent_id + level
alter table public.sub_topics
  add column if not exists parent_id uuid references public.sub_topics(id) on delete cascade,
  add column if not exists level     smallint not null default 1;

create index if not exists idx_sub_topics_parent on public.sub_topics(parent_id);
create index if not exists idx_sub_topics_subject_level on public.sub_topics(subject_id, level);

-- subjects 에 대분류 카테고리 (예: '내분비 · 알레르기')
alter table public.subjects
  add column if not exists category text;


-- ====================== 00021_plan_pricing_v2.sql ======================
-- ============================================
-- 00021_plan_pricing_v2.sql
--
-- 요금제 개편(기획서 기준) — DB 반영분.
--  · plan_tier 에 'unlimited'(통합형 무제한) 추가
--  · 플랜별 월 한도 갱신:
--      내신 대비(lite)     : 문항 500 / 업로드 10 / 이미지 30   (₩7,900)
--      국가고시 대비(standard): 문항 500 / 업로드 5  / 이미지 40   (₩9,900)
--      통합형(pro)         : 문항 2000 / 업로드 100 / 이미지 200  (₩14,900)
--      통합형 무제한(unlimited): 사실상 무제한(999999)            (₩20,900)
--
-- ⚠️ 적용 방법: Supabase SQL Editor(또는 psql)에서 실행. (앱 런타임은 DB 함수를
--    통해 한도를 강제하므로, 이 파일을 적용해야 새 한도/티어가 실제로 반영된다.)
--    함수는 plan_tier 를 ::text 로 비교하므로 ADD VALUE 와 같은 트랜잭션에서도 안전.
--
-- 가격 표시/결제금액(프론트·PLAN_PRICES)은 앱 코드에서 이미 갱신됨.
-- ============================================

-- 1) 새 티어 값 추가 (이미 있으면 무시)
alter type plan_tier add value if not exists 'unlimited';

-- 2) 한도 확인 함수 (표시/비강제 경로)
create or replace function public.check_user_quota(
    p_user_id  uuid,
    p_resource text,
    p_amount   integer default 1
)
returns table (
    ok                boolean,
    plan_tier         plan_tier,
    limit_amount      integer,
    used_amount       integer,
    bonus_amount      integer,
    remaining         integer
)
language plpgsql
as $$
declare
    v_quota   public.usage_quotas;
    v_user    public.users;
    v_limit   integer;
    v_used    integer;
    v_bonus   integer;
    v_remain  integer;
begin
    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    v_quota := public.ensure_quota_row(p_user_id);

    v_limit := case v_user.plan_tier::text
        when 'free'      then case p_resource when 'questions' then 50     when 'uploads' then 1      when 'images' then 5      else 0 end
        when 'lite'      then case p_resource when 'questions' then 500    when 'uploads' then 10     when 'images' then 30     else 0 end
        when 'standard'  then case p_resource when 'questions' then 500    when 'uploads' then 5      when 'images' then 40     else 0 end
        when 'pro'       then case p_resource when 'questions' then 2000   when 'uploads' then 100    when 'images' then 200    else 0 end
        when 'unlimited' then case p_resource when 'questions' then 999999 when 'uploads' then 999999 when 'images' then 999999 else 0 end
        else 0
    end;

    v_used  := case p_resource
        when 'questions' then v_quota.questions_used
        when 'uploads'   then v_quota.uploads_used
        when 'images'    then v_quota.images_used
        else 0 end;
    v_bonus := case p_resource
        when 'questions' then v_quota.bonus_questions
        when 'uploads'   then v_quota.bonus_uploads
        when 'images'    then v_quota.bonus_images
        else 0 end;

    v_remain := (v_limit + v_bonus) - v_used;

    return query select
        (v_remain >= p_amount) as ok,
        v_user.plan_tier,
        v_limit,
        v_used,
        v_bonus,
        greatest(0, v_remain);
end;
$$;

-- 3) 원자적 차감 함수 (강제 경로)
create or replace function public.consume_quota_checked(
    p_user_id  uuid,
    p_resource text,
    p_amount   integer default 1
)
returns table (
    ok                boolean,
    plan_tier         plan_tier,
    limit_amount      integer,
    used_amount       integer,
    bonus_amount      integer,
    remaining         integer
)
language plpgsql
as $$
declare
    v_quota   public.usage_quotas;
    v_user    public.users;
    v_limit   integer;
    v_used    integer;
    v_bonus   integer;
    v_remain  integer;
    v_period  record;
begin
    select * into v_user from public.users where id = p_user_id;
    if not found then
        return query select false, 'free'::plan_tier, 0, 0, 0, 0;
        return;
    end if;

    select * into v_period from public.current_quota_period();

    insert into public.usage_quotas (user_id, period_start, period_end)
    values (p_user_id, v_period.period_start, v_period.period_end)
    on conflict (user_id, period_start) do nothing;

    select * into v_quota
      from public.usage_quotas
     where user_id = p_user_id
       and period_start = v_period.period_start
     for update;

    v_limit := case v_user.plan_tier::text
        when 'free'      then case p_resource when 'questions' then 50     when 'uploads' then 1      when 'images' then 5      else 0 end
        when 'lite'      then case p_resource when 'questions' then 500    when 'uploads' then 10     when 'images' then 30     else 0 end
        when 'standard'  then case p_resource when 'questions' then 500    when 'uploads' then 5      when 'images' then 40     else 0 end
        when 'pro'       then case p_resource when 'questions' then 2000   when 'uploads' then 100    when 'images' then 200    else 0 end
        when 'unlimited' then case p_resource when 'questions' then 999999 when 'uploads' then 999999 when 'images' then 999999 else 0 end
        else 0
    end;

    v_used := case p_resource
        when 'questions' then v_quota.questions_used
        when 'uploads'   then v_quota.uploads_used
        when 'images'    then v_quota.images_used
        else 0 end;
    v_bonus := case p_resource
        when 'questions' then v_quota.bonus_questions
        when 'uploads'   then v_quota.bonus_uploads
        when 'images'    then v_quota.bonus_images
        else 0 end;

    v_remain := (v_limit + v_bonus) - v_used;

    if v_remain < p_amount then
        return query select
            false,
            v_user.plan_tier,
            v_limit,
            v_used,
            v_bonus,
            greatest(0, v_remain);
        return;
    end if;

    update public.usage_quotas
       set questions_used = case when p_resource = 'questions' then questions_used + p_amount else questions_used end,
           uploads_used   = case when p_resource = 'uploads'   then uploads_used + p_amount   else uploads_used   end,
           images_used    = case when p_resource = 'images'    then images_used + p_amount    else images_used    end,
           updated_at     = now()
     where user_id = p_user_id
       and period_start = v_period.period_start;

    return query select
        true,
        v_user.plan_tier,
        v_limit,
        v_used + p_amount,
        v_bonus,
        greatest(0, v_remain - p_amount);
end;
$$;
