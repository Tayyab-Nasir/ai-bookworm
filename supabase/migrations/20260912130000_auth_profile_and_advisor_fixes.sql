-- Every Auth identity (email or OAuth) receives a private application profile.
create function public.create_profile_for_auth_user() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  insert into public.profiles(id) values(new.id) on conflict(id) do nothing;
  return new;
end $$;
revoke all on function public.create_profile_for_auth_user() from public,anon,authenticated,service_role;
create trigger auth_user_profile after insert on auth.users
for each row execute function public.create_profile_for_auth_user();

-- Supabase advisor: immutable trigger function must not inherit caller search_path.
alter function public.credit_ledger_immutable() set search_path='';

-- Same columns/order as idx_activity_workspace_time; keep the original index.
drop index if exists public.activity_events_workspace_idx;
