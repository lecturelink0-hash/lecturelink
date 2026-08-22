-- 00044: 학습 신호 수집 — 확신도·해설 열람·오류 신고 (분담표 A14 · 가이드 §8.1)
--
-- 가이드 §8.1: "학생 풀이에서 정답 여부, 풀이시간, 선택한 선지, 확신도, 오류 신고와
-- 해설 열람 여부를 기록한다."
--
-- 지금 모으는 것: 정답 여부·풀이시간·선택한 선지.  안 모으는 것: 나머지 셋.
--
-- **소급이 불가능하다.** 파일럿이 시작된 뒤에 넣으면 그 이전 풀이에는 영원히 값이 없고,
-- 학습효과 분석에서 그 기간을 통째로 버려야 한다. 그래서 학생이 들어오기 전에 넣는다.
--
-- 확신도를 3점으로 둔 이유: 확률(0~100%)로 물으면 학생이 답을 회피하거나 대충 찍어
-- 신호가 오히려 나빠진다. 3점이면 매 문항 부담 없이 고를 수 있고, 보정(calibration)은
-- "확신도 수준별 정답률"로 재면 되므로 확률 눈금이 필요 없다 — 없는 숫자를 지어내지 않는다.

alter table public.user_attempts
    -- 1=낮음(찍음) 2=보통 3=높음(확실). null = 응답 안 함(강제하지 않는다).
    add column if not exists confidence smallint
        check (confidence is null or confidence between 1 and 3),
    -- 해설을 실제로 읽었는지. 화면에 떠 있기만 한 것과 읽은 것은 다르다.
    add column if not exists explanation_viewed boolean not null default false,
    -- 해설이 화면에 실제로 보인 누적 시간. viewed 판정의 근거이자 몰입도 신호다.
    add column if not exists explanation_dwell_ms integer not null default 0;

comment on column public.user_attempts.confidence is
    '풀이 시점 확신도 1(낮음)~3(높음). null 은 미응답 (가이드 §8.1).';
comment on column public.user_attempts.explanation_viewed is
    '해설을 실제로 읽었는지 — 화면에 일정 시간 이상 보였는지로 판정한다.';

-- 확신도 보정(과신·과소신) 조회가 전체 스캔이 되지 않게.
create index if not exists idx_user_attempts_confidence
    on public.user_attempts(confidence, is_correct)
    where confidence is not null;

-- ── 문항 오류 신고 ────────────────────────────────────────────────────────────
--
-- 기존 out_of_scope_feedback 은 '범위 밖' 전용이고 공용 문항·코호트가 필수라
-- 개인 문항(private_questions)의 정답 오류·지문 오류를 담을 수 없다.
-- 가이드 §8.1 이 요구하는 '오류 신고'는 그보다 넓으므로 별도 테이블을 둔다.
create table if not exists public.question_reports (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references public.users(id) on delete cascade,
    -- 공용 문항이면 question_id, 개인 문항이면 private_question_id. 정확히 하나만 채운다
    -- (user_attempts 의 XOR 제약과 같은 구조).
    question_id          uuid references public.questions(id) on delete cascade,
    private_question_id  uuid references public.private_questions(id) on delete cascade,
    -- 어떤 풀이에서 신고했는지. 없어도 신고는 받는다(문항 목록에서 바로 신고할 수 있다).
    attempt_id   uuid references public.user_attempts(id) on delete set null,
    reason       text not null check (reason in (
        'wrong_answer',       -- 정답이 틀렸다
        'multiple_answers',   -- 정답이 여러 개다 / 모호하다
        'stem_error',         -- 지문에 오류가 있다
        'choice_error',       -- 선지에 오류가 있다
        'explanation_error',  -- 해설에 오류가 있다
        'image_problem',      -- 그림이 없거나 문항과 맞지 않는다
        'out_of_scope',       -- 강의 범위 밖이다
        'other'
    )),
    -- 자유 기술. 길이를 막아 두지 않으면 로그가 통째로 붙어 온다.
    note         text check (note is null or char_length(note) <= 1000),
    -- 검수 처리 상태. 신고가 쌓이기만 하고 아무도 안 보는 상태를 만들지 않으려면
    -- 처리 축이 처음부터 있어야 한다.
    status       text not null default 'open'
        check (status in ('open', 'reviewing', 'resolved', 'rejected')),
    resolved_by  uuid references public.users(id) on delete set null,
    resolved_at  timestamptz,
    resolution_note text,
    created_at   timestamptz not null default now(),
    -- 정확히 한 종류의 문항을 가리켜야 한다.
    constraint question_reports_target_xor check (
        (question_id is not null and private_question_id is null)
        or (question_id is null and private_question_id is not null)
    )
);

create index if not exists idx_question_reports_open
    on public.question_reports(created_at desc) where status = 'open';
create index if not exists idx_question_reports_question
    on public.question_reports(question_id) where question_id is not null;
create index if not exists idx_question_reports_private
    on public.question_reports(private_question_id) where private_question_id is not null;
-- 같은 사람이 같은 문항을 같은 사유로 여러 번 신고하면 집계가 부풀려진다.
create unique index if not exists uq_question_reports_dedupe
    on public.question_reports(user_id, coalesce(question_id, private_question_id), reason);

alter table public.question_reports enable row level security;

-- 사용자는 자기 신고만 보고, 자기 이름으로만 신고할 수 있다.
drop policy if exists question_reports_owner_read on public.question_reports;
create policy question_reports_owner_read on public.question_reports
    for select using (auth.uid() = user_id);

drop policy if exists question_reports_owner_insert on public.question_reports;
create policy question_reports_owner_insert on public.question_reports
    for insert with check (auth.uid() = user_id);

drop policy if exists question_reports_admin_read on public.question_reports;
create policy question_reports_admin_read on public.question_reports
    for select using (public.is_admin(auth.uid()));

comment on table public.question_reports is
    '학생이 올린 문항 오류 신고 (가이드 §8.1). 검수 처리 상태를 함께 둔다 — 쌓이기만 하고 아무도 안 보는 것을 막기 위해.';
