-- 선지 개수가 5개를 넘는 기존 문항 정정 (일회성 데이터 보정)
--
-- 배경: 문항 생성 툴 스키마의 minItems/maxItems 는 모델에 대한 힌트일 뿐 강제되지 않아
-- 선지 6개 문항이 저장된 사례가 있었다(사용자 신고). 생성 파이프라인에 저장 직전
-- 정규화(normalizeChoiceSet)를 추가했고, 그 전에 저장된 데이터를 여기서 한 번 정리한다.
--
-- 규칙: 정답은 반드시 유지한다.
--   - answer_index < 5  → 앞 5개만 남기고 answer_index 그대로
--   - answer_index >= 5 → 앞 4개 + 정답 선지를 남기고 answer_index = 4
-- 선지가 5개 미만인 문항은 임의로 오답을 만들어 넣을 수 없으므로 건드리지 않는다.
-- 멱등: 실행 후 길이가 5가 되므로 재실행 시 대상이 없다.

update public.private_questions p
set choices = sub.new_choices,
    answer_index = sub.new_answer_index
from (
  select
    b.id,
    case
      when b.answer_index < 5 then (
        select jsonb_agg(t.c order by t.ord)
        from jsonb_array_elements(b.choices) with ordinality as t(c, ord)
        where t.ord <= 5
      )
      else (
        select jsonb_agg(t.c order by t.ord)
        from jsonb_array_elements(b.choices) with ordinality as t(c, ord)
        where t.ord <= 4 or t.ord = b.answer_index + 1
      )
    end as new_choices,
    case when b.answer_index < 5 then b.answer_index else 4 end as new_answer_index
  from public.private_questions b
  where jsonb_typeof(b.choices) = 'array'
    and jsonb_array_length(b.choices) > 5
) sub
where p.id = sub.id;

-- 공유 문항 풀에도 같은 형태의 컬럼이 있어 함께 정리한다(있을 때만).
do $$
begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'questions' and column_name = 'choices'
  ) then
    update public.questions p
    set choices = sub.new_choices,
        answer_index = sub.new_answer_index
    from (
      select
        b.id,
        case
          when b.answer_index < 5 then (
            select jsonb_agg(t.c order by t.ord)
            from jsonb_array_elements(b.choices) with ordinality as t(c, ord)
            where t.ord <= 5
          )
          else (
            select jsonb_agg(t.c order by t.ord)
            from jsonb_array_elements(b.choices) with ordinality as t(c, ord)
            where t.ord <= 4 or t.ord = b.answer_index + 1
          )
        end as new_choices,
        case when b.answer_index < 5 then b.answer_index else 4 end as new_answer_index
      from public.questions b
      where jsonb_typeof(b.choices) = 'array'
        and jsonb_array_length(b.choices) > 5
    ) sub
    where p.id = sub.id;
  end if;
end $$;
