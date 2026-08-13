-- ====================================================================
-- 문제은행 검수 이력 및 승인 반영 함수
-- ====================================================================
-- 원칙:
--   - 질문 원문을 바꾸기 전후의 콘텐츠 스냅샷을 항상 남긴다.
--   - 오래된 JSON 초안이 최신 문항을 덮어쓰지 않도록 updated_at을 비교한다.
--   - 5지선다·정답 인덱스 검증을 DB 트랜잭션 안에서 강제한다.
--   - service_role만 이 함수를 실행할 수 있다.

create table if not exists public.question_revisions (
    id                  uuid primary key default uuid_generate_v4(),
    question_id         uuid not null references public.questions(id) on delete restrict,
    revision_number     integer not null,
    action              text not null check (action in ('apply', 'restore')),
    before_snapshot     jsonb not null,
    after_snapshot      jsonb not null,
    expected_updated_at timestamptz not null,
    source_content_hash text,
    batch_id            text,
    change_note         text,
    changed_by          uuid references public.users(id),
    approved_by         uuid references public.users(id),
    created_at          timestamptz not null default now(),
    unique (question_id, revision_number)
);

create index if not exists idx_question_revisions_question_created
    on public.question_revisions(question_id, created_at desc);
create index if not exists idx_question_revisions_batch
    on public.question_revisions(batch_id)
    where batch_id is not null;

alter table public.question_revisions enable row level security;

create or replace function public.apply_approved_question_revision(
    p_question_id uuid,
    p_expected_updated_at timestamptz,
    p_stem text,
    p_choices jsonb,
    p_answer_index smallint,
    p_explanation text,
    p_concepts text[],
    p_difficulty smallint,
    p_changed_by uuid default null,
    p_approved_by uuid default null,
    p_review_notes text default null,
    p_mark_curated boolean default false,
    p_batch_id text default null,
    p_change_note text default null,
    p_source_content_hash text default null,
    p_action text default 'apply'
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
    v_before public.questions;
    v_after public.questions;
    v_before_snapshot jsonb;
    v_after_snapshot jsonb;
    v_revision_number integer;
    v_revision_id uuid;
begin
    if p_action not in ('apply', 'restore') then
        raise exception '지원하지 않는 이력 작업입니다: %', p_action using errcode = '22023';
    end if;
    if p_expected_updated_at is null then
        raise exception 'expected_updated_at은 필수입니다.' using errcode = '22023';
    end if;
    if nullif(btrim(p_stem), '') is null then
        raise exception '문제 지문은 비어 있을 수 없습니다.' using errcode = '22023';
    end if;
    if jsonb_typeof(p_choices) <> 'array' or jsonb_array_length(p_choices) <> 5 then
        raise exception '선지는 정확히 5개여야 합니다.' using errcode = '22023';
    end if;
    if p_answer_index < 0 or p_answer_index >= jsonb_array_length(p_choices) then
        raise exception '정답 인덱스가 선지 범위를 벗어났습니다.' using errcode = '22023';
    end if;
    if exists (
        select 1 from jsonb_array_elements(p_choices) as choice(value)
        where jsonb_typeof(choice.value) <> 'string'
           or nullif(btrim(choice.value #>> '{}'), '') is null
    ) then
        raise exception '모든 선지는 비어 있지 않은 문자열이어야 합니다.' using errcode = '22023';
    end if;
    if p_difficulty not between 1 and 3 then
        raise exception '난이도는 1~3이어야 합니다.' using errcode = '22023';
    end if;
    if p_mark_curated and p_approved_by is null then
        raise exception 'curated 승격에는 승인자가 필요합니다.' using errcode = '22023';
    end if;

    select * into v_before
    from public.questions
    where id = p_question_id
    for update;

    if not found then
        raise exception '문항을 찾을 수 없습니다: %', p_question_id using errcode = 'P0002';
    end if;
    if v_before.updated_at is distinct from p_expected_updated_at then
        raise exception '문항이 내보낸 뒤 변경되었습니다. 새로 내보낸 JSON으로 다시 검수하세요.' using errcode = '40001';
    end if;

    v_before_snapshot := jsonb_build_object(
        'stem', v_before.stem,
        'choices', v_before.choices,
        'answer_index', v_before.answer_index,
        'explanation', v_before.explanation,
        'concepts', v_before.concepts,
        'difficulty', v_before.difficulty,
        'image_url', v_before.image_url,
        'image_type', v_before.image_type,
        'tier', v_before.tier,
        'reviewed_by', v_before.reviewed_by,
        'reviewed_at', v_before.reviewed_at,
        'review_notes', v_before.review_notes,
        'updated_at', v_before.updated_at
    );

    update public.questions
       set stem = p_stem,
           choices = p_choices,
           answer_index = p_answer_index,
           explanation = p_explanation,
           concepts = coalesce(p_concepts, '{}'::text[]),
           difficulty = p_difficulty,
           reviewed_by = case when p_approved_by is not null then p_approved_by else reviewed_by end,
           reviewed_at = case when p_approved_by is not null then now() else reviewed_at end,
           review_notes = coalesce(p_review_notes, review_notes),
           tier = case when p_mark_curated then 'curated'::public.content_tier else tier end
     where id = p_question_id
    returning * into v_after;

    v_after_snapshot := jsonb_build_object(
        'stem', v_after.stem,
        'choices', v_after.choices,
        'answer_index', v_after.answer_index,
        'explanation', v_after.explanation,
        'concepts', v_after.concepts,
        'difficulty', v_after.difficulty,
        'image_url', v_after.image_url,
        'image_type', v_after.image_type,
        'tier', v_after.tier,
        'reviewed_by', v_after.reviewed_by,
        'reviewed_at', v_after.reviewed_at,
        'review_notes', v_after.review_notes,
        'updated_at', v_after.updated_at
    );

    select coalesce(max(revision_number), 0) + 1
      into v_revision_number
      from public.question_revisions
     where question_id = p_question_id;

    insert into public.question_revisions (
        question_id, revision_number, action, before_snapshot, after_snapshot,
        expected_updated_at, source_content_hash, batch_id, change_note,
        changed_by, approved_by
    ) values (
        p_question_id, v_revision_number, p_action, v_before_snapshot, v_after_snapshot,
        p_expected_updated_at, p_source_content_hash, p_batch_id, p_change_note,
        p_changed_by, p_approved_by
    ) returning id into v_revision_id;

    return v_revision_id;
end;
$$;

revoke all on function public.apply_approved_question_revision(
    uuid, timestamptz, text, jsonb, smallint, text, text[], smallint,
    uuid, uuid, text, boolean, text, text, text, text
) from public, anon, authenticated;
grant execute on function public.apply_approved_question_revision(
    uuid, timestamptz, text, jsonb, smallint, text, text[], smallint,
    uuid, uuid, text, boolean, text, text, text, text
) to service_role;
