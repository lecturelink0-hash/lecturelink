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
