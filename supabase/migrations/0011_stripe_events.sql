-- 0011_stripe_events.sql — webhook idempotency + ledger concurrency guard
create table public.stripe_events (
  id text primary key,          -- Stripe event id (evt_...)
  type text not null,
  created_at timestamptz not null default now()
);

-- One ledger entry per (source, reference): makes consumption/ grant retries
-- a unique-violation no-op instead of a double post.
create unique index credit_ledger_reference_uniq
  on public.credit_ledger (source, reference_id)
  where reference_id is not null;

-- credit_ledger is append-only: block updates/deletes at the DB level.
create or replace function public.credit_ledger_immutable() returns trigger
language plpgsql as $$
begin
  raise exception 'credit_ledger is append-only';
end;
$$;
create trigger credit_ledger_no_update before update or delete on public.credit_ledger
  for each row execute function public.credit_ledger_immutable();
