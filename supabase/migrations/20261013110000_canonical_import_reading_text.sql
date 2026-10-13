-- Forward-only reading projections for new initial/imported versions. Apply
-- atomically through the supported migration runner; never rewrite history.
create function private.canonical_book_nodes_plain_text(p_nodes jsonb) returns text
language plpgsql immutable security invoker set search_path='' as $$
declare v_node jsonb; v_row jsonb; v_cell jsonb; v_text text; v_caption text;
  v_pieces text[]:='{}'; v_rows text[]; v_cells text[];
begin
  if pg_catalog.jsonb_typeof(p_nodes) is distinct from 'array' then
    raise exception 'Reading text requires canonical nodes' using errcode='22023';
  end if;
  for v_node in select value from pg_catalog.jsonb_array_elements(p_nodes) loop
    if pg_catalog.jsonb_typeof(v_node) is distinct from 'object' then
      raise exception 'Reading text requires canonical node fields' using errcode='22023';
    end if;
    v_text:='';
    if v_node?'text' then
      if pg_catalog.jsonb_typeof(v_node->'text') is distinct from 'string' then
        raise exception 'Reading text requires string text' using errcode='22023';
      end if;
      -- Presence wins, including explicit empty text over retained table rows.
      v_text:=v_node->>'text';
    elsif v_node->>'type'='table' and v_node?'rows' then
      if pg_catalog.jsonb_typeof(v_node->'rows') is distinct from 'array' then
        raise exception 'Reading text requires table rows' using errcode='22023';
      end if;
      v_rows:='{}';
      for v_row in select value from pg_catalog.jsonb_array_elements(v_node->'rows') loop
        if pg_catalog.jsonb_typeof(v_row) is distinct from 'array' then
          raise exception 'Reading text requires table cells' using errcode='22023';
        end if;
        v_cells:='{}';
        for v_cell in select value from pg_catalog.jsonb_array_elements(v_row) loop
          if pg_catalog.jsonb_typeof(v_cell) is distinct from 'string' then
            raise exception 'Reading text requires string table cells' using errcode='22023';
          end if;
          v_cells:=pg_catalog.array_append(v_cells,v_cell#>>'{}');
        end loop;
        v_rows:=pg_catalog.array_append(v_rows,pg_catalog.array_to_string(v_cells,E'\t'));
      end loop;
      v_text:=pg_catalog.array_to_string(v_rows,E'\n');
    end if;
    if v_text<>'' then v_pieces:=pg_catalog.array_append(v_pieces,v_text); end if;
    if v_node->>'type'='image' and v_node?'caption' then
      if pg_catalog.jsonb_typeof(v_node->'caption') is distinct from 'string' then
        raise exception 'Reading text requires string image captions' using errcode='22023';
      end if;
      v_caption:=v_node->>'caption';
      if v_caption<>'' and v_caption<>v_text then
        v_pieces:=pg_catalog.array_append(v_pieces,v_caption);
      end if;
    end if;
  end loop;
  -- No whitespace normalization, rich-run expansion or accessibility alt text.
  return pg_catalog.array_to_string(v_pieces,E'\n\n');
end $$;

create function private.canonical_book_plain_text_word_count(p_text text) returns integer
language plpgsql immutable security invoker set search_path='' as $$
declare v_text text;
  v_whitespace constant text:=E' \t\n\r\f'||pg_catalog.chr(11)||pg_catalog.chr(160)||pg_catalog.chr(5760)
    ||pg_catalog.chr(8192)||pg_catalog.chr(8193)||pg_catalog.chr(8194)||pg_catalog.chr(8195)
    ||pg_catalog.chr(8196)||pg_catalog.chr(8197)||pg_catalog.chr(8198)||pg_catalog.chr(8199)
    ||pg_catalog.chr(8200)||pg_catalog.chr(8201)||pg_catalog.chr(8202)||pg_catalog.chr(8232)
    ||pg_catalog.chr(8233)||pg_catalog.chr(8239)||pg_catalog.chr(8287)||pg_catalog.chr(12288)||pg_catalog.chr(65279);
begin
  if p_text is null then raise exception 'Reading word count requires text' using errcode='22023'; end if;
  -- Match ECMAScript trim and /\s+/u rather than locale-dependent POSIX space.
  v_text:=pg_catalog.btrim(p_text,v_whitespace);
  if v_text='' then return 0; end if;
  return pg_catalog.cardinality(pg_catalog.regexp_split_to_array(v_text,'['||v_whitespace||']+'));
end $$;
revoke all on function private.canonical_book_nodes_plain_text(jsonb),private.canonical_book_plain_text_word_count(text) from public,anon;
grant execute on function private.canonical_book_nodes_plain_text(jsonb),private.canonical_book_plain_text_word_count(text) to authenticated,service_role;
-- Authenticated already has private USAGE. Service-invoker import needs lookup
-- of these pure functions only; no table/data or security-definer grant is added.
grant usage on schema private to service_role;

do $migration$
declare v_signature text; v_oid oid; v_definition text; v_count text; v_config text[];
  v_definer boolean; v_set boolean; v_return oid;
  v_projection constant text:=$projection$select coalesce(string_agg(value->>'text', E'\n\n' order by ordinality),'') into v_text
      from jsonb_array_elements(v_item->'nodes') with ordinality;$projection$;
begin
  foreach v_signature in array array['public.create_book_chapters(uuid,jsonb,uuid)',
    'public.complete_manuscript_import(uuid,uuid,uuid,text,jsonb,jsonb,jsonb)'] loop
    v_oid:=pg_catalog.to_regprocedure(v_signature);
    if v_oid is null then raise exception 'Canonical import reading text target definition drift: %',v_signature; end if;
    select p.prosecdef,p.proconfig,p.proretset,p.prorettype into v_definer,v_config,v_set,v_return
      from pg_catalog.pg_proc p where p.oid=v_oid;
    if v_definer or v_config is distinct from array['search_path=public, pg_temp']
      or (v_signature like 'public.create_book_chapters%' and (not v_set or v_return<>'public.chapters'::pg_catalog.regtype))
      or (v_signature like 'public.complete_manuscript_import%' and (v_set or v_return<>'jsonb'::pg_catalog.regtype)) then
      raise exception 'Canonical import reading text target metadata drift: %',v_signature;
    end if;
    v_definition:=pg_catalog.replace(pg_catalog.pg_get_functiondef(v_oid),E'\r\n',E'\n');
    v_count:=case when v_signature like 'public.create_book_chapters%' then
      $count$case when trim(v_text)='' then 0 else cardinality(regexp_split_to_array(trim(v_text), '\s+')) end$count$
      else $count$case when trim(v_text)='' then 0 else cardinality(regexp_split_to_array(trim(v_text),'\s+')) end$count$ end;
    if (pg_catalog.length(v_definition)-pg_catalog.length(pg_catalog.replace(v_definition,v_projection,'')))<>pg_catalog.length(v_projection)
      or (pg_catalog.length(v_definition)-pg_catalog.length(pg_catalog.replace(v_definition,v_count,'')))<>pg_catalog.length(v_count) then
      raise exception 'Canonical import reading text target definition drift: %',v_signature;
    end if;
    execute pg_catalog.replace(pg_catalog.replace(v_definition,v_projection,
      $replacement$v_text := private.canonical_book_nodes_plain_text(v_item->'nodes');$replacement$),
      v_count,'private.canonical_book_plain_text_word_count(v_text)');
  end loop;
end $migration$;
