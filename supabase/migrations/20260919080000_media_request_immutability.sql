-- Provider input, reserved units and billing identity are a single accepted
-- request. Repricing/editing requires a new request; retries retain the snapshot.
create function public.guard_media_request_identity() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
  if old.agent_type in ('narrator','translator') or new.agent_type in ('narrator','translator') then
    if new.agent_type is distinct from old.agent_type
      or new.input_ref is distinct from old.input_ref
      or new.workspace_id is distinct from old.workspace_id
      or new.book_id is distinct from old.book_id
      or new.created_by is distinct from old.created_by
      or new.idempotency_key is distinct from old.idempotency_key then
      raise exception 'accepted media request is immutable' using errcode='23514';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.guard_media_request_identity() from public,anon,authenticated;
-- Run before reservation triggers so callers receive the immutable-request error.
create trigger aa_media_request_identity before update on public.ai_jobs
for each row execute function public.guard_media_request_identity();
