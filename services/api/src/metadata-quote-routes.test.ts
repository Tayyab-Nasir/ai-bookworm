import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { metadataQuoteRoutes } from "./routes/metadata-quotes.js";

const BOOK="11111111-1111-4111-8111-111111111111", WS="22222222-2222-4222-8222-222222222222";
const CHAPTER="33333333-3333-4333-8333-333333333333", VERSION="44444444-4444-4444-8444-444444444444";
const USER="55555555-5555-4555-8555-555555555555", SOURCE="Mira finds a map hidden beneath the old theatre.";
const hash=createHash("sha256").update(SOURCE).digest("hex"), auth={authorization:"Bearer good"};
type Row=Record<string,any>;

function catalog(){return {version:"synthetic-v1",approved:true,approvalReference:"synthetic-test-only",
  effectiveAt:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z",quoteLifetimeSeconds:600,
  entries:[{id:"metadata",label:"Synthetic metadata",maxInputTokens:2000,maxOutputTokens:1024,
    price:{version:"price-v1",provider:"openai",model:"gpt-6-astra-2026-09-01",rates:[
      {dimension:"text_input",microUsdPerMillionTokens:"1000000"},
      {dimension:"text_cached_input",microUsdPerMillionTokens:"100000"},
      {dimension:"text_output",microUsdPerMillionTokens:"2000000"}]},
    policy:{version:"policy-v1",approved:true,microUsdPerCredit:"1000",markupBasisPoints:15000,platformMicroUsd:"100",minimumCredits:"1"}}]};}

function setup(acceptReply:(job:Row)=>unknown=(job)=>job,acceptError:{code:string}|null=null){
  const store:Record<string,Row[]>={
    books:[{id:BOOK,workspace_id:WS,title:"The Old Theatre",subtitle:null,author_name:"Mira Vale",language:"en"}],
    workspace_members:[{workspace_id:WS,user_id:USER,role:"editor",status:"active"}],
    chapters:[{id:CHAPTER,book_id:BOOK,title:"The Map",order_index:0,current_document_version_id:VERSION}],
    document_versions:[{id:VERSION,chapter_id:CHAPTER,version_number:3,content_json:{nodes:[{id:"n1",type:"paragraph",text:SOURCE}]}}],
    book_bible_items:[],style_guides:[],metadata_token_quote_requests:[],ai_jobs:[],
  };
  const rpcCalls:{name:string,args:Row}[]=[];
  const fake=()=>({auth:{getUser:async(token:string)=>({data:{user:token==="good"?{id:USER}:null},error:null})},
    async rpc(name:string,args:Row){rpcCalls.push({name,args});
      if(name==="request_metadata_token_quote"){
        const existing=store.metadata_token_quote_requests.find((r)=>r.user_id===args.p_user_id&&r.idempotency_key===args.p_idempotency_key);
        if(existing)return {data:existing,error:null};
        const row={id:randomUUID(),user_id:args.p_user_id,book_id:args.p_book_id,workspace_id:args.p_workspace_id,
          generation_job_id:args.p_generation_job_id,generation_request_json:args.p_generation_request,catalog_json:args.p_catalog,
          idempotency_key:args.p_idempotency_key,status:"counting",lease_token:randomUUID(),created_at:new Date().toISOString(),
          usage_quote_json:null,quote_expires_at:null,accepted_job_id:null};
        store.metadata_token_quote_requests.push(row);return {data:row,error:null};
      }
      if(name==="complete_metadata_token_quote_count"){
        const row=store.metadata_token_quote_requests.find((r)=>r.id===args.p_request_id)!;
        row.status="ready";row.usage_quote_json=args.p_usage_quote;row.quote_expires_at=(args.p_usage_quote as Row).expiresAt;row.lease_token=null;
        row.generation_request_sha256=args.p_generation_request_sha256;return {data:row,error:null};
      }
      if(name==="fail_metadata_token_quote_count"){
        const row=store.metadata_token_quote_requests.find((r)=>r.id===args.p_request_id);if(row?.status==="counting")row.status="failed";
        return {data:true,error:null};
      }
      if(name==="accept_metadata_token_quote"){
        const row=store.metadata_token_quote_requests.find((r)=>r.id===args.p_request_id)!;
        row.accepted_job_id=row.generation_job_id;
        const job={id:row.generation_job_id,workspace_id:row.workspace_id,book_id:row.book_id,created_by:row.user_id,
          status:"queued",agent_type:"metadata",billing_mode:"quoted",output_ref:{},error_code:null};
        if(!store.ai_jobs.some((existing)=>existing.id===job.id))store.ai_jobs.push(job);
        return {data:acceptReply(job),error:acceptError};
      }
      return {data:null,error:{code:"42883"}};
    },
    from(table:string){const rows=store[table]??=[];const filters:((r:Row)=>boolean)[]=[];let columns="*",limit=Infinity,sort="",ascending=true;
      const builder:any={select(value="*"){columns=value;return this;},eq(key:string,value:unknown){filters.push((r)=>r[key]===value);return this;},
        in(key:string,values:unknown[]){filters.push((r)=>values.includes(r[key]));return this;},order(key:string,options?:{ascending?:boolean}){sort=key;ascending=options?.ascending??true;return this;},
        limit(value:number){limit=value;return this;},
        async maybeSingle(){const found=rows.filter((r)=>filters.every((f)=>f(r))).slice(0,1);return {data:found[0]?{...found[0]}:null,error:null};},
        then(resolve:(x:unknown)=>unknown){let found=rows.filter((r)=>filters.every((f)=>f(r)));if(sort)found=found.sort((a,b)=>String(a[sort]).localeCompare(String(b[sort]))*(ascending?1:-1));
          const data=found.slice(0,limit).map((r)=>columns==="*"?{...r}:Object.fromEntries(columns.split(",").map((k)=>[k,r[k]])));
          return Promise.resolve({data,error:null}).then(resolve);}};
      return builder;
    }}) as never;
  return {store,rpcCalls,fake};
}

