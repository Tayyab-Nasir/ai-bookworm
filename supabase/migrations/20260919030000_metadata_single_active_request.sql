-- Serialize paid metadata generation for one author/book, even with different
-- idempotency keys from concurrent browser tabs. Terminal jobs release the slot.
-- Existing duplicate active jobs deliberately make this migration fail rather
-- than silently cancelling a potentially billable request. Reconcile first.
create unique index ai_jobs_one_active_metadata_per_author_book
  on public.ai_jobs (book_id, created_by)
  where agent_type = 'metadata' and status in ('queued', 'running');
