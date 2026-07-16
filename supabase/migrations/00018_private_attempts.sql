-- ──────────────────────────────────────────
-- user_attempts 를 private 문제 풀이도 기록하도록 확장
-- ──────────────────────────────────────────
-- 기존 question_id 는 public questions 전용(NOT NULL FK)이라 private_questions
-- 풀이를 기록할 수 없었다. private_question_id 를 추가하고 question_id 를 nullable 로
-- 풀어, track 에 따라 정확히 한 쪽만 채우게 한다.
--   - track='smart_practice' → question_id (public)
--   - track='lecture_note'   → private_question_id (개인)

alter table public.user_attempts
  alter column question_id drop not null;

alter table public.user_attempts
  add column private_question_id uuid
    references public.private_questions(id) on delete cascade;

-- 정확히 한 쪽만 채워져야 한다 (XOR).
alter table public.user_attempts
  add constraint user_attempts_question_xor check (
    (question_id is not null and private_question_id is null) or
    (question_id is null and private_question_id is not null)
  );

create index idx_attempts_private_question
  on public.user_attempts(private_question_id)
  where private_question_id is not null;