async function testApp(fake:()=>never,fetcher:typeof fetch){const app=Fastify();await app.register(errorHandlerPlugin);
  await app.register(makeAuthPlugin(fake));await app.register(async(v1)=>metadataQuoteRoutes(v1,{fetcher}),{prefix:"/v1"});return app;}

test("metadata quote route persists consent before counting, recovers exact quotes, then accepts explicit totals",async(t)=>{
  const {store,rpcCalls,fake}=setup();const previousCatalog=process.env.METADATA_PRICING_CATALOG_JSON;
  const previousToken=process.env.AI_SERVICE_TOKEN;process.env.METADATA_PRICING_CATALOG_JSON=JSON.stringify(catalog());process.env.AI_SERVICE_TOKEN="internal-test";
  t.after(()=>{if(previousCatalog===undefined)delete process.env.METADATA_PRICING_CATALOG_JSON;else process.env.METADATA_PRICING_CATALOG_JSON=previousCatalog;
    if(previousToken===undefined)delete process.env.AI_SERVICE_TOKEN;else process.env.AI_SERVICE_TOKEN=previousToken;});
  let countCalls=0;const app=await testApp(fake,async(_url,init)=>{countCalls++;assert.equal(new Headers(init?.headers).get("x-service-token"),"internal-test");
    assert.equal((JSON.parse(String(init?.body)) as Row).input.book.title,"The Old Theatre");
    return Response.json({inputTokens:420,inputSha256:"a".repeat(64),model:"gpt-6-astra-2026-09-01",agentType:"metadata",maxOutputTokens:1024});});t.after(()=>app.close());
  const payload={modelId:"metadata",idempotencyKey:"metadata-test-key-1",allowProviderTokenCounting:true,maxTokens:6000};
  const consent=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes`,headers:auth,payload:{...payload,allowProviderTokenCounting:false}});
  assert.equal(consent.statusCode,422);assert.equal(countCalls,0);
  const created=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes`,headers:auth,payload});
  assert.equal(created.statusCode,201,created.body);assert.equal(created.headers["cache-control"],"private, no-store");
  assert.equal(countCalls,1);assert.equal(store.metadata_token_quote_requests.length,1);
  assert.equal(store.metadata_token_quote_requests[0].generation_request_json.input.chapters[CHAPTER].documentVersionId,VERSION);
  assert.equal(rpcCalls[0].name,"request_metadata_token_quote");assert.equal(rpcCalls[1].name,"complete_metadata_token_quote_count");
  const response=created.json();assert.equal(response.quote.status,"ready");assert.ok(response.quote.reservedCredits>0);
  const replay=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes`,headers:auth,payload});
  assert.equal(replay.statusCode,200,replay.body);assert.equal(countCalls,1,"ready quote replay called counter again");
  const accepted=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes/${response.request.id}/accept`,headers:auth,payload:{expectedCredits:response.quote.reservedCredits}});
  assert.equal(accepted.statusCode,202,accepted.body);assert.equal(accepted.json().status,"queued");
  assert.equal(rpcCalls.at(-1)?.name,"accept_metadata_token_quote");
  delete process.env.METADATA_PRICING_CATALOG_JSON;store.workspace_members[0].role="viewer";
  const status=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes/recover`,headers:auth,payload:{idempotencyKey:payload.idempotencyKey}});
  assert.equal(status.statusCode,200,status.body);assert.equal(status.json().job.id,accepted.json().jobId);
  assert.equal(status.json().quote.status,"accepted");assert.equal(countCalls,1);
});

test("metadata quote model and status APIs require book membership and hide commercial catalog data",async(t)=>{
  const {fake}=setup();const previous=process.env.METADATA_PRICING_CATALOG_JSON;process.env.METADATA_PRICING_CATALOG_JSON=JSON.stringify(catalog());
  t.after(()=>{if(previous===undefined)delete process.env.METADATA_PRICING_CATALOG_JSON;else process.env.METADATA_PRICING_CATALOG_JSON=previous;});
  const app=await testApp(fake,async()=>{throw new Error("model listing cannot call provider");});t.after(()=>app.close());
  const response=await app.inject({method:"GET",url:`/v1/books/${BOOK}/metadata/models`,headers:auth});
  assert.equal(response.statusCode,200,response.body);assert.equal(response.headers["cache-control"],"private, no-store");
  assert.equal(response.json().models[0].model,"gpt-6-astra-2026-09-01");
  assert.ok(!response.body.includes("microUsd"));assert.ok(!response.body.includes("approvalReference"));
  assert.equal((await app.inject({method:"GET",url:`/v1/books/${BOOK}/metadata/models`})).statusCode,401);
});

test("metadata quote recovery is key-first, read-only and independent of current source/catalog",async(t)=>{
  const {store,rpcCalls,fake}=setup();const previous=process.env.METADATA_PRICING_CATALOG_JSON,token=process.env.AI_SERVICE_TOKEN;
  process.env.METADATA_PRICING_CATALOG_JSON=JSON.stringify(catalog());process.env.AI_SERVICE_TOKEN="internal-test";
  t.after(()=>{if(previous===undefined)delete process.env.METADATA_PRICING_CATALOG_JSON;else process.env.METADATA_PRICING_CATALOG_JSON=previous;
    if(token===undefined)delete process.env.AI_SERVICE_TOKEN;else process.env.AI_SERVICE_TOKEN=token;});
  let calls=0;const app=await testApp(fake,async()=>{calls++;return Response.json({inputTokens:420,inputSha256:"a".repeat(64),model:"gpt-6-astra-2026-09-01",agentType:"metadata",maxOutputTokens:1024});});t.after(()=>app.close());
  const payload={modelId:"metadata",idempotencyKey:"metadata-recovery-key",allowProviderTokenCounting:true,chapterIds:[CHAPTER],maxTokens:6000};
  const created=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes`,headers:auth,payload});
  assert.equal(created.statusCode,201,created.body);const saved=created.json();const writes=rpcCalls.length;
  store.document_versions=[];delete process.env.METADATA_PRICING_CATALOG_JSON;
  const recovered=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes/recover`,headers:auth,payload:{idempotencyKey:payload.idempotencyKey}});
  assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().request.id,saved.request.id);
  assert.deepEqual(recovered.json().quote,saved.quote);assert.equal(recovered.headers["cache-control"],"private, no-store");
  assert.ok(!recovered.body.includes(SOURCE));assert.ok(!recovered.body.includes("approvalReference"));
  const replay=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes`,headers:auth,payload});
  assert.equal(replay.statusCode,200,replay.body);assert.deepEqual(replay.json().quote,saved.quote);
  assert.equal(calls,1);assert.equal(rpcCalls.length,writes,"recovery wrote or called provider");
  assert.equal((await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes`,headers:auth,payload:{...payload,tone:"different"}})).statusCode,409);
  assert.equal((await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes/recover`,headers:auth,payload:{idempotencyKey:"missing-original-key"}})).statusCode,404);
  assert.equal((await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes/recover`,payload:{idempotencyKey:payload.idempotencyKey}})).statusCode,401);
  store.metadata_token_quote_requests[0].user_id=randomUUID();
  assert.equal((await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes/recover`,headers:auth,payload:{idempotencyKey:payload.idempotencyKey}})).statusCode,404);
});

