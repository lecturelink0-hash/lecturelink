alter table public.formative_items
  add column if not exists image_data_url text;

comment on column public.formative_items.image_data_url is
  'Optional lecture-material image embedded as a data URL for a formative question.';
