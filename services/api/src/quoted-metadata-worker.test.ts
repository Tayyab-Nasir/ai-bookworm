import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteUsage } from "./lib/usage-pricing.js";
import { runOneQuotedMetadataJob } from "./lib/quoted-metadata-worker.js";

const jobId="10000000-0000-4000-8000-000000000001",requestId="10000000-0000-4000-8000-000000000002";
const userId="20000000-0000-4000-8000-000000000001",workspaceId="20000000-0000-4000-8000-000000000002";
const bookId="30000000-0000-4000-8000-000000000001",chapterId="30000000-0000-4000-8000-000000000002";
const versionId="40000000-0000-4000-8000-000000000001",lease="50000000-0000-4000-8000-000000000001";
const inputHash="a".repeat(64),nodeHash="b".repeat(64),sourceHash="c".repeat(64),fingerprint="d".repeat(64);
const generationRequest={jobId,workspaceId,bookId,agentType:"metadata",model:"gpt-6-astra-2026-09-01",maxOutputTokens:1000,
  contextPolicy:{includeBookBible:true,includeStyleGuide:true,includeRelatedContext:false,semanticTopK:5,maxTokens:6000},
  input:{chapterIds:[chapterId],chapters:{[chapterId]:{id:chapterId,documentVersionId:versionId,version:1,title:"Opening",order:0,
    nodes:[{id:"n1",text:"The lighthouse keeps a secret through the winter.",textHash:nodeHash,truncated:false}]}},
    book:{title:"Winter Light",subtitle:null,author:"Iris Vale",language:"en"},styleGuide:{},bookBible:[],relatedContext:[],userInstruction:"Create metadata."}};
const quote=()=>quoteUsage({scope:{jobId,workspaceId,userId,inputSha256:inputHash},price:{version:"price-v1",provider:"openai",
  model:generationRequest.model,rates:[{dimension:"text_input",microUsdPerMillionTokens:"1000000"},
    {dimension:"text_cached_input",microUsdPerMillionTokens:"100000"},{dimension:"text_output",microUsdPerMillionTokens:"2000000"}]},
  policy:{version:"policy-v1",approved:true,microUsdPerCredit:"1000",markupBasisPoints:15000,platformMicroUsd:"100",minimumCredits:"1"},
  maximumTokens:[{dimension:"text_input",tokens:"1000"},{dimension:"text_cached_input",tokens:"1000"},{dimension:"text_output",tokens:"1000"}],
  createdAt:"2026-09-25T00:00:00.000Z",expiresAt:"2026-09-25T01:00:00.000Z"});
const candidate={suggestionKind:"metadata_candidate",status:"pending",description:"A lighthouse keeper uncovers a winter map that changes the fate of her isolated town.",
  keywords:["lighthouse","winter map"],categories:["Fiction / Mystery"],audience:"Adult readers",rationale:"The selected opening establishes the lighthouse and hidden map.",confidence:0.9,
  sourceRefs:[{chapterId,documentVersionId:versionId,nodeId:"n1",textHash:nodeHash}]};
const serviceResult={jobId,bookId,workspaceId,agentType:"metadata",status:"succeeded",provider:"openai",model:generationRequest.model,requestId:"req-metadata-1",
  suggestions:[candidate],diagnostics:[],usage:{inputTokens:90,outputTokens:60,estimatedCostUsd:0.0002,measuredTokens:[
    {dimension:"text_input",tokens:"80"},{dimension:"text_cached_input",tokens:"10"},{dimension:"text_output",tokens:"60"}]}};

