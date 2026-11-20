-- PostgREST retries SQLSTATE 40001 as a database serialization failure.
-- These four exceptions represent permanent user-visible conflicts instead.
-- Keep each existing function body and grants intact apart from that code.
do $migration$
declare
  signature text;
  expected_count integer;
  routine regprocedure;
  definition text;
  previous_marker text := $old$errcode='40001'$old$;
  conflict_marker text := $new$errcode='PT409'$new$;
  marker_count integer;
begin
  for signature, expected_count in
    values
      ('public.mutate_ai_connection(uuid,text,uuid,integer,uuid,text,text,text,text,text,text)', 3),
      ('public.recover_ai_connection_operation(uuid,text,uuid,integer,uuid,text,boolean)', 1)
  loop
    routine := to_regprocedure(signature);
    if routine is null then
      raise exception 'AI connection function is missing: %', signature;
    end if;
    definition := pg_get_functiondef(routine);
    marker_count := (length(definition) - length(replace(definition, previous_marker, ''))) / length(previous_marker);
    if marker_count <> expected_count or position(conflict_marker in definition) > 0 then
      raise exception 'AI connection function differs from the reviewed conflict contract: %', signature;
    end if;
    execute replace(definition, previous_marker, conflict_marker);
  end loop;
end
$migration$;
