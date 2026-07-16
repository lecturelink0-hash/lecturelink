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
