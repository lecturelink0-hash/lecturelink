create type public.teaching_material_status as enum ('processing', 'ready', 'failed');

create table public.teaching_materials (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.courses(id) on delete cascade,
  professor_id uuid not null references public.users(id) on delete cascade,
  file_name text not null,
  file_type text not null check (file_type in ('pdf', 'pptx')),
  mime_type text not null,
  file_size_bytes bigint not null check (file_size_bytes > 0),
  file_hash text not null,
  storage_path text not null unique,
  status public.teaching_material_status not null default 'processing',
  page_count integer,
  extracted_text text,
  extracted_pages jsonb not null default '[]'::jsonb,
  extraction_version integer not null default 1,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (course_id, file_hash)
);

alter table public.learning_artifacts
  add column material_id uuid references public.teaching_materials(id) on delete set null;

create index idx_teaching_materials_course
  on public.teaching_materials(course_id, created_at desc);
create index idx_teaching_materials_professor_hash
  on public.teaching_materials(professor_id, file_hash);
create index idx_artifacts_material
  on public.learning_artifacts(material_id, created_at desc);

alter table public.teaching_materials enable row level security;

create policy teaching_materials_professor_all
  on public.teaching_materials for all to authenticated
  using (
    professor_id = auth.uid()
    and public.owns_course(course_id)
    and public.is_professor()
  )
  with check (
    professor_id = auth.uid()
    and public.owns_course(course_id)
    and public.is_professor()
  );

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'teaching-materials',
  'teaching-materials',
  false,
  26214400,
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation'
  ]
)
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

create policy teaching_material_files_select_own
  on storage.objects for select to authenticated
  using (
    bucket_id = 'teaching-materials'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_professor()
  );

create policy teaching_material_files_insert_own
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'teaching-materials'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_professor()
  );

create policy teaching_material_files_update_own
  on storage.objects for update to authenticated
  using (
    bucket_id = 'teaching-materials'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_professor()
  )
  with check (
    bucket_id = 'teaching-materials'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_professor()
  );

create policy teaching_material_files_delete_own
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'teaching-materials'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.is_professor()
  );
