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
