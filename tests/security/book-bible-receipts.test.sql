begin;
do $$
begin
  assert (select relrowsecurity from pg_class where oid='public.book_bible_service_receipts'::regclass),
    'Book Bible receipts must enable RLS';
  assert not has_table_privilege('anon', 'public.book_bible_service_receipts', 'select'), 'anon can read receipts';
  assert not has_table_privilege('authenticated', 'public.book_bible_service_receipts', 'select'), 'users can read receipts';
  assert not has_table_privilege('authenticated', 'public.book_bible_service_receipts', 'insert'), 'users can forge receipts';
  assert not has_table_privilege('authenticated', 'public.book_bible_service_receipts', 'update'), 'users can replace receipts';
  assert has_table_privilege('service_role', 'public.book_bible_service_receipts', 'select'), 'service cannot recover receipts';
  assert has_table_privilege('service_role', 'public.book_bible_service_receipts', 'insert'), 'service cannot reserve receipts';
end $$;
rollback;
