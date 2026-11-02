// Synthetic provider only. Called by the guarded disposable native database harness.
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {join, delimiter} from 'node:path';
import {fileURLToPath} from 'node:url';
import {credentialVault} from '../../services/api/src/lib/ai-connection-vault.ts';
import {customerDispatchSigner} from '../../services/api/src/lib/customer-ai-dispatch.ts';
import {customerAiComposition} from '../../services/api/src/lib/customer-ai-composition.ts';

const root=fileURLToPath(new URL('../../',import.meta.url));
const quote=value=>"'"+String(value).replaceAll("'","''")+"'";
const json=value=>quote(JSON.stringify(value))+'::jsonb';
function python(file,value) {
  const env=Object.fromEntries(['PATH','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','BOOKWORM_PYTHON'].filter(k=>process.env[k]).map(k=>[k,process.env[k]]));
  Object.assign(env,{PYTHONPATH:[join(root,'services/ai'),join(root,'services/ai/tests')].join(delimiter),PYTHONIOENCODING:'utf-8',PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'});
  const result=spawnSync(process.execPath,[join(root,'scripts/run-python.mjs'),file],{cwd:root,env,input:JSON.stringify(value),encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024,windowsHide:true});
  if(result.error || result.status!==0) throw Error('Synthetic Python fixture failed: '+(result.error?.message??result.stderr?.slice(0,1200)));
  return JSON.parse(result.stdout);
}
export async function customerAiNativeComposition({sql}) {
  const [scope,request]=python(join(root,'services/ai/tests/customer_native_fixture.py'),{});
  const {ownerId:u,workspaceId:ws,bookId:b,connectionId:connection,jobId:job}=scope;
  const chapter=request.input.chapterIds[0], version=request.input.chapters[chapter].documentVersionId;
  const org=randomUUID(),plan=randomUUID(),subscription=randomUUID(),policy=randomUUID(),operation=randomUUID();
  const binding={ownerId:u,provider:'openai',connectionId:connection,revision:1};
  const vault=credentialVault({AI_CONNECTION_VAULT_KEYRING_JSON:JSON.stringify({active:'test',keys:{test:randomBytes(32).toString('base64')}})});
  const credential=vault.seal('synthetic-customer-credential-0001',binding);
  const source=[{chapterId:chapter,documentVersionId:version,version:1}];
  const create=(consent,jobId=job,op=operation)=>`public.create_customer_ai_job(${quote(jobId)},${quote(op)},${quote(u)},${quote(ws)},${quote(b)},${quote(connection)},1,${quote(policy)},${quote(scope.expectedRequestSha256)},${json(request)},${json(source)},0,${consent})`;
  await sql(`begin;
  insert into auth.users(id,email) values(${quote(u)},'synthetic-native@local.test');
  insert into public.organizations(id,name,slug,owner_user_id) values(${quote(org)},'Synthetic',${quote(org)},${quote(u)});
  insert into public.workspaces(id,organization_id,name,slug,created_by) values(${quote(ws)},${quote(org)},'Synthetic',${quote(ws)},${quote(u)});
  insert into public.workspace_members(workspace_id,user_id,role) values(${quote(ws)},${quote(u)},'writer');
  insert into public.books(id,workspace_id,title,author_name,created_by) values(${quote(b)},${quote(ws)},'Synthetic','Author',${quote(u)});
  insert into public.chapters(id,book_id,order_index,title) values(${quote(chapter)},${quote(b)},0,'Chapter');
  insert into public.document_versions(id,chapter_id,version_number,content_json,plain_text,created_by) values(${quote(version)},${quote(chapter)},1,'{"nodes":[{"id":"n1","type":"paragraph","text":"Rain fell."}]}','Rain fell.',${quote(u)});
  update public.chapters set current_document_version_id=${quote(version)} where id=${quote(chapter)};
  insert into public.plans(id,name,billing_period,price_cents,entitlements_json,is_active) values(${quote(plan)},'Synthetic','month',1000,'{"customer_ai_enabled":true,"customer_ai_requests_monthly":10}',true);
  insert into public.subscriptions(id,organization_id,plan_id,status,current_period_end) values(${quote(subscription)},${quote(org)},${quote(plan)},'active',clock_timestamp()+interval '1 day');
  insert into bookworm_credentials.customer_ai_policies(id,provider,agent_type,model_policy,fee_mode,fee_credits,enabled,expires_at) values(${quote(policy)},'openai','writer',${json(scope.policy)},'platform_plan',0,true,clock_timestamp()+interval '1 hour');
  set local request.jwt.claims='{"role":"service_role"}';
  select public.mutate_ai_connection(${quote(u)},'openai',${quote(connection)},null,${quote(randomUUID())},'save','0001',${quote(credential.keyId)},${quote(credential.nonce)},${quote(credential.ciphertext)},${quote(credential.tag)});
  do $$ begin begin perform ${create('false')}; raise exception 'missing consent accepted'; exception when invalid_parameter_value then null; end; end $$;
  update public.subscriptions set status='past_due' where id=${quote(subscription)};
  do $$ begin begin perform ${create('true')}; raise exception 'unpaid plan accepted'; exception when check_violation then null; end; end $$;
  do $$ begin if exists (select 1 from public.ai_jobs where id=${quote(job)}) then raise exception 'denied request created a job'; end if; end $$;
  update public.subscriptions set status='active' where id=${quote(subscription)};
  select (${create('true')}).id;
  commit;`);
  console.log('Verified explicit consent and paid entitlement using native SQL.');
  const allowed={discover_customer_ai_ready_jobs:['p_limit','p_after_created_at','p_after_job_id'],claim_customer_ai_job:['p_job_id','p_lease_seconds'],prepare_customer_ai_dispatch:['p_job_id','p_lease_token'],resolve_customer_ai_dispatch:['p_job_id','p_lease_token','p_fingerprint'],complete_customer_ai_job:['p_job_id','p_owner_id','p_receipt_fingerprint'],hold_customer_ai_job:['p_job_id','p_lease_token']};
  const events=[];let posts=0, receiptFingerprint;
  const databaseFetch=async(input,init)=>{
    const url=new URL(input instanceof Request?input.url:String(input));
    assert.equal(url.origin,'https://database.invalid'); assert.equal(init?.method,'POST');
    const name=url.pathname.split('/').at(-1);
    if (!allowed[name]) throw Error('Unexpected RPC');
    const args=JSON.parse(String(init?.body??'{}'));
    assert.ok(Object.keys(args).every(key=>allowed[name].includes(key))); events.push(name);
    const vals=allowed[name].map(k=>args[k]===null||args[k]===undefined?'null':typeof args[k]==='number'?String(args[k]):quote(args[k]));
    const expr=`public.${name}(${vals.join(',')})`;
    const statement=name==='discover_customer_ai_ready_jobs'?`select coalesce(json_agg(t),'[]'::json) from ${expr} t;`:`select to_jsonb(${expr});`;
    try { const value=await sql(`begin; set local role service_role; set local request.jwt.claims='{"role":"service_role"}'; ${statement} commit;`);return Response.json(JSON.parse(value)); }
    catch { console.log(`Synthetic RPC ${name} failed`); return Response.json({message:'synthetic database RPC failed'}, {status:400}); }
  };
  const signer=customerDispatchSigner('synthetic',Buffer.from(Array.from({length:32},(_,i)=>i)),()=>1900000000);
  const serviceFetch=async input=>{
    assert.equal(new URL(input.url).origin,'https://private.invalid');
    posts++;const body=Buffer.from(await input.arrayBuffer());
    assert.equal(await sql(`begin; set local role service_role; set local request.jwt.claims='{"role":"service_role"}'; select public.customer_ai_dispatch_authorized(${json(JSON.parse(Buffer.from(JSON.parse(body.toString()).payload,'base64url').toString()).scope)}); commit;`),'t');
    const result=python(join(root,'services/ai/tests/customer_cross_runtime_bridge.py'),{action:'dispatch',body:body.toString('base64')});
    assert.equal(result.status,201);assert.equal(result.providerCalls,1);assert.equal(result.receiptCount,1);
    const receipt=result.result;receiptFingerprint=receipt.customerDispatchSha256;
    await sql(`insert into public.ai_review_service_receipts(job_id,request_sha256,result_json) values(${quote(job)},${quote(receiptFingerprint)},${json(receipt)});`);
    throw Error('Synthetic response lost after receipt persisted');
  };
  const runtime=customerAiComposition({databaseUrl:'https://database.invalid',serviceRoleKey:'synthetic-private-database-token',serviceUrl:'https://private.invalid',serviceToken:'synthetic-private-service-token',mode:'test',vault,signer,databaseFetch,serviceFetch});
  try {
    await assert.rejects(runtime.tick(), /unresolved operation/);
    console.log(JSON.stringify({events,posts}));
    assert.equal(posts,1);assert.ok(receiptFingerprint);
    const state=JSON.parse(await sql(`select json_build_object('status',j.status,'receipts',(select count(*) from public.ai_review_service_receipts where job_id=j.id),'runs',(select count(*) from public.ai_runs where ai_job_id=j.id),'suggestions',(select count(*) from public.ai_suggestions where ai_job_id=j.id),'fees',(select count(*) from public.credit_ledger where reference_id=j.id)) from public.ai_jobs j where id=${quote(job)};`));
    assert.deepEqual(state,{status:'succeeded',receipts:1,runs:1,suggestions:1,fees:0});
    await sql(`begin; set local role service_role; set local request.jwt.claims='{"role":"service_role"}'; select public.complete_customer_ai_job(${quote(job)},${quote(u)},${quote(receiptFingerprint)}); commit;`);
    assert.equal(await sql(`select count(*) from public.ai_runs where ai_job_id=${quote(job)};`),'1');assert.equal(posts,1);
    console.log('PASS native PostgreSQL + TS customer composition + synthetic Python ASGI: one provider call, lost response, persisted receipt, idempotent completion, no platform credits.');
  } finally {await runtime.close();signer.dispose();}
}
