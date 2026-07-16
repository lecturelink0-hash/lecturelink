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
