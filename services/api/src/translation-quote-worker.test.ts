import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runOneTranslationQuoteStep } from "./lib/translation-quote-worker.js";

const id=(n:number)=>`db000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
const now="2026-09-19T12:00:00.000Z";
function fixture(lostResponse=false,changedSource=false) {
  const catalog={version:"test",approved:true,approvalReference:"synthetic",effectiveAt:"2026-09-19T00:00:00.000Z",expiresAt:"2026-09-20T00:00:00.000Z",quoteLifetimeSeconds:600,
    entries:[{id:"test",label:"Test",maxInputTokens:1000,maxOutputTokens:2000,
      price:{version:"p",provider:"openai",model:"test-2026-09-01",rates:[{dimension:"text_input",microUsdPerMillionTokens:"1000000"},{dimension:"text_cached_input",microUsdPerMillionTokens:"100000"},{dimension:"text_output",microUsdPerMillionTokens:"2000000"}]},
      policy:{version:"r",approved:true,microUsdPerCredit:"1000",markupBasisPoints:15000,platformMicroUsd:"100",minimumCredits:"1"}}]};
  const request={id:id(1),user_id:id(2),workspace_id:id(3),source_language:"en",target_language:"es",model_id:"test",catalog_json:catalog,lease_token:id(4),
    chapters_json:[{jobId:id(5),chapterId:id(6),documentVersionId:id(7),chapterOrder:0,sourceSha256:createHash("sha256").update("Source").digest("hex")}],counts_json:{} as Record<string,unknown>};
  let status="queued",proposals=0;
  const calls:string[]=[];
  const sb={rpc:async(name:string,args:Record<string,any>={})=>{
    calls.push(name);
    if(name==="claim_translation_quote_request") { if(status!=="queued") return {data:[],error:null}; status="running"; return {data:[structuredClone(request)],error:null}; }
    if(name==="record_translation_quote_count") { request.counts_json[args.p_job_id]=args.p_count; status="queued"; return lostResponse?{data:null,error:{code:"unknown"}}:{data:true,error:null}; }
    if(name==="fail_translation_quote_request") { if(status==="running") status="failed"; return {data:true,error:null}; }
    if(name==="complete_translation_quote_request") {
      assert.equal(args.p_chapters[0].quote.scope.jobId,id(5)); assert.equal(args.p_chapters[0].quote.price.model,"test-2026-09-01");
      proposals++; status="ready"; return {data:id(1),error:null};
    }
    throw new Error(`unexpected ${name}`);
  },from:(table:string)=>{
    assert.equal(table,"document_versions"); const builder:any={select:()=>builder,eq:()=>builder,
      maybeSingle:async()=>({data:{plain_text:changedSource?"Changed":"Source"},error:null})}; return builder;
  }};
  return {sb:sb as never,calls,status:()=>status,proposals:()=>proposals};
}
test("counting worker checkpoints one chapter then publishes without another provider call",async()=>{
  for(const lost of [false,true]) {
    const fake=fixture(lost); let counts=0;
    const options={clock:()=>now,counter:async()=>{counts++;return {object:"response.input_tokens",input_tokens:42};}};
    assert.equal((await runOneTranslationQuoteStep(fake.sb,options)).status,lost?"completion_unknown":"counted");
    assert.equal((await runOneTranslationQuoteStep(fake.sb,options)).status,"ready");
    assert.equal((await runOneTranslationQuoteStep(fake.sb,options)).status,"idle");
    assert.equal(counts,1); assert.equal(fake.proposals(),1);
    assert.equal(fake.calls.some((name)=>name.includes("funded")||name.includes("accept")),false);
  }
});
test("changed source and failed counter stop proposal preparation without generation",async()=>{
  const changed=fixture(false,true); let counts=0;
  await runOneTranslationQuoteStep(changed.sb,{clock:()=>now,counter:async()=>{counts++;return {};}});
  assert.equal(counts,0); assert.equal(changed.status(),"failed"); assert.equal(changed.proposals(),0);
  const failed=fixture();
  await runOneTranslationQuoteStep(failed.sb,{clock:()=>now,counter:async()=>{counts++;throw new Error("private");}});
  assert.equal(counts,1); assert.equal(failed.status(),"failed"); assert.equal(failed.proposals(),0);
});
