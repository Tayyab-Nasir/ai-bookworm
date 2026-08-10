-- 0009_storage.sql
-- Private bucket
insert into storage.buckets (id, name, public)
values ('book-assets', 'book-assets', false)
on conflict (id) do nothing;

create policy asset_object_read on storage.objects for select
  using (
    bucket_id = 'book-assets'
    and exists (
      select 1 from public.assets a
      where a.storage_path = name
        and public.is_workspace_member(a.workspace_id)
    )
  );

-- Upload/delete are mediated by the API using signed URLs and authorization.
-- Storage path:
-- workspaces/{workspace_id}/assets/{asset_id}/v{version}/{safe_filename}
