-- A selected print proof remains bound to its cover through both durable completions.
begin;
set local request.jwt.claims = '{"role":"service_role"}';

do $$
declare
  actor uuid := gen_random_uuid(); org uuid := gen_random_uuid(); workspace uuid := gen_random_uuid();
  book uuid := gen_random_uuid(); edition uuid := gen_random_uuid();
  render_job uuid := gen_random_uuid(); preflight_job uuid := gen_random_uuid(); package_job uuid := gen_random_uuid();
  interior_asset uuid := gen_random_uuid(); cover_asset uuid := gen_random_uuid(); zip_asset uuid := gen_random_uuid();
  edition_revision text := '2026-11-19T00:00:00Z';
  snapshot jsonb := '{"schemaVersion":1,"coverAssetId":null,"illustrationAssetIds":[],"assets":[]}';
  pin jsonb := jsonb_build_object('editionUpdatedAt',edition_revision,'bookModelSha256',repeat('a',64),
    'imageSha256',repeat('b',64),'artworkSnapshot',snapshot);
  path_prefix text := 'workspaces/' || workspace || '/assets/';
  proof jsonb := jsonb_build_object('jobId',render_job,'sha256',repeat('c',64),'coverSha256',repeat('d',64));
  report jsonb := jsonb_build_object('ruleVersion','fixture','requestedChannel','kdp','channel','kdp','errors',0,'warnings',1,
    'findings',jsonb_build_array(jsonb_build_object('severity','warning','code','SYNTHETIC','message','Fixture warning',
      'rule_id','test-warning','rule_version','fixture','location','cover.pdf')),'sourcePrint',proof);
  zip_artifact jsonb := jsonb_build_object('assetId',zip_asset,'type','publishing_package','role','publishing_package',
    'name','Print Export','filename','kdp-export.zip','mimeType','application/zip','sizeBytes',12,'checksum',repeat('e',64),
    'storagePath',path_prefix || zip_asset || '/v1/kdp-export.zip');
  failure_detail text;
begin
  insert into auth.users(id,email) values(actor,'saved-print@local.test');
  insert into public.organizations(id,name,slug,owner_user_id) values(org,'Print Proof','saved-print-org',actor);
  insert into public.organization_members(organization_id,user_id,role) values(org,actor,'owner');
  insert into public.workspaces(id,organization_id,name,slug,created_by) values(workspace,org,'Proof desk','saved-print-ws',actor);
  insert into public.workspace_members(workspace_id,user_id,role) values(workspace,actor,'editor');
  insert into public.books(id,workspace_id,title,author_name,created_by) values(book,workspace,'Saved PDF','Author',actor);
  insert into public.editions(id,book_id,type,language,updated_at) values(edition,book,'print','en',edition_revision::timestamptz);
  insert into public.publishing_jobs(id,book_id,edition_id,channel,status,request_json,created_by,idempotency_key) values
    (render_job,book,edition,'render','running',pin || '{"action":"render"}',actor,render_job::text),
    (preflight_job,book,edition,'kdp','running',pin || jsonb_build_object('action','validate','sourcePrint',proof),actor,preflight_job::text),
    (package_job,book,edition,'kdp','running',pin || jsonb_build_object('action','export_package',
      'sourceRenderJobId',render_job,'sourcePreflightJobId',preflight_job),actor,package_job::text);

  perform set_config('role','service_role',true);
  perform public.complete_render_job(render_job,jsonb_build_array(
    jsonb_build_object('assetId',interior_asset,'type','rendered_book','role','rendered_print','name','Interior',
      'filename','book.pdf','mimeType','application/pdf','sizeBytes',256,'checksum',repeat('c',64),
      'storagePath',path_prefix || interior_asset || '/v1/book.pdf'),
    jsonb_build_object('assetId',cover_asset,'type','rendered_cover','role','rendered_cover','name','Cover',
      'filename','cover.pdf','mimeType','application/pdf','sizeBytes',128,'checksum',repeat('d',64),
      'storagePath',path_prefix || cover_asset || '/v1/cover.pdf')), 'fixture', '{}');

  begin
    perform public.complete_preflight_job(preflight_job,jsonb_set(report,'{sourcePrint,coverSha256}','null'));
    assert false, 'a receipt omitting the selected cover completed';
  exception when serialization_failure then
    get stacked diagnostics failure_detail = PG_EXCEPTION_DETAIL;
    assert failure_detail='bookworm_publishing_render_proof_changed', 'wrong refusal for changed receipt';
  end;
  update public.assets set status='archived' where id=cover_asset;
  begin
    perform public.complete_preflight_job(preflight_job,report);
    assert false, 'an unavailable cover completed preflight';
  exception when serialization_failure then
    get stacked diagnostics failure_detail = PG_EXCEPTION_DETAIL;
    assert failure_detail='bookworm_publishing_render_proof_changed', 'wrong refusal for lost eligibility';
  end;
  assert not exists(select 1 from public.publishing_validations where publishing_job_id=preflight_job), 'refused finding was committed';
  assert (select status='running' from public.publishing_jobs where id=preflight_job), 'refusal changed the pending preflight';
  update public.assets set status='draft' where id=cover_asset;
  perform public.complete_preflight_job(preflight_job,report);
  assert (select status='succeeded' and response_json->'sourcePrint'=proof from public.publishing_jobs where id=preflight_job),
    'the exact print preflight receipt was not saved';

  update public.assets set status='archived' where id=cover_asset;
  begin
    perform public.complete_publishing_package_job(package_job,zip_artifact,'fixture',render_job,preflight_job);
    assert false, 'an unavailable cover completed the package';
  exception when serialization_failure then
    get stacked diagnostics failure_detail = PG_EXCEPTION_DETAIL;
    assert failure_detail='bookworm_publishing_render_proof_changed', 'wrong package refusal for lost eligibility';
  end;
  assert not exists(select 1 from public.assets where id=zip_asset), 'refusal left a package asset';
  assert not exists(select 1 from public.usage_events where publishing_job_id=package_job), 'refusal left publishing usage';
  update public.assets set status='draft' where id=cover_asset;
  perform public.complete_publishing_package_job(package_job,zip_artifact,'fixture',render_job,preflight_job);
  assert (select status='succeeded' from public.publishing_jobs where id=package_job), 'the selected print proof did not package';
end $$;
rollback;
