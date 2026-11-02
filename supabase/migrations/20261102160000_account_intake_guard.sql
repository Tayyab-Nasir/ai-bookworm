-- Protect intake server-owned fields and import receipts from direct client writes.
-- Existing rows are untouched; these checks apply only to authenticated INSERT.
revoke all privileges on table public.support_tickets, public.data_rights_requests from public, anon, authenticated;
revoke all privileges (id, organization_id, user_id, category, status, priority, subject, body, created_at, updated_at)
  on public.support_tickets from public, anon, authenticated;
revoke all privileges (id, user_id, request_type, status, reason, requested_at, due_at, updated_at, completed_at)
  on public.data_rights_requests from public, anon, authenticated;
grant select on public.support_tickets, public.data_rights_requests to authenticated;
grant insert (user_id, organization_id, category, subject, body, status, priority)
  on public.support_tickets to authenticated;
grant insert (user_id, request_type, status, reason)
  on public.data_rights_requests to authenticated;

drop policy if exists support_ticket_owner_insert on public.support_tickets;
create policy support_ticket_owner_insert on public.support_tickets for insert to authenticated
with check (
  user_id = (select auth.uid()) and organization_id is null and status = 'open' and priority = 'normal'
  and category in ('general', 'technical', 'billing', 'publishing', 'account', 'privacy')
  and (char_length(btrim(subject, E' \t\n\r\f'||chr(11)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))) + regexp_count(btrim(subject, E' \t\n\r\f'||chr(11)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)), U&'[\+010000-\+10FFFF]')) between 3 and 160
  and (char_length(subject) + regexp_count(subject, U&'[\+010000-\+10FFFF]')) <= 160
  and (char_length(btrim(body, E' \t\n\r\f'||chr(11)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279))) + regexp_count(btrim(body, E' \t\n\r\f'||chr(11)||chr(160)||chr(5760)||chr(8192)||chr(8193)||chr(8194)||chr(8195)||chr(8196)||chr(8197)||chr(8198)||chr(8199)||chr(8200)||chr(8201)||chr(8202)||chr(8232)||chr(8233)||chr(8239)||chr(8287)||chr(12288)||chr(65279)), U&'[\+010000-\+10FFFF]')) between 10 and 5000
  and (char_length(body) + regexp_count(body, U&'[\+010000-\+10FFFF]')) <= 5000
);
drop policy if exists data_rights_owner_insert on public.data_rights_requests;
create policy data_rights_owner_insert on public.data_rights_requests for insert to authenticated
with check (
  user_id = (select auth.uid()) and status = 'submitted'
  and request_type in ('export', 'delete')
  and (reason is null or (char_length(reason) + regexp_count(reason, U&'[\+010000-\+10FFFF]')) <= 2000)
);
-- Known limitation: the current API never sends deletion confirmation to the DB.
-- Direct requests can still create deletion intake without the confirmation phrase.
-- A confirmation-aware RPC and API changes are required to enforce that boundary.

-- Receipt recovery is member-readable but written by service-role import RPCs.
revoke all privileges on table public.book_import_receipts from public, anon, authenticated;
revoke all privileges (book_id, source_asset_id, source_checksum, result, created_at)
  on public.book_import_receipts from public, anon, authenticated;
grant select on public.book_import_receipts to authenticated;
