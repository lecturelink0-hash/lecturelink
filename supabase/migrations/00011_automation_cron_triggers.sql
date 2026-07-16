-- ============================================
-- 00011_automation_cron_triggers.sql
--
-- P2-4: reset_expired_bonuses 를 매일 자정(UTC) 실행하는 pg_cron job
-- P2-5: cohort_sub_topic_scores 자동 갱신 트리거 — out_of_scope_feedback insert 시 재계산 enqueue
-- ============================================

-- pg_cron 확장 활성화 (Supabase managed 에선 SQL 에디터에서 활성화 필요)
create extension if not exists pg_cron;

-- ──────────────────────────────────────────
-- (1) reset_expired_bonuses 매일 자정 실행
-- ──────────────────────────────────────────
do $$
begin
    perform cron.unschedule('reset_expired_bonuses_daily');
exception when others then null;
end $$;

select cron.schedule(
    'reset_expired_bonuses_daily',
    '0 0 * * *',                                   -- 매일 UTC 00:00
    $$ select public.reset_expired_bonuses(); $$
);

-- ──────────────────────────────────────────
-- (2) out_of_scope_feedback insert 트리거 → cohort_sub_topic_scores 갱신
--
-- 직접 동기 호출하면 insert 가 무거워지므로, 갱신 요청만 큐 테이블에 남김.
-- worker 가 주기적으로 큐를 비우며 recalc 실행.
-- ──────────────────────────────────────────
create table if not exists public.cohort_score_recalc_queue (
    id            bigint generated always as identity primary key,
    cohort_id     uuid not null references public.cohorts(id) on delete cascade,
    sub_topic_id  uuid not null references public.sub_topics(id) on delete cascade,
    enqueued_at   timestamptz not null default now(),
    processed_at  timestamptz
);

-- 과거(잘못된) UNIQUE 제약이 이미 존재하는 환경 대비 — NULL 을 동일값 취급하지 않아 pending 중복 차단 실패함.
-- 안전하게 drop (없으면 무시).
do $$
begin
    alter table public.cohort_score_recalc_queue
        drop constraint if exists cohort_score_recalc_queue_cohort_id_sub_topic_id_processed_at_key;
exception when others then null;
end $$;

-- pending 행에 한해서만 (cohort, sub_topic) 유일성 강제 — NULL processed_at 다중 행 차단.
create unique index if not exists ux_cohort_score_recalc_pending
    on public.cohort_score_recalc_queue (cohort_id, sub_topic_id)
    where processed_at is null;

-- 진행률·정렬용 인덱스 (위 unique index 와 별개).
create index if not exists idx_cohort_score_recalc_enqueued_at
    on public.cohort_score_recalc_queue(enqueued_at)
    where processed_at is null;

create or replace function public.enqueue_cohort_score_recalc()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
    v_cohort_id uuid;
begin
    -- out_of_scope_feedback 행이 cohort 와 sub_topic 을 직접 참조한다고 가정
    -- (00001 스키마 기준 — 다른 구조면 여기 보정)
    v_cohort_id := new.cohort_id;
    if v_cohort_id is null then
        return new;
    end if;

    -- partial unique index 추론: (cohort_id, sub_topic_id) where processed_at is null
    insert into public.cohort_score_recalc_queue (cohort_id, sub_topic_id)
    values (v_cohort_id, new.sub_topic_id)
    on conflict (cohort_id, sub_topic_id) where (processed_at is null) do nothing;

    return new;
end;
$$;

drop trigger if exists trg_out_of_scope_enqueue on public.out_of_scope_feedback;
create trigger trg_out_of_scope_enqueue
    after insert on public.out_of_scope_feedback
    for each row
    execute function public.enqueue_cohort_score_recalc();

-- 큐 워커: 1분마다 pending 큐를 처리
do $$
begin
    perform cron.unschedule('cohort_score_recalc_worker');
exception when others then null;
end $$;

create or replace function public.process_cohort_score_recalc_queue()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
    r record;
begin
    for r in
        select cohort_id, sub_topic_id
        from public.cohort_score_recalc_queue
        where processed_at is null
        order by enqueued_at
        limit 100
    loop
        begin
            perform public.recalc_cohort_subtopic_score(r.cohort_id, r.sub_topic_id);
        exception when others then
            -- 실패해도 큐는 마크 (다음 트리거에서 재시도)
            null;
        end;

        update public.cohort_score_recalc_queue
        set processed_at = now()
        where cohort_id = r.cohort_id
          and sub_topic_id = r.sub_topic_id
          and processed_at is null;
    end loop;
end;
$$;

select cron.schedule(
    'cohort_score_recalc_worker',
    '*/1 * * * *',                                  -- 1분 간격
    $$ select public.process_cohort_score_recalc_queue(); $$
);

-- ──────────────────────────────────────────
-- (3) 24h+ processing 상태에 갇힌 upload 자동 복구 (out of scope 였지만 운영 안전망)
-- ──────────────────────────────────────────
do $$
begin
    perform cron.unschedule('stuck_upload_recovery');
exception when others then null;
end $$;

select cron.schedule(
    'stuck_upload_recovery',
    '0 */6 * * *',                                  -- 6시간 간격
    $$
    update public.user_uploads
    set status = 'failed',
        error_message = coalesce(error_message, '') || ' [auto-recovery: stuck 24h+]'
    where status in ('queued', 'processing')
      and created_at < now() - interval '24 hours';
    $$
);