test("metadata public offers reject noncanonical prices and mismatched saved request bindings",async(t)=>{
  const {store,fake}=setup();const previous=process.env.METADATA_PRICING_CATALOG_JSON,token=process.env.AI_SERVICE_TOKEN;
  process.env.METADATA_PRICING_CATALOG_JSON=JSON.stringify(catalog());process.env.AI_SERVICE_TOKEN="internal-test";
  t.after(()=>{if(previous===undefined)delete process.env.METADATA_PRICING_CATALOG_JSON;else process.env.METADATA_PRICING_CATALOG_JSON=previous;
    if(token===undefined)delete process.env.AI_SERVICE_TOKEN;else process.env.AI_SERVICE_TOKEN=token;});
  const app=await testApp(fake,async()=>Response.json({inputTokens:420,inputSha256:"a".repeat(64),model:"gpt-6-astra-2026-09-01",agentType:"metadata",maxOutputTokens:1024}));t.after(()=>app.close());
  const created=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes`,headers:auth,payload:{modelId:"metadata",idempotencyKey:"metadata-integrity-key",allowProviderTokenCounting:true}});
  assert.equal(created.statusCode,201,created.body);const saved=structuredClone(store.metadata_token_quote_requests[0]);
  for(const mutate of [
    (r:Row)=>{r.usage_quote_json.reservedCredits="1";},
    (r:Row)=>{r.usage_quote_json.fingerprint="f".repeat(64);},
    (r:Row)=>{r.generation_request_sha256="b".repeat(64);},
    (r:Row)=>{r.generation_request_json.maxOutputTokens=512;},
    (r:Row)=>{r.generation_request_json.model="other-model";},
    (r:Row)=>{r.generation_request_json.bookId=randomUUID();},
    (r:Row)=>{r.accepted_job_id=randomUUID();},
  ]){
    store.metadata_token_quote_requests[0]=structuredClone(saved);mutate(store.metadata_token_quote_requests[0]);
    const result=await app.inject({method:"GET",url:`/v1/books/${BOOK}/metadata/quote-requests/${saved.id}`,headers:auth});
    assert.equal(result.statusCode,503,result.body);
  }
});

test("metadata acceptance rejects foreign RPC identity and recovers the original accepted job",async(t)=>{
  let mutation:(job:Row)=>Row=(job)=>({...job,id:randomUUID()});
  const {store,rpcCalls,fake}=setup((job)=>mutation(job));
  const previous=process.env.METADATA_PRICING_CATALOG_JSON,token=process.env.AI_SERVICE_TOKEN;
  process.env.METADATA_PRICING_CATALOG_JSON=JSON.stringify(catalog());process.env.AI_SERVICE_TOKEN="internal-test";
  t.after(()=>{if(previous===undefined)delete process.env.METADATA_PRICING_CATALOG_JSON;else process.env.METADATA_PRICING_CATALOG_JSON=previous;
    if(token===undefined)delete process.env.AI_SERVICE_TOKEN;else process.env.AI_SERVICE_TOKEN=token;});
  let counts=0;const app=await testApp(fake,async()=>{counts++;return Response.json({inputTokens:420,inputSha256:"a".repeat(64),model:"gpt-6-astra-2026-09-01",agentType:"metadata",maxOutputTokens:1024});});t.after(()=>app.close());
  const created=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes`,headers:auth,payload:{modelId:"metadata",idempotencyKey:"metadata-accept-identity",allowProviderTokenCounting:true}});
  assert.equal(created.statusCode,201,created.body);const saved=created.json();
  for(const change of [
    (job:Row)=>({...job,id:randomUUID()}), (job:Row)=>({...job,workspace_id:randomUUID()}),
    (job:Row)=>({...job,book_id:randomUUID()}), (job:Row)=>({...job,created_by:randomUUID()}),
    (job:Row)=>({...job,agent_type:"writer"}), (job:Row)=>({...job,billing_mode:"operational"}),
  ]){
    mutation=change;
    const accepted=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes/${saved.request.id}/accept`,headers:auth,payload:{expectedCredits:saved.quote.reservedCredits}});
    assert.equal(accepted.statusCode,503,accepted.body);assert.match(accepted.json().error.message,/recover|confirm/i);
    assert.ok(!accepted.body.includes("No generation was started"),"uncertain acceptance cannot deny a durable outcome");
    // The RPC may have committed despite its unverifiable reply. Read, never
    // create a different key or automatically accept a second time.
    const writes=rpcCalls.length;
    const recovered=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes/recover`,headers:auth,payload:{idempotencyKey:"metadata-accept-identity"}});
    assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().job.id,store.metadata_token_quote_requests[0].generation_job_id);
    assert.equal(recovered.json().quote.status,"accepted");assert.equal(rpcCalls.length,writes);assert.equal(counts,1);
  }
});

