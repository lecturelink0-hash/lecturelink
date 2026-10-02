-- 00045: RAG 인덱스 — 청크·문항 임베딩, 검색 RPC (RAG 실행계획 v1.1 · 0-e · 5.3)
--
-- PRIVATE_RAG_MODE=off(기본)에서는 아무 코드도 이 컬럼·함수를 쓰지 않는다. 적용만으로 운영 동작은
-- 바뀌지 않는다. shadow 부터 청크 임베딩이 채워지고, on(Phase 1)부터 검색이 이 함수를 부른다.
--
-- 5.3 스케치에서 바꾼 것 (E1~E3 결과 · docs/naesin-rag-candidates/e1-e3-results.md)
--  1) **HNSW 인덱스를 만들지 않는다.** 검색은 늘 업로드 하나(청크 수십~수백 개) 안에서 한다.
--     upload_id 인덱스로 좁힌 뒤 정확 거리 정렬이 더 빠르고 정확하다. HNSW 를 두면 플래너가 전역
--     근사 검색 뒤 upload_id 로 거르는 계획을 고를 수 있고, 그러면 결과가 k 개보다 적게 나온다.
--     문항 중복 검사(match_private_questions)도 같은 사용자·같은 자료 안에서만 비교해 마찬가지다.
--  2) **pg_trgm GIN 인덱스를 만들지 않는다.** E3 에서 sparse(RRF) 결합이 dense 단독보다 Recall 이
--     0.01 넘게 낮아 채택하지 않았다. 쓰지 않는 인덱스는 청크 저장마다 쓰기 비용만 든다.
--  3) 행마다 embedding_model·embedding_sha 를 남긴다. 모델이 다른 벡터끼리는 비교할 수 없고,
--     청크 내용이 바뀌면(같은 번호에 다른 OCR) 예전 벡터가 새 내용을 대변하지 못한다.
--  4) parent_id 는 ON UPDATE CASCADE — 0-c 의 청크 id 는 내용이 바뀌면 upsert 로 바뀐다.
--
-- 벡터 차원 1024 는 E1 후보 모델(voyage-3·voyage-4·gemini-embedding-2)이 모두 지원한다.

-- ── material_chunks ─────────────────────────────────────────────────────────
alter table public.material_chunks
    add column if not exists embedding       vector(1024),
    -- 이 벡터를 만든 모델. 검색은 같은 모델의 벡터끼리만 한다.
    add column if not exists embedding_model text,
    -- 임베딩할 때의 content_sha. 지금 content_sha 와 다르면 벡터가 낡은 것이다.
    add column if not exists embedding_sha   text,
    add column if not exists embedded_at     timestamptz,
    -- 부모(페이지·슬라이드 = level 0) 청크. E2 에서 부모 확장을 채택하지 않아 지금은 비어 있다.
    add column if not exists parent_id       uuid,
    add column if not exists level           smallint not null default 1,
    -- 근거의 성격: 본문 / OCR / 이미지 캡션(PR F) / 표.
    add column if not exists modality        text not null default 'text',
    add column if not exists heading_path    text[],
    -- 캡션 청크가 가리키는 이미지(PR F).
    add column if not exists image_id        uuid;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'material_chunks_parent_fk') then
        alter table public.material_chunks
            add constraint material_chunks_parent_fk foreign key (parent_id)
            references public.material_chunks(id) on delete cascade on update cascade;
    end if;
    if not exists (select 1 from pg_constraint where conname = 'material_chunks_level_check') then
        alter table public.material_chunks
            add constraint material_chunks_level_check check (level in (0, 1));
    end if;
    if not exists (select 1 from pg_constraint where conname = 'material_chunks_modality_check') then
        alter table public.material_chunks
            add constraint material_chunks_modality_check
            check (modality in ('text', 'ocr', 'image_caption', 'table'));
    end if;
end $$;

-- kind 에 image_caption(PR F) 을 더한다. 00043 의 자동 이름 제약을 바꿔 끼운다.
alter table public.material_chunks drop constraint if exists material_chunks_kind_check;
alter table public.material_chunks
    add constraint material_chunks_kind_check check (kind in ('slide_text', 'ocr', 'image_caption'));

-- 기존 OCR 청크의 modality 를 kind 에 맞춘다(기본값 'text' 로 들어간 행).
update public.material_chunks set modality = 'ocr' where kind = 'ocr' and modality = 'text';

-- 인덱싱 대상 찾기(임베딩이 없거나 낡은 청크)가 업로드 단위 스캔으로 끝나게.
create index if not exists idx_material_chunks_upload_embedded
    on public.material_chunks(upload_id, embedding_model);

comment on column public.material_chunks.embedding is
    'RAG 청크 임베딩(1024, L2 정규화). embedding_model·embedding_sha 와 함께 읽는다 (RAG v1.1 0-e).';

