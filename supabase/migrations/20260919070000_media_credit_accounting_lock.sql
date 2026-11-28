-- Audio/translation completions must serialize with their pending-credit guards.
-- Otherwise a reservation can read old usage, then a newly released pending job.
-- Also covers non-job image usage; job-linked image completion already locks.
create function public.lock_media_credit_accounting() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.meter in ('audio_credits','translation_credits','image_credits')
    and new.organization_id is not null then
    perform id from public.organizations where id=new.organization_id for update;
    if not found then
      raise exception 'media credit organization missing' using errcode='22023';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.lock_media_credit_accounting() from public, anon, authenticated;
create trigger media_credit_accounting_lock before insert on public.usage_events
for each row execute function public.lock_media_credit_accounting();
