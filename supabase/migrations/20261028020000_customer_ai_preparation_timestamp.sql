-- Keep the strict 15-minute constraint while using one timestamp for both
-- fields. Guard the replacement so a changed predecessor cannot be silently
-- overwritten. CREATE OR REPLACE preserves the existing RPC privileges.
do $migration$
declare
 definition text;
 old_declaration constant text := 'declare r bookworm_credentials.customer_ai_preparations; p bookworm_credentials.customer_ai_policies; org uuid;';
 new_declaration constant text := 'declare r bookworm_credentials.customer_ai_preparations; p bookworm_credentials.customer_ai_policies; org uuid; prepared_at timestamptz;';
 old_insert constant text := $old$ insert into bookworm_credentials.customer_ai_preparations(owner_id,operation_id,workspace_id,book_id,connection_id,
  credential_revision,policy_id,request_sha256,request_snapshot,source_versions,context_omitted,expires_at)
 values(p_owner_id,p_operation_id,p_workspace_id,p_book_id,p_connection_id,p_revision,p.id,p_request_sha256,p_request,p_sources,
  p_context_omitted,least(p.expires_at,clock_timestamp()+interval '15 minutes'));$old$;
 new_insert constant text := $new$ prepared_at:=clock_timestamp();
 insert into bookworm_credentials.customer_ai_preparations(owner_id,operation_id,workspace_id,book_id,connection_id,
  credential_revision,policy_id,request_sha256,request_snapshot,source_versions,context_omitted,created_at,expires_at)
 values(p_owner_id,p_operation_id,p_workspace_id,p_book_id,p_connection_id,p_revision,p.id,p_request_sha256,p_request,p_sources,
  p_context_omitted,prepared_at,least(p.expires_at,prepared_at+interval '15 minutes'));$new$;
begin
 select pg_get_functiondef('public.prepare_customer_ai_request(uuid,uuid,uuid,uuid,uuid,integer,uuid,text,jsonb,jsonb,integer)'::regprocedure) into strict definition;
 if (length(definition)-length(replace(definition,old_declaration,''))) / length(old_declaration) <> 1
   or (length(definition)-length(replace(definition,old_insert,''))) / length(old_insert) <> 1 then
  raise exception 'unexpected customer AI preparation definition';
 end if;
 definition:=replace(replace(definition,old_declaration,new_declaration),old_insert,new_insert);
 execute definition;
end $migration$;
