-- ====================================================================
-- 코호트 학습 RPC — '시험 범위 아니에요' 피드백 처리
-- ====================================================================
-- 학교 코호트 단위로 sub_topic 의 inclusion_score 를 갱신.
--
-- 주요 함수:
--   1. calc_user_weight              — 사용자 신뢰 가중치 계산
--   2. recalc_cohort_subtopic_score  — 코호트 점수 재계산
--   3. detect_curriculum_drift       — 교육과정 개편 감지
-- ====================================================================

-- ──────────────────────────────────────────
-- 사용자 신뢰 가중치 (0 ~ 1)
--   - 정상 사용자: 1.0
--   - 신규 사용자 (< 30일): 0.3
--   - Outlier (총 시도 30회 이상 & out_of_scope 클릭률 > 70%): × 0.2
--
-- 두 조건 동시 적용 가능 (신규 + outlier → 0.06)
-- ──────────────────────────────────────────
create or replace function public.calc_user_weight(
    p_user_id uuid
)
returns real
language plpgsql
stable
as $$
declare
    v_age_days   integer;
    v_attempts   integer;
    v_oos_clicks integer;
    v_oos_rate   real;
    v_weight     real := 1.0;
begin
    -- 사용자 가입일 확인
    select extract(day from (now() - created_at))::int
      into v_age_days
      from public.users
     where id = p_user_id;

    if v_age_days is null then
        return 0;  -- 존재하지 않는 사용자
    end if;

    -- 신규 사용자 (< 30일) 가중치 감소
    if v_age_days < 30 then
        v_weight := 0.3;
    end if;

    -- Outlier 감지
    select count(*) into v_attempts
      from public.user_attempts
     where user_id = p_user_id;

    select count(*) into v_oos_clicks
      from public.out_of_scope_feedback
     where user_id = p_user_id;

    if v_attempts >= 30 then
        v_oos_rate := v_oos_clicks::real / v_attempts::real;
        if v_oos_rate > 0.7 then
            v_weight := v_weight * 0.2;
        end if;
    end if;

    return v_weight;
end;
$$;

-- ──────────────────────────────────────────
-- 코호트 sub_topic 점수 재계산
--
-- 호출 시점:
--   - out_of_scope_feedback insert 직후 (인라인)
--   - 배치 작업으로 주기적 (스케일 시)
--
-- 알고리즘:
--   inclusion_score = 1 - (가중 out_of_scope 클릭 수 / 가중 시도 사용자 수)
--   confidence: sample_size 기반 step function
-- ──────────────────────────────────────────
create or replace function public.recalc_cohort_subtopic_score(
    p_cohort_id    uuid,
    p_sub_topic_id uuid
)
returns void
language plpgsql
as $$
declare
    v_total_weight    real    := 0;
    v_oos_weight      real    := 0;
    v_sample_size     integer := 0;
    v_inclusion_score real;
    v_confidence      real;
begin
    -- 시도한 distinct 사용자의 가중 합산
    select count(distinct ua.user_id),
           coalesce(sum(distinct_weights.w), 0)
      into v_sample_size, v_total_weight
      from public.user_attempts ua
      join public.questions q on q.id = ua.question_id
      cross join lateral (
          select public.calc_user_weight(ua.user_id) as w
      ) distinct_weights
     where ua.cohort_id = p_cohort_id
       and q.sub_topic_id = p_sub_topic_id;

    -- out_of_scope 클릭의 가중 합산
    select coalesce(sum(public.calc_user_weight(user_id)), 0)
      into v_oos_weight
      from public.out_of_scope_feedback
     where cohort_id = p_cohort_id
       and sub_topic_id = p_sub_topic_id;

    if v_total_weight = 0 then
        return;
    end if;

    v_inclusion_score := 1.0 - (v_oos_weight / v_total_weight);
    v_inclusion_score := greatest(0.0, least(1.0, v_inclusion_score));

    -- Confidence: sample_size 기반 step function
    if v_sample_size < 3 then
        v_confidence := 0.3;
    elsif v_sample_size < 10 then
        v_confidence := 0.6;
    else
        v_confidence := 1.0;
    end if;

    insert into public.cohort_sub_topic_scores
        (cohort_id, sub_topic_id, inclusion_score, sample_size, confidence)
    values
        (p_cohort_id, p_sub_topic_id, v_inclusion_score, v_sample_size, v_confidence)
    on conflict (cohort_id, sub_topic_id) do update
        set inclusion_score = excluded.inclusion_score,
            sample_size     = excluded.sample_size,
            confidence      = excluded.confidence,
            updated_at      = now();
end;
$$;

-- ──────────────────────────────────────────
-- 교육과정 개편 자동 감지
--
-- 같은 학교 + 학년 + 과목의 직전 학기·년도 코호트와 비교하여
-- sub_topic inclusion_score 가 ±0.3 이상 변동한 항목 반환.
--
-- bandit 의 exploration 비율 임시 상향 트리거로 활용 가능.
-- ──────────────────────────────────────────
create or replace function public.detect_curriculum_drift(
    p_cohort_id uuid
)
returns table (
    sub_topic_id     uuid,
    sub_topic_name   text,
    current_score    real,
    previous_score   real,
    delta            real,
    direction        text
)
language sql
stable
as $$
    with current_cohort as (
        select c.school_id, c.grade, c.year, c.semester, c.subject_id
          from public.cohorts c
         where c.id = p_cohort_id
    ),
    previous_cohort as (
        select c.id
          from public.cohorts c, current_cohort cc
         where c.school_id  = cc.school_id
           and c.grade      = cc.grade
           and c.subject_id = cc.subject_id
           and (
               (cc.semester = 'fall'   and c.year = cc.year     and c.semester = 'spring')
            or (cc.semester = 'spring' and c.year = cc.year - 1 and c.semester = 'fall')
           )
         limit 1
    )
    select
        curr.sub_topic_id,
        st.name as sub_topic_name,
        curr.inclusion_score as current_score,
        coalesce(prev.inclusion_score, 0.5) as previous_score,
        abs(curr.inclusion_score - coalesce(prev.inclusion_score, 0.5)) as delta,
        case
            when curr.inclusion_score > coalesce(prev.inclusion_score, 0.5)
            then 'expanded'   -- 범위 확장 (포함 ↑)
            else 'narrowed'   -- 범위 축소 (포함 ↓)
        end as direction
      from public.cohort_sub_topic_scores curr
      join public.sub_topics st on st.id = curr.sub_topic_id
      left join public.cohort_sub_topic_scores prev
        on prev.sub_topic_id = curr.sub_topic_id
       and prev.cohort_id    = (select id from previous_cohort)
     where curr.cohort_id = p_cohort_id
       and abs(curr.inclusion_score - coalesce(prev.inclusion_score, 0.5)) > 0.3
     order by delta desc;
$$;

-- ──────────────────────────────────────────
-- 코호트 활성 사용자 수 — 30일 이내 풀이 활동
-- ──────────────────────────────────────────
create or replace function public.cohort_active_users(
    p_cohort_id uuid,
    p_days      integer default 30
)
returns integer
language sql
stable
as $$
    select count(distinct user_id)::int
      from public.user_attempts
     where cohort_id = p_cohort_id
       and created_at > now() - (p_days || ' days')::interval;
$$;
