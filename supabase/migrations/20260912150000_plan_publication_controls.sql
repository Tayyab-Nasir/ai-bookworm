-- Paid plans must be explicitly published after their economics and matching
-- Stripe Price IDs have been reviewed. Default-deny prevents accidental sales.
alter table public.plans
  add column is_active boolean not null default false;

alter table public.plans
  add constraint plans_price_cents_nonnegative check (price_cents >= 0);

drop policy if exists plans_select on public.plans;
create policy plans_select on public.plans
  for select to anon, authenticated
  using (is_active);

comment on column public.plans.is_active is
  'Explicit publication gate. Activate only after margin review and Stripe Price configuration.';
