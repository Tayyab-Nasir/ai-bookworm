-- A completed/active saved-version reading batch is purchased only once per
-- author/book. Failed requests can be explicitly restarted under a new key.
create unique index book_bible_reading_batch_once
  on public.ai_jobs(created_by,book_id,
    (input_ref #>> '{reading,fingerprint}'),(input_ref #>> '{reading,pageIndex}'))
  where agent_type='bookbible' and status in ('queued','running','succeeded')
    and input_ref #>> '{reading,fingerprint}' is not null
    and input_ref #>> '{reading,pageIndex}' is not null;