function fixture(options:{stale?:boolean;postFailure?:boolean;receiptAvailable?:boolean;dispatched?:boolean;completionReplyLost?:boolean;completionReplyThrown?:boolean;leaseLost?:boolean;dispatchWaitMs?:number;
  leaseLostWhen?:(calls:string[])=>boolean}={}){
  const funded={job_id:jobId,user_id:userId,workspace_id:workspaceId,quote_json:quote(),reserved_credits:Number(quote().reservedCredits),status:"held",settlement_json:null as unknown};
  const saved={id:requestId,user_id:userId,workspace_id:workspaceId,book_id:bookId,generation_job_id:jobId,status:"ready",
    generation_request_json:generationRequest,generation_request_sha256:inputHash,source_sha256:sourceHash,accepted_job_id:jobId};
  const job={id:jobId,workspace_id:workspaceId,book_id:bookId,created_by:userId,billing_mode:"quoted",lease_token:lease,
    input_ref:{metadataQuoteRequestId:requestId,sourceSha256:sourceHash,generationRequestSha256:inputHash,
      contextSources:[{chapterId,documentVersionId:versionId,nodeId:"n1",textHash:nodeHash}]}};
  const calls:string[]=[],state={dispatched:options.dispatched??false,completed:false,review:false,released:false,postCount:0,receiptReads:0};
  const sb={async rpc(name:string,args:Record<string,unknown>){calls.push(name);
    if(name==="claim_quoted_metadata_job")return {data:[job],error:null};
    if(name==="claim_funded_dispatch"){if(options.dispatchWaitMs)await new Promise(resolve=>setTimeout(resolve,options.dispatchWaitMs));state.dispatched=true;return {data:true,error:null};}
    if(name==="settle_funded_usage_quote"){funded.settlement_json=args.p_settlement;funded.status=(args.p_settlement as any).status==="settle"?"settled":"requires_review";return {data:funded,error:null};}
    if(name==="complete_quoted_metadata_job"){state.completed=true;funded.settlement_json=args.p_settlement;funded.status="settled";
      if(options.completionReplyThrown)throw new Error("lost completion transport reply");
      return options.completionReplyLost?{data:null,error:{code:"503"}}:{data:{id:jobId,status:"succeeded"},error:null};}
    if(name==="renew_quoted_metadata_lease")return {data:!(options.leaseLost&&(options.leaseLostWhen?.(calls)??true)),error:null};
    if(name==="mark_quoted_metadata_requires_review"){state.review=true;return {data:true,error:null};}
    if(name==="fail_quoted_metadata_before_dispatch"){state.released=true;return {data:true,error:null};}
    return {data:true,error:null};
  },from(table:string){let filters:Record<string,unknown>={};
    const builder:any={select(value:string){filters.selection=value;return this;},eq(key:string,value:unknown){filters[key]=value;return this;},in(){return this;},
      async maybeSingle(){if(table==="metadata_token_quote_requests")return {data:saved,error:null};
        if(table==="funded_usage_quotes")return {data:filters.selection==="dispatched_at"?{dispatched_at:state.dispatched?"2026-09-25T00:00:00.000Z":null}:funded,error:null};
        if(table==="ai_jobs")return {data:{id:jobId,status:state.completed?"succeeded":"running"},error:null};
        if(table==="chapters")return {data:[{id:chapterId,current_document_version_id:options.stale?"40000000-0000-4000-8000-000000000099":versionId}],error:null};
        return {data:{dispatched_at:state.dispatched?"2026-09-25T00:00:00.000Z":null},error:null};},
      then(resolve:(value:unknown)=>unknown){const data=table==="chapters"?[{id:chapterId,current_document_version_id:options.stale?"40000000-0000-4000-8000-000000000099":versionId}]:[];
        return Promise.resolve({data,error:null}).then(resolve);}};return builder;
  }} as never;
  const fetcher:typeof fetch=async(input,init)=>{const url=String(input);if(url.endsWith("/v1/ai/text/request-hash"))return Response.json({inputSha256:inputHash,model:generationRequest.model,
    maxOutputTokens:generationRequest.maxOutputTokens,agentType:generationRequest.agentType});
    if(url.endsWith("/v1/ai/jobs")){state.postCount++;if(options.leaseLost)await new Promise((resolve)=>setTimeout(resolve,15));if(options.postFailure)throw new Error("lost response");return Response.json(serviceResult);}
    if(url.endsWith(`/v1/ai/jobs/${jobId}`)){state.receiptReads++;if(options.receiptAvailable===false)return new Response("missing",{status:404});return Response.json(serviceResult);}
    throw new Error(`unexpected ${url}`);};
  return {sb,calls,state,funded,fetcher};
}

test("quoted metadata worker hashes exact saved request, dispatches once, settles measured usage and saves review draft",async()=>{
  const f=fixture();const result=await runOneQuotedMetadataJob(f.sb,{fetcher:f.fetcher});
  assert.deepEqual(result,{status:"succeeded",jobId},`calls: ${f.calls.join(",")}`);assert.equal(f.state.postCount,1);assert.equal(f.state.dispatched,true);
  assert.equal(f.state.completed,true);assert.equal(f.state.review,false);assert.equal(f.funded.status,"settled");
  assert.ok(f.calls.indexOf("claim_funded_dispatch")<f.calls.indexOf("complete_quoted_metadata_job"));
  assert.equal(f.calls.includes("settle_funded_usage_quote"),false);
});

