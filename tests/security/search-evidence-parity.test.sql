-- Read-only SQL oracle for the source reader's exact FTS projection. No DDL.
begin;
do $$
declare projected text; source_text text;
begin
  projected := private.searchable_book_node_text(
    '{"id":"rich","type":"table","text":"Body","caption":"Caption","altText":"Description","rows":[["A",""],["B","C"]]}'::jsonb);
  assert projected = E'Body\nCaption\nDescription\nA\n\nB\nC', 'rich searchable field order or blank cells changed';
  assert private.searchable_book_node_text('{"text":"","caption":"Caption","altText":"","rows":[[]]}'::jsonb) = 'Caption', 'empty field handling changed';
  assert private.searchable_book_node_text('{"rows":[["",""]]}'::jsonb) = E'\n', 'empty table cells must retain separators';
  assert private.searchable_book_node_text('{"text":"","rows":[]}'::jsonb) = '', 'empty searchable node changed';
  source_text := repeat('🌙',1600) || 'Silver compass';
  assert length(source_text) = 1614, 'PostgreSQL must count Unicode code points';
  assert substring(source_text from 1601 for 1800) = 'Silver compass', 'zero-based JS chunk must map to one-based SQL substring';
  assert md5(substring(source_text from 1601 for 1800)) = md5('Silver compass'), 'chunk fingerprint is not full-node hash';
end;
$$;
rollback;
