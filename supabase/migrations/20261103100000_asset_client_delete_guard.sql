-- Authors remove assets through the service's soft-delete workflow. Direct
-- client DELETE bypasses that workflow and cascades to asset version history.
-- Keep service_role privileges intact for server-side failed-upload cleanup.
drop policy if exists assets_delete on public.assets;
revoke delete on table public.assets from public, anon, authenticated;