test("metadata request status exposes only allowlisted counting error codes",async(t)=>{
  const {store,fake}=setup();const app=await testApp(fake,async()=>{throw new Error("status cannot count");});t.after(()=>app.close());
  const requestId=randomUUID();const row={id:requestId,user_id:USER,book_id:BOOK,workspace_id:WS,status:"failed",
    accepted_job_id:null,created_at:new Date().toISOString(),error_code:"private-provider-diagnostic"};
  store.metadata_token_quote_requests.push(row);
  const url=`/v1/books/${BOOK}/metadata/quote-requests/${requestId}`;
  const privateStatus=await app.inject({method:"GET",url,headers:auth});assert.equal(privateStatus.statusCode,200,privateStatus.body);
  assert.equal(privateStatus.json().request.errorCode,undefined);assert.ok(!privateStatus.body.includes(row.error_code));
  row.error_code="counting_outcome_unknown";
  const known=await app.inject({method:"GET",url,headers:auth});assert.equal(known.json().request.errorCode,"counting_outcome_unknown");
});

test("unknown metadata acceptance error preserves the possibly committed outcome for read-only recovery",async(t)=>{
  const {fake,rpcCalls}=setup((job)=>job,{code:"08006"});
  const previous=process.env.METADATA_PRICING_CATALOG_JSON,token=process.env.AI_SERVICE_TOKEN;
  process.env.METADATA_PRICING_CATALOG_JSON=JSON.stringify(catalog());process.env.AI_SERVICE_TOKEN="internal-test";
  t.after(()=>{if(previous===undefined)delete process.env.METADATA_PRICING_CATALOG_JSON;else process.env.METADATA_PRICING_CATALOG_JSON=previous;
    if(token===undefined)delete process.env.AI_SERVICE_TOKEN;else process.env.AI_SERVICE_TOKEN=token;});
  const app=await testApp(fake,async()=>Response.json({inputTokens:420,inputSha256:"a".repeat(64),model:"gpt-6-astra-2026-09-01",agentType:"metadata",maxOutputTokens:1024}));t.after(()=>app.close());
  const created=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes`,headers:auth,payload:{modelId:"metadata",idempotencyKey:"metadata-unknown-accept",allowProviderTokenCounting:true}});
  assert.equal(created.statusCode,201,created.body);const saved=created.json();
  const accepted=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes/${saved.request.id}/accept`,headers:auth,payload:{expectedCredits:saved.quote.reservedCredits}});
  assert.equal(accepted.statusCode,503,accepted.body);assert.match(accepted.json().error.message,/Recover this same request/);
  assert.ok(!accepted.body.includes("No generation was started"));const writes=rpcCalls.length;
  const recovered=await app.inject({method:"POST",url:`/v1/books/${BOOK}/metadata/quotes/recover`,headers:auth,payload:{idempotencyKey:"metadata-unknown-accept"}});
  assert.equal(recovered.statusCode,200,recovered.body);assert.equal(recovered.json().quote.status,"accepted");
  assert.equal(rpcCalls.length,writes);
});
