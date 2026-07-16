-- ====================================================================
-- Storage 버킷 — 사용자 업로드 자료 (Track A · 내 강의 노트)
-- ====================================================================
-- 경로 규칙: {user_id}/{upload_id}/{filename}
-- RLS 정책: 사용자는 본인 폴더만 read/write/delete
-- ====================================================================

-- ──────────────────────────────────────────
-- 버킷 생성
-- ──────────────────────────────────────────
insert into storage.buckets (
    id, name, public, file_size_limit, allowed_mime_types
) values (
    'user_uploads',
    'user_uploads',
    false,                          -- private
    524288000,                      -- 500MB 제한
    array[
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'application/vnd.ms-powerpoint',
        'image/png',
        'image/jpeg',
        'image/webp',
        'application/dicom'
    ]
) on conflict (id) do update set
    public            = excluded.public,
    file_size_limit   = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- ──────────────────────────────────────────
-- RLS 정책 — 본인 폴더만 접근
-- ──────────────────────────────────────────

-- SELECT
drop policy if exists "user_uploads_select_own" on storage.objects;
create policy "user_uploads_select_own"
on storage.objects for select
to authenticated
using (
    bucket_id = 'user_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
);

-- INSERT
drop policy if exists "user_uploads_insert_own" on storage.objects;
create policy "user_uploads_insert_own"
on storage.objects for insert
to authenticated
with check (
    bucket_id = 'user_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
);

-- UPDATE
drop policy if exists "user_uploads_update_own" on storage.objects;
create policy "user_uploads_update_own"
on storage.objects for update
to authenticated
using (
    bucket_id = 'user_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
);

-- DELETE
drop policy if exists "user_uploads_delete_own" on storage.objects;
create policy "user_uploads_delete_own"
on storage.objects for delete
to authenticated
using (
    bucket_id = 'user_uploads'
    and (storage.foldername(name))[1] = auth.uid()::text
);