test("dispatched metadata recovers its receipt after source edits without release or redispatch",async()=>{
  const f=fixture({stale:true,dispatched:true});
  assert.deepEqual(await runOneQuotedMetadataJob(f.sb,{fetcher:f.fetcher}),{status:"succeeded",jobId});
  assert.equal(f.state.postCount,0);assert.equal(f.state.released,false);assert.equal(f.state.receiptReads,1);
});

test("lost metadata completion reply is confirmed by authoritative job status",async()=>{
  for(const options of [{completionReplyLost:true},{completionReplyThrown:true}]){
    const f=fixture(options);
    assert.deepEqual(await runOneQuotedMetadataJob(f.sb,{fetcher:f.fetcher}),{status:"succeeded",jobId});
    assert.equal(f.state.postCount,1);assert.equal(f.funded.status,"settled");
  }
});

test("metadata lease loss prevents billing and completion after provider response",async()=>{
  const f=fixture({leaseLost:true});
  assert.deepEqual(await runOneQuotedMetadataJob(f.sb,{fetcher:f.fetcher,leaseSeconds:0.03}),{status:"completion_unknown",jobId});
  assert.equal(f.state.completed,false);assert.equal(f.funded.status,"held");assert.equal(f.state.review,false);
});

for(const boundary of ["invalid-result","missing-receipt","hash-mismatch","dispatch-marker"] as const){
  test(`metadata lease loss fences ${boundary} before any further mutation or provider dispatch`,async()=>{
    let boundaryEntered=false;
    const f=fixture({leaseLost:true,dispatchWaitMs:boundary==="dispatch-marker"?30:undefined,
      leaseLostWhen:seen=>boundary==="dispatch-marker"?seen.includes("claim_funded_dispatch"):boundaryEntered});
    let providerPosts=0;
    const outcome=await runOneQuotedMetadataJob(f.sb,{leaseSeconds:0.03,fetcher:async(url,init)=>{
      if(String(url).endsWith("request-hash")){
        if(boundary==="hash-mismatch"){boundaryEntered=true;await new Promise(resolve=>setTimeout(resolve,30));}
        return Response.json({inputSha256:boundary==="hash-mismatch"?"b".repeat(64):inputHash,
          model:generationRequest.model,maxOutputTokens:generationRequest.maxOutputTokens,agentType:"metadata"});
      }
      if(init?.method==="GET")return new Response("missing",{status:404});
      providerPosts++;boundaryEntered=true;
      if(boundary!=="dispatch-marker")await new Promise(resolve=>setTimeout(resolve,30));
      if(boundary==="missing-receipt")throw new Error("lost provider response");
      return Response.json(boundary==="invalid-result"?{...serviceResult,status:"failed"}:serviceResult);
    }});
    assert.deepEqual(outcome,{status:"completion_unknown",jobId});
    assert.equal(f.state.completed,false);assert.equal(f.state.review,false);assert.equal(f.state.released,false);
    assert.equal(f.funded.status,"held");
    assert.equal(providerPosts,boundary==="invalid-result"||boundary==="missing-receipt"?1:0);
    assert.equal(f.calls.includes("claim_funded_dispatch"),boundary!=="hash-mismatch");
  });
}

test("quoted metadata worker releases the hold when a source version changes before dispatch",async()=>{
  const f=fixture({stale:true});const result=await runOneQuotedMetadataJob(f.sb,{fetcher:f.fetcher});
  assert.equal(result.status,"requires_review");assert.equal(f.state.released,true);assert.equal(f.state.postCount,0);assert.equal(f.state.dispatched,false);
});

test("uncertain quoted metadata dispatch reads only an existing receipt and retains the full hold when absent",async()=>{
  const f=fixture({postFailure:true,receiptAvailable:false});const result=await runOneQuotedMetadataJob(f.sb,{fetcher:f.fetcher});
  assert.equal(result.status,"requires_review");assert.equal(f.state.postCount,1);assert.equal(f.state.review,true);
  assert.equal(f.state.completed,false);assert.equal(f.funded.status,"held");
});
