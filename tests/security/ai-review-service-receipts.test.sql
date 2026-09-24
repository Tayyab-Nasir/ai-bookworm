begin;
do $$ begin
  assert not has_table_privilege('anon', 'public.ai_review_service_receipts', 'select');
  assert not has_table_privilege('authenticated', 'public.ai_review_service_receipts', 'select');
  assert not has_table_privilege('authenticated', 'public.ai_review_service_receipts', 'insert');
  assert not has_table_privilege('authenticated', 'public.ai_review_service_receipts', 'update');
  assert has_table_privilege('service_role', 'public.ai_review_service_receipts', 'select');
  assert has_table_privilege('service_role', 'public.ai_review_service_receipts', 'insert');
  assert has_table_privilege('service_role', 'public.ai_review_service_receipts', 'update');
end $$;
rollback;
