-- Paid translation creation is quote-only. The older RPC could be invoked by
-- an authenticated PostgREST caller outside the quote/hold/dispatch workflow.
-- Retain function definitions solely for migration/audit history. Existing
-- projects remain readable/adoptable; only jobs already running may settle,
-- and no role may enqueue or newly claim a legacy project.
revoke all on function public.queue_translation_project(uuid,text,text)
  from public, anon, authenticated, service_role;
-- Do not strand a job that was already running before this migration: its
-- renew/complete/fail functions retain service access. New operational claims
-- stop here, so an old worker cannot begin another unquoted provider request.
revoke all on function public.claim_translation_job(integer)
  from public, anon, authenticated, service_role;

comment on function public.queue_translation_project(uuid,text,text) is
  'RETIRED: use immutable translation quote preparation and acceptance; no execute grants.';
comment on function public.claim_translation_job(integer) is
  'RETIRED: do not claim operational translation jobs; quoted worker uses claim_quoted_translation_job.';
