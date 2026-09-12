-- supabase/seed/001_plans.sql
-- Only the zero-generation account tier is published by default. Paid plan
-- economics are placeholders until retail prices, provider costs, and margin
-- limits are approved and matching Stripe Price IDs are configured.
insert into public.plans (name, is_active, billing_period, price_cents, currency, entitlements_json)
values
  (
    'free',
    true,
    'monthly',
    0,
    'USD',
    '{"seats":1,"workspaces":1,"books":3,"ai_credits_monthly":0,"image_credits_monthly":0,"storage_gb":1,"rendering":true,"publishing_channels":["export"]}'::jsonb
  ),
  (
    'pro',
    false,
    'monthly',
    1900,
    'USD',
    '{"seats":1,"workspaces":5,"books":50,"ai_credits_monthly":5000,"image_credits_monthly":200,"storage_gb":50,"rendering":true,"publishing_channels":["export","kdp","apple_books"]}'::jsonb
  ),
  (
    'team',
    false,
    'monthly',
    4900,
    'USD',
    '{"seats":10,"workspaces":25,"books":500,"ai_credits_monthly":25000,"image_credits_monthly":1000,"storage_gb":500,"rendering":true,"publishing_channels":["export","kdp","apple_books","barnes_noble","lulu"]}'::jsonb
  )
on conflict do nothing;
