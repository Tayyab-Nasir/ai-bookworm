-- An idempotency key may replay the original request, but it must not silently
-- accept different narration settings under the same key.
do $$
declare
  v_signature regprocedure := 'public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb)'::regprocedure;
  v_definition text;
  v_original text := $fragment$
    if v_existing.created_by<>v_uid or v_existing.edition_id<>p_edition_id or v_existing.chapter_id<>p_chapter_id then
      raise exception 'audiobook request key conflict' using errcode='23505'; end if;
$fragment$;
  v_hardened text := $fragment$
    if v_existing.created_by<>v_uid
      or v_existing.edition_id<>p_edition_id
      or v_existing.chapter_id<>p_chapter_id
      or v_existing.voice<>p_voice
      or v_existing.speed<>p_speed
      or v_existing.instructions is distinct from nullif(trim(p_instructions),'') then
      raise exception 'audiobook request key conflict' using errcode='23505'; end if;
$fragment$;
begin
  select pg_get_functiondef(v_signature) into v_definition;
  if position(v_original in v_definition)=0 then
    raise exception 'queue_audiobook_project definition does not match the expected prior migration';
  end if;
  execute replace(v_definition,v_original,v_hardened);
end $$;

revoke all on function public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb) from public,anon;
grant execute on function public.queue_audiobook_project(uuid,uuid,text,text,numeric,text,jsonb) to authenticated;
