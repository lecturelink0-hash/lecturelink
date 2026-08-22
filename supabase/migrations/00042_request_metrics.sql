-- 00042: 운영 성능 계측 통일 레코드 (성능지표 가이드 1단계 · 분담표 A1)
--
-- 지금까지 계측이 두 군데로 갈라져 있었다.
--   ① ai_cost_log — 비용은 남지만 status·error_code·소요시간·request_id 가 없다.
--      실패한 요청은 AI 호출 전에 끝나면 행 자체가 생기지 않아 성공률의 분모가 안 된다.
--   ② 생성 파이프라인 진단 — 단계별 시간은 남지만 ai_cost_log.metadata 의 JSON 블롭이라
--      업로드 한 건씩만 읽을 수 있다. 전체 p95 를 구하려면 블롭을 전부 긁어야 한다.
--
-- 요청 하나 = 한 줄로 모은다. 성공률·p50/p95/p99·오류 코드 분포·단계별 병목·요청당 원가가
-- 전부 이 테이블 하나에서 나온다(가이드 §4.1).
--
-- CPX(FastAPI/SQLite)에는 같은 목적의 request_metrics 가 이미 있다. 서비스 경계가 달라
-- 테이블을 합치지 않고 필드 의미만 맞춘다 — 두 대시보드가 같은 산식을 쓴다.

create table if not exists public.request_metrics (
    -- gen_random_uuid() 를 쓴다. uuid_generate_v4 는 uuid-ossp 확장 함수인데, Supabase 는
    -- 확장을 extensions 스키마에 두고 마이그레이션 러너의 search_path 에는 넣지 않는다 —
    -- 00001 이 확장을 만들어 뒀어도 push 세션에서는 함수를 찾지 못한다(2026-08-22 배포에서
    -- 42883 으로 실패). gen_random_uuid 는 PG13+ 내장이라 확장 의존이 없다.
    id            uuid primary key default gen_random_uuid(),
    -- 요청 추적 ID. 응답 헤더 x-request-id 로도 나가 사용자 제보와 로그를 잇는다.
    request_id    text not null,
    -- 기능 이름. 경로를 그대로 쓰면 uuid 가 축에 섞여 집계가 요청 수만큼 쪼개진다.
    feature       text not null,
    -- 기능 버전(프롬프트·모델 조합). 배포 간 회귀 비교축 — lib/ai/versions.ts 가 채운다.
    version       text not null default 'v1',
    user_id       uuid references public.users(id) on delete set null,
    method        text not null,
    status        text not null,           -- success | client_error | server_error | timeout
    status_code   integer not null,
    error_code    text,                    -- cost_cap_exceeded | quota_exceeded | http_404 ...
    total_ms      integer not null,
    -- 단계별 소요 ms. {"ocr": 8123, "generate": 42011, "verify": 3120}
    stages        jsonb,
    -- 이 요청이 쓴 AI 비용 합계. ai_cost_log.request_id 로 드릴다운한다.
    cost_usd      numeric(10, 6) not null default 0,
    input_tokens  integer not null default 0,
    output_tokens integer not null default 0,
    models        text[],
    -- 품질 게이트 결과 (가이드 §4.1 '품질 게이트' · 분담표 A4).
    -- null 이면 이 요청은 검사 대상이 아니다 — 준수율 분모에서 빠진다.
    schema_valid  boolean,
    -- 산출물 품질 수치. {"questions": 10, "schemaViolations": 0, "duplicates": 1}
    quality       jsonb,
    created_at    timestamptz not null default now()
);

-- 같은 요청이 두 번 기록되면 성공률과 지연 분포가 그만큼 왜곡된다.
create unique index if not exists uq_request_metrics_request_id
    on public.request_metrics(request_id);
create index if not exists idx_request_metrics_created_at
    on public.request_metrics(created_at desc);
create index if not exists idx_request_metrics_feature
    on public.request_metrics(feature, created_at desc);
-- 실패만 훑는 조회(오류 코드 분포)가 전체 스캔이 되지 않게.
create index if not exists idx_request_metrics_status
    on public.request_metrics(status, created_at desc)
    where status <> 'success';

-- 비용 로그를 요청에 붙인다. 이 컬럼이 있어야 "이 실패한 생성이 얼마를 썼나"를 한 번에 묻는다.
alter table public.ai_cost_log add column if not exists request_id text;
create index if not exists idx_ai_cost_log_request_id
    on public.ai_cost_log(request_id) where request_id is not null;

-- 계측은 서비스 계정만 쓰고 관리자만 읽는다. 사용자 본인 행도 열지 않는다 —
-- 오류 코드와 단계별 시간은 내부 구조를 그대로 드러낸다.
alter table public.request_metrics enable row level security;

drop policy if exists request_metrics_admin_read on public.request_metrics;
create policy request_metrics_admin_read on public.request_metrics
    for select
    using (public.is_admin(auth.uid()));
-- 서비스 롤은 RLS 를 우회한다 (admin client 가 insert 한다) — 00008 ai_cost_log 와 같은 구조.

-- 보존 기간 정리. 요청마다 한 줄씩 쌓이므로 상한이 없으면 테이블이 영원히 큰다.
-- 관리자 대시보드가 열릴 때 호출한다(정리 자체가 서비스보다 비싸지면 안 되므로 빈도 제한은 호출 측).
create or replace function public.purge_request_metrics(retain_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
    removed integer;
begin
    delete from public.request_metrics
    where created_at < now() - make_interval(days => greatest(retain_days, 1));
    get diagnostics removed = row_count;
    return removed;
end;
$$;

revoke all on function public.purge_request_metrics(integer) from public;
grant execute on function public.purge_request_metrics(integer) to service_role;

comment on table public.request_metrics is
    '요청 1건 = 1행. 성공률·지연시간·오류 코드·단계별 병목·요청당 원가의 원천 (성능지표 가이드 1단계).';
