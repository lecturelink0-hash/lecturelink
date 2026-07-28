-- ============================================
-- 00028_question_revisions.sql
--
-- 문항 수정 이력.
--
-- questions 테이블에는 updated_at 트리거만 있고 이력이 없다. 지금 상태로
-- UPDATE 하면 수정 전 내용이 영구 소실된다. 국시형 형식으로 문항을 일괄
-- 재작성하려면 되돌릴 수 있어야 하므로, 수정 전·후 전체 스냅샷을 남긴다.
--
-- 스냅샷을 jsonb 통째로 두는 이유: 컬럼이 늘어도 마이그레이션이 필요 없고,
-- 복구할 때 그 시점의 문항을 그대로 되살릴 수 있다.
-- ============================================

create table if not exists public.question_revisions (
    id            uuid primary key default uuid_generate_v4(),
    question_id   uuid not null references public.questions(id) on delete cascade,

    -- 같은 문항에 대한 순번. 1부터 시작해 수정할 때마다 증가한다.
    revision      integer not null,

    -- 수정 직전 문항 전체(jsonb) — 복구의 근거가 되는 값이다.
    before_data   jsonb not null,
    -- 수정 직후 문항 전체(jsonb). 복구 작업이면 null 이 아니라 복구된 값이 들어간다.
    after_data    jsonb not null,

    -- 왜 고쳤는지. 예: 'kmle-format-v2', 'restore:3'
    reason        text not null,
    -- 적용한 형식 규격 버전. 예: 'F01~F23 v2'
    ruleset       text,
    -- 스크립트 실행자 또는 admin user id. 사람이 아닌 배치면 'script:<이름>'.
    actor         text not null,

    created_at    timestamptz not null default now(),

    unique (question_id, revision)
);

create index if not exists question_revisions_question_idx
    on public.question_revisions (question_id, revision desc);
create index if not exists question_revisions_created_idx
    on public.question_revisions (created_at desc);

comment on table public.question_revisions is
    '문항 수정 이력. 수정 전·후 전체 스냅샷을 남겨 언제든 되돌릴 수 있게 한다.';

-- RLS: questions 와 같은 방침 — 읽기는 인증 사용자, 쓰기는 service_role 만.
-- (service_role 은 RLS 를 우회하므로 별도 정책이 필요 없다.)
alter table public.question_revisions enable row level security;

do $$ begin
    create policy "question_revisions_authenticated_read"
        on public.question_revisions
        for select using (auth.role() = 'authenticated');
exception when duplicate_object then null; end $$;

-- 다음 revision 번호를 계산한다. 동시 실행 시 unique 제약이 최종 방어선이다.
create or replace function public.next_question_revision(p_question_id uuid)
returns integer
language sql
stable
as $$
    select coalesce(max(revision), 0) + 1
    from public.question_revisions
    where question_id = p_question_id;
$$;
