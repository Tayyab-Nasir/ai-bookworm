-- Verify SQL semantics of filtering before limit with real workspace RLS.
begin;
insert into auth.users(id,email) values
 ('aa600000-0000-4000-8000-000000000001','history-a@invalid.test'),
 ('aa600000-0000-4000-8000-000000000002','history-b@invalid.test');
insert into public.organizations(id,name,slug,owner_user_id) values
 ('aa610000-0000-4000-8000-000000000001','A','history-a','aa600000-0000-4000-8000-000000000001'),
 ('aa610000-0000-4000-8000-000000000002','B','history-b','aa600000-0000-4000-8000-000000000002');
insert into public.organization_members(organization_id,user_id,role) values
 ('aa610000-0000-4000-8000-000000000001','aa600000-0000-4000-8000-000000000001','owner'),
 ('aa610000-0000-4000-8000-000000000002','aa600000-0000-4000-8000-000000000002','owner');
insert into public.workspaces(id,organization_id,name,slug,created_by) values
 ('aa620000-0000-4000-8000-000000000001','aa610000-0000-4000-8000-000000000001','A','history-a','aa600000-0000-4000-8000-000000000001'),
 ('aa620000-0000-4000-8000-000000000002','aa610000-0000-4000-8000-000000000002','B','history-b','aa600000-0000-4000-8000-000000000002');
insert into public.workspace_members(workspace_id,user_id,role) values
 ('aa620000-0000-4000-8000-000000000001','aa600000-0000-4000-8000-000000000001','editor'),
 ('aa620000-0000-4000-8000-000000000002','aa600000-0000-4000-8000-000000000002','editor');
insert into public.books(id,workspace_id,title,author_name,created_by) values
 ('aa630000-0000-4000-8000-000000000001','aa620000-0000-4000-8000-000000000001','A','Author','aa600000-0000-4000-8000-000000000001'),
 ('aa630000-0000-4000-8000-000000000002','aa620000-0000-4000-8000-000000000002','B','Author','aa600000-0000-4000-8000-000000000002');
insert into public.editions(id,book_id,type,language) values
 ('aa640000-0000-4000-8000-000000000001','aa630000-0000-4000-8000-000000000001','ebook','en'),
 ('aa640000-0000-4000-8000-000000000002','aa630000-0000-4000-8000-000000000001','ebook','en'),
 ('aa640000-0000-4000-8000-000000000003','aa630000-0000-4000-8000-000000000002','ebook','en');
insert into public.publishing_jobs(id,book_id,edition_id,channel,status,request_json,idempotency_key,created_by,created_at) values
 ('aa650000-0000-4000-8000-000000000001','aa630000-0000-4000-8000-000000000001','aa640000-0000-4000-8000-000000000001','kdp','failed','{"action":"export_package"}','history-package-1','aa600000-0000-4000-8000-000000000001','2020-01-01'),
 ('aa650000-0000-4000-8000-000000000002','aa630000-0000-4000-8000-000000000001','aa640000-0000-4000-8000-000000000001','kdp','failed','{"action":"export_package"}','history-package-2','aa600000-0000-4000-8000-000000000001','2020-01-01'),
 ('aa650000-0000-4000-8000-000000000003','aa630000-0000-4000-8000-000000000002','aa640000-0000-4000-8000-000000000003','kdp','failed','{"action":"export_package"}','history-foreign','aa600000-0000-4000-8000-000000000002','2021-01-01');
insert into public.publishing_jobs(book_id,edition_id,channel,status,request_json,idempotency_key,created_by,created_at)
select 'aa630000-0000-4000-8000-000000000001',
 case when kind=2 then 'aa640000-0000-4000-8000-000000000002'::uuid else 'aa640000-0000-4000-8000-000000000001'::uuid end,
 case when kind=3 then 'lulu' else 'kdp' end,'failed',
 jsonb_build_object('action',case when kind=1 then 'validate' else 'export_package' end),
 'history-noise-'||kind||'-'||n,'aa600000-0000-4000-8000-000000000001','2021-01-01'::timestamptz
from generate_series(1,3) kind cross join generate_series(1,105) n;
set local role authenticated;
select set_config('request.jwt.claim.sub','aa600000-0000-4000-8000-000000000001',true);
do $$ declare ids uuid[]; begin
 select array_agg(id order by created_at desc,id desc) into ids from (
  select id,created_at from public.publishing_jobs
  where book_id='aa630000-0000-4000-8000-000000000001' and edition_id='aa640000-0000-4000-8000-000000000001'
   and channel='kdp' and request_json @> '{"action":"export_package"}'::jsonb
  order by created_at desc,id desc limit 2
 ) rows;
 assert ids=array['aa650000-0000-4000-8000-000000000002'::uuid,'aa650000-0000-4000-8000-000000000001'::uuid], 'filtered package history or deterministic ordering failed';
 assert not exists(select 1 from public.publishing_jobs where book_id='aa630000-0000-4000-8000-000000000002'), 'other tenant package leaked';
end $$;
select set_config('request.jwt.claim.sub','aa600000-0000-4000-8000-000000000002',true);
do $$ begin assert not exists(select 1 from public.publishing_jobs where book_id='aa630000-0000-4000-8000-000000000001'), 'first tenant package leaked'; end $$;
reset role;
rollback;