-- ── private_questions ───────────────────────────────────────────────────────
alter table public.private_questions
    add column if not exists embedding       vector(1024),
    add column if not exists embedding_model text,
    -- 문항이 근거로 쓴 청크: [{chunk_id, page, quote, score, rank, role}] (RAG v1.1 5.2 K).
    add column if not exists evidence        jsonb;

comment on column public.private_questions.evidence is
    '문항 근거 — [{chunk_id, page, quote, score, rank, role}]. 검색 계층(on)에서만 채워진다 (RAG v1.1 5.2 K).';

-- ── 검색 RPC ────────────────────────────────────────────────────────────────

-- 업로드 하나 안에서 질의 벡터와 가까운 청크 k 개(정확 거리).
create or replace function public.match_material_chunks(
    p_upload_id uuid,
    p_query     vector(1024),
    p_k         integer default 20,
    p_model     text default null,
    p_modality  text[] default null
)
returns table (
    id          uuid,
    chunk_index integer,
    page_index  integer,
    kind        text,
    modality    text,
    text        text,
    similarity  double precision
)
language sql
stable
set search_path = public
as $$
    select c.id, c.chunk_index, c.page_index, c.kind, c.modality, c.text,
           1 - (c.embedding <=> p_query) as similarity
    from public.material_chunks c
    where c.upload_id = p_upload_id
      and c.embedding is not null
      and c.embedding_sha = c.content_sha
      and (p_model is null or c.embedding_model = p_model)
      and (p_modality is null or c.modality = any(p_modality))
    order by c.embedding <=> p_query
    limit greatest(1, least(coalesce(p_k, 20), 200));
$$;

-- 같은 사용자가 같은 자료(content_sha256)로 만든 문항 중 질의 문항과 가까운 것(세트 전체 중복, 5.2 J).
create or replace function public.match_private_questions(
    p_user_id        uuid,
    p_content_sha    text,
    p_query          vector(1024),
    p_threshold      double precision default 0.92,
    p_k              integer default 5,
    p_model          text default null,
    p_exclude_upload uuid default null
)
returns table (
    id         uuid,
    upload_id  uuid,
    stem       text,
    similarity double precision
)
language sql
stable
set search_path = public
as $$
    select q.id, q.upload_id, q.stem, 1 - (q.embedding <=> p_query) as similarity
    from public.private_questions q
    join public.user_uploads u on u.id = q.upload_id
    where q.user_id = p_user_id
      and u.user_id = p_user_id
      and u.content_sha256 = p_content_sha
      and q.embedding is not null
      and (p_model is null or q.embedding_model = p_model)
      and (p_exclude_upload is null or q.upload_id <> p_exclude_upload)
      and 1 - (q.embedding <=> p_query) >= p_threshold
    order by q.embedding <=> p_query
    limit greatest(1, least(coalesce(p_k, 5), 50));
$$;

-- 청크 임베딩을 한 번에 저장한다(modality 도 kind 에 맞춘다). p_rows = [{"id": uuid, "sha": text, "embedding": [..1024..]}].
-- 내용 지문이 그 사이 바뀐 행(동시 재처리)은 건너뛴다 — 낡은 벡터를 새 내용에 붙이지 않는다.
create or replace function public.rag_set_chunk_embeddings(
    p_upload_id uuid,
    p_model     text,
    p_rows      jsonb
)
returns integer
language plpgsql
set search_path = public
as $$
declare
    n integer;
begin
    update public.material_chunks c
       set embedding       = (r.embedding)::text::vector(1024),
           embedding_model = p_model,
           embedding_sha   = r.sha,
           embedded_at     = now(),
           -- 청크 저장 경로(00043 컬럼만 쓴다)는 modality 를 모르므로 여기서 kind 에 맞춘다.
           modality        = case c.kind when 'ocr' then 'ocr'
                                         when 'image_caption' then 'image_caption'
                                         else c.modality end
      from jsonb_to_recordset(p_rows) as r(id uuid, sha text, embedding jsonb)
     where c.id = r.id
       and c.upload_id = p_upload_id
       and c.content_sha = r.sha;
    get diagnostics n = row_count;
    return n;
end;
$$;

-- 세 함수 모두 서비스 롤 전용(생성 파이프라인이 admin client 로 부른다). 00015 와 같은 원칙.
do $$
declare
    fn text;
    fns text[] := array[
        'public.match_material_chunks(uuid, vector, integer, text, text[])',
        'public.match_private_questions(uuid, text, vector, double precision, integer, text, uuid)',
        'public.rag_set_chunk_embeddings(uuid, text, jsonb)'
    ];
begin
    foreach fn in array fns loop
        execute format('revoke execute on function %s from public;', fn);
        execute format('revoke execute on function %s from anon;', fn);
        execute format('revoke execute on function %s from authenticated;', fn);
        execute format('grant execute on function %s to service_role;', fn);
    end loop;
end $$;
