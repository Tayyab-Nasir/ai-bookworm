-- Author support and privacy-request intake. Requests are review workflows;
-- account deletion is never performed directly from a browser call.

create table if not exists public.data_rights_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  request_type text not null check (request_type in ('export', 'delete')),
  status text not null default 'submitted'
    check (status in ('submitted', 'processing', 'completed', 'rejected', 'cancelled')),
  reason text,
  requested_at timestamptz not null default now(),
  due_at timestamptz not null default (now() + interval '30 days'),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists uq_data_rights_open_request
  on public.data_rights_requests(user_id, request_type)
  where status in ('submitted', 'processing');
create index if not exists idx_data_rights_status_due
  on public.data_rights_requests(status, due_at);

alter table public.data_rights_requests enable row level security;

drop policy if exists support_ticket_owner_select on public.support_tickets;
drop policy if exists support_ticket_owner_insert on public.support_tickets;
create policy support_ticket_owner_select on public.support_tickets
  for select to authenticated using (user_id = (select auth.uid()));
create policy support_ticket_owner_insert on public.support_tickets
  for insert to authenticated with check (
    user_id = (select auth.uid()) and status = 'open' and priority = 'normal'
  );

create policy data_rights_owner_select on public.data_rights_requests
  for select to authenticated using (user_id = (select auth.uid()));
create policy data_rights_owner_insert on public.data_rights_requests
  for insert to authenticated with check (
    user_id = (select auth.uid()) and status = 'submitted'
  );

grant select, insert on public.support_tickets to authenticated;
grant select, insert on public.data_rights_requests to authenticated;

create or replace function public.cancel_data_rights_request(p_request_id uuid)
returns public.data_rights_requests
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  v_user uuid := auth.uid();
  v_result public.data_rights_requests;
begin
  if v_user is null then raise exception using errcode = '42501', message = 'authentication required'; end if;
  update public.data_rights_requests
    set status = 'cancelled', updated_at = now()
    where id = p_request_id and user_id = v_user and status = 'submitted'
    returning * into v_result;
  if v_result.id is null then
    if exists(select 1 from public.data_rights_requests where id = p_request_id and user_id = v_user) then
      raise exception using errcode = '22023', message = 'request cannot be cancelled';
    end if;
    raise exception using errcode = 'P0002', message = 'request not found';
  end if;
  return v_result;
end;
$$;

revoke all on function public.cancel_data_rights_request(uuid) from public, anon;
grant execute on function public.cancel_data_rights_request(uuid) to authenticated;
