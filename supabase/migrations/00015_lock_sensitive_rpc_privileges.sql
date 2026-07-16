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
