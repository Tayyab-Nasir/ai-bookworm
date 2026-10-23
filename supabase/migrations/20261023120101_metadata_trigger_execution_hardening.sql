-- A later metadata quote migration recreated this internal trigger helper
-- after the shared text guard replaced it, restoring default EXECUTE grants.
-- Keep it out of the client RPC surface without changing reservation logic,
-- active triggers, balances, or service-role access.
revoke all on function public.reserve_metadata_job_credit() from public, anon, authenticated;
grant execute on function public.reserve_metadata_job_credit() to service_role;
