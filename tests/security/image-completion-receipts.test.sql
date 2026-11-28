do $$
begin
  if has_table_privilege('authenticated', 'public.image_completion_receipts', 'SELECT')
    or has_table_privilege('authenticated', 'public.image_completion_receipts', 'INSERT')
    or has_table_privilege('authenticated', 'public.image_completion_receipts', 'UPDATE')
    or has_table_privilege('anon', 'public.image_completion_receipts', 'SELECT') then
    raise exception 'private image completion receipts exposed';
  end if;
  if not has_table_privilege('service_role', 'public.image_completion_receipts', 'SELECT')
    or not has_table_privilege('service_role', 'public.image_completion_receipts', 'INSERT')
    or has_table_privilege('service_role', 'public.image_completion_receipts', 'UPDATE') then
    raise exception 'image receipt service privileges incorrect';
  end if;
  if not (select relrowsecurity from pg_class where oid='public.image_completion_receipts'::regclass) then
    raise exception 'image receipt RLS not enabled';
  end if;
end $$;
