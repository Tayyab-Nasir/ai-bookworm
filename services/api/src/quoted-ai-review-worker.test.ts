import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteUsage } from "./lib/usage-pricing.js";
import { runOneQuotedAiReviewJob } from "./lib/quoted-ai-review-worker.js";

const USER = "a1000000-0000-4000-8000-000000000001";
const WORKSPACE = "a1000000-0000-4000-8000-000000000002";
const BOOK = "a1000000-0000-4000-8000-000000000003";
const CHAPTER = "a1000000-0000-4000-8000-000000000004";
const VERSION = "a1000000-0000-4000-8000-000000000005";
const JOB = "a1000000-0000-4000-8000-000000000006";
const QUOTE_REQUEST = "a1000000-0000-4000-8000-000000000007";
const LEASE = "a1000000-0000-4000-8000-000000000008";
const HASH = "a".repeat(64);
const MODEL = "gpt-6-astra-2026-09-01";
type Row = Record<string, any>;

function fixture(options:{completionReplyLost?:boolean;completionReplyThrown?:boolean;renewLeaseLost?:boolean;dispatchWaitMs?:number;
  renewLeaseLostWhen?:(calls:{name:string}[])=>boolean}={}) {
  const createdAt = new Date(Date.now() - 1_000).toISOString();
  const quote = quoteUsage({ scope: { jobId: JOB, userId: USER, workspaceId: WORKSPACE, inputSha256: HASH },
    price: { version: "price-v1", provider: "openai", model: MODEL, rates: [
      { dimension: "text_input", microUsdPerMillionTokens: "1000000" },
      { dimension: "text_cached_input", microUsdPerMillionTokens: "100000" },
      { dimension: "text_output", microUsdPerMillionTokens: "2000000" }] },
    policy: { version: "policy-v1", approved: true, microUsdPerCredit: "1000", markupBasisPoints: 15000,
      platformMicroUsd: "100", minimumCredits: "1" },
    maximumTokens: [{ dimension: "text_input", tokens: "420" }, { dimension: "text_cached_input", tokens: "420" },
      { dimension: "text_output", tokens: "1200" }], createdAt, expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const contextPolicy = { includeBookBible: true, includeStyleGuide: true, includeRelatedContext: false, semanticTopK: 5, maxTokens: 4096 };
  const userInstruction = "Review the saved passage.";
  const sourceVersions = [{ chapterId: CHAPTER, version: 3, documentVersionId: VERSION }];
  const request = { jobId: JOB, workspaceId: WORKSPACE, bookId: BOOK, agentType: "proofreader", model: MODEL,
    maxOutputTokens: 1200, contextPolicy, input: { chapterIds: [CHAPTER], userInstruction,
      chapters: { [CHAPTER]: { id:CHAPTER,title:"The Map",version:3,
        nodes:[{id:"node-1",type:"paragraph",text:"Mira found a map below the theatre."}] } } } };
  const tables: Record<string, Row[]> = {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "A Quiet Map", author_name: "Mira Vale", language: "en" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, current_document_version_id: VERSION, title: "The Map", order_index: 0 }],
    document_versions: [{ id: VERSION, chapter_id: CHAPTER, version_number: 3,
      content_json: { nodes: [{ id: "node-1", type: "paragraph", text: "Mira found a map below the theatre." }] } }],
    style_guides: [], book_bible_items: [],
    ai_review_token_quote_requests: [{ id: QUOTE_REQUEST, user_id: USER, workspace_id: WORKSPACE, book_id: BOOK,
      generation_job_id: JOB, generation_request_json: request, catalog_json: {}, source_versions_json: sourceVersions,
      status: "ready", request_sha256: HASH, counted_input_tokens: 420, usage_quote_json: quote, accepted_job_id: JOB }],
    funded_usage_quotes: [{ job_id: JOB, user_id: USER, workspace_id: WORKSPACE, quote_json: quote,
      reserved_credits: Number(quote.reservedCredits), status: "held", settlement_json: null, dispatched_at: null }],
  };
  const job = { id: JOB, workspace_id: WORKSPACE, book_id: BOOK, created_by: USER, agent_type: "proofreader",
    billing_mode: "quoted", model: MODEL, lease_token: LEASE,
    input_ref: { aiReviewQuoteRequestId: QUOTE_REQUEST, generationRequestSha256: HASH,
      chapterVersions: sourceVersions, userInstruction, contextPolicy, maxOutputTokens: 1200 } };
  const calls: { name: string; args: Row }[] = [];
  const sb = {
    from(table: string) {
      const filters: [string, unknown][] = []; let sort = ""; let ascending = true; let limit = Number.POSITIVE_INFINITY;
      const rows = tables[table] ?? [];
      const foundRows = () => { let found = rows.filter((item) => filters.every(([key, value]) => item[key] === value));
        if (sort) found = [...found].sort((a, b) => String(a[sort]).localeCompare(String(b[sort])) * (ascending ? 1 : -1));
        return found.slice(0, limit); };
      const builder: any = {
        select() { return this; }, eq(key: string, value: unknown) { filters.push([key, value]); return this; },
        order(key: string, options?: { ascending?: boolean }) { sort = key; ascending = options?.ascending ?? true; return this; },
        limit(value: number) { limit = value; return this; },
        async maybeSingle() { return { data: foundRows()[0] ?? null, error: null }; },
        then(resolve: (value: unknown) => unknown) { return Promise.resolve({ data: foundRows(), error: null }).then(resolve); },
      };
      return builder;
    },
    async rpc(name: string, args: Row) {
      calls.push({ name, args });
      if (name === "claim_quoted_ai_review_job") return { data: [job], error: null };
      if (name === "renew_quoted_ai_review_lease") return { data: !(options.renewLeaseLost&&(options.renewLeaseLostWhen?.(calls)??true)), error: null };
      if (name === "claim_funded_dispatch") {
        if(options.dispatchWaitMs)await new Promise(resolve=>setTimeout(resolve,options.dispatchWaitMs));
        tables.funded_usage_quotes![0]!.dispatched_at = new Date().toISOString(); return { data: true, error: null };
      }
      if (name === "complete_quoted_ai_review_job") {
        tables.ai_jobs=[{...job,status:"succeeded"}];
        if(options.completionReplyThrown)throw new Error("lost completion transport reply");
        return options.completionReplyLost?{data:null,error:{code:"503"}}:{ data: { ...job, status: "succeeded" }, error: null };
      }
      if (name === "hold_quoted_ai_review_for_review") {
        tables.funded_usage_quotes![0]!.status = "requires_review"; return { data: true, error: null };
      }
      if (name === "release_quoted_ai_review_before_dispatch") return { data: true, error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
  } as never;
  return { sb, calls, tables, quote };
}

function result() {
  return { jobId: JOB, workspaceId: WORKSPACE, bookId: BOOK, agentType: "proofreader", status: "succeeded",
    provider: "openai", model: MODEL, requestId: "req-ai-review-123", suggestions: [], diagnostics: [],
    usage: { inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0.001,
      measuredTokens: [{ dimension: "text_input", tokens: "6" }, { dimension: "text_cached_input", tokens: "2" },
        { dimension: "text_output", tokens: "3" }] } };
}
const hashResult=()=>({inputSha256:HASH,model:MODEL,maxOutputTokens:1200,agentType:"proofreader"});

test("funded AI review verifies exact request hash, dispatches once, and atomically settles measured usage", async (t) => {
  const previousToken = process.env.AI_SERVICE_TOKEN; process.env.AI_SERVICE_TOKEN = "test-service-token";
  t.after(() => previousToken === undefined ? delete process.env.AI_SERVICE_TOKEN : process.env.AI_SERVICE_TOKEN = previousToken);
  const { sb, calls, quote } = fixture(); const requests: Row[] = [];
  const outcome = await runOneQuotedAiReviewJob(sb, { fetcher: async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Row;
    if (String(url).endsWith("/v1/ai/text/request-hash")) {
      requests.push(body); return Response.json(hashResult());
    }
    requests.push(body); return Response.json(result());
  } });
  assert.deepEqual(outcome, { status: "succeeded", jobId: JOB });
  assert.equal(requests.length, 2); assert.equal(requests[1]?.expectedInputSha256, HASH);
  assert.equal(requests[1]?.idempotencyKey, `quoted-ai-review:${JOB}`);
  assert.ok(JSON.stringify(requests[0]).includes("Mira found a map below the theatre."));
  const dispatchIndex = calls.findIndex((call) => call.name === "claim_funded_dispatch");
  const completeIndex = calls.findIndex((call) => call.name === "complete_quoted_ai_review_job");
  assert.ok(dispatchIndex >= 0 && dispatchIndex < completeIndex);
  assert.equal((calls[completeIndex]?.args.p_settlement as Row).status, "settle");
  assert.equal((calls[completeIndex]?.args.p_settlement as Row).releaseCredits > 0, true);
  assert.equal(calls[completeIndex]?.args.p_settlement.fingerprint, quote.fingerprint);
});

test("quoted AI review dispatch uses saved text/context despite later current context changes",async()=>{
  const {sb,tables}=fixture();
  tables.document_versions=[];tables.style_guides=[{rules_json:{tone:"changed private style"}}];tables.book_bible_items=[{name:"new private canon"}];
  const bodies:Row[]=[];
  const outcome=await runOneQuotedAiReviewJob(sb,{fetcher:async(url,init)=>{
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json(String(url).endsWith("request-hash")?hashResult():result());
  }});
  assert.deepEqual(outcome,{status:"succeeded",jobId:JOB});
  assert.ok(JSON.stringify(bodies).includes("Mira found a map below the theatre."));
  assert.equal(JSON.stringify(bodies).includes("changed private style"),false);
  assert.equal(JSON.stringify(bodies).includes("new private canon"),false);
});

test("quoted AI review recovers prior dispatch from saved context without dynamic context dependencies",async()=>{
  const {sb,tables,calls}=fixture();tables.funded_usage_quotes![0]!.dispatched_at=new Date().toISOString();
  tables.document_versions=[];tables.style_guides=[];tables.book_bible_items=[];
  let reads=0;
  assert.deepEqual(await runOneQuotedAiReviewJob(sb,{fetcher:async(_url,init)=>{
    assert.equal(init?.method,"GET");reads++;return Response.json(result());
  }}),{status:"succeeded",jobId:JOB});
  assert.equal(reads,1);assert.equal(calls.some(c=>c.name==="claim_funded_dispatch"),false);
});

test("lost quoted AI review completion reply is confirmed by authoritative job status",async()=>{
  for(const options of [{completionReplyLost:true},{completionReplyThrown:true}]){
    const {sb}=fixture(options);
    assert.deepEqual(await runOneQuotedAiReviewJob(sb,{fetcher:async(url)=>Response.json(String(url).endsWith("request-hash")
      ?hashResult():result())}),{status:"succeeded",jobId:JOB});
  }
});

test("quoted AI review rejects inconsistent measured aggregates without settling",async()=>{
  const {sb,calls}=fixture();const malformed=result();malformed.usage.inputTokens=9;
  assert.deepEqual(await runOneQuotedAiReviewJob(sb,{fetcher:async(url)=>Response.json(String(url).endsWith("request-hash")
    ?hashResult():malformed)}),{status:"requires_review",jobId:JOB});
  assert.equal(calls.some(c=>c.name==="complete_quoted_ai_review_job"),false);
});

test("quoted AI review normalizes a saved edit against the consented chapter version",async()=>{
  const {sb,calls}=fixture();
  const edited={...result(),suggestions:[{chapterId:CHAPTER,nodeId:"node-1",rationale:"  Clearer opening.\n",
    operation:{operationId:"provider-operation",type:"replace_text",expectedVersion:99,
      target:{chapterId:CHAPTER,nodeId:"node-1",ignoredBySchema:true},
      payload:{nodeId:"node-1",from:0,to:4,text:"Mina"}}}]};
  assert.deepEqual(await runOneQuotedAiReviewJob(sb,{fetcher:async(url)=>Response.json(String(url).endsWith("request-hash")
    ?hashResult():edited)}),{status:"succeeded",jobId:JOB});
  const completion=calls.find(c=>c.name==="complete_quoted_ai_review_job")!;
  const suggestion=completion.args.p_suggestions[0];
  assert.equal(suggestion.rationale,"Clearer opening.");assert.equal(suggestion.confidence,null);
  assert.equal(suggestion.operation.expectedVersion,3);assert.equal(suggestion.operation.source,"ai");
  assert.equal(suggestion.operation.sourceRef,suggestion.id);assert.equal(suggestion.operation.operationId,`ai:${suggestion.id}`);
  assert.deepEqual(suggestion.operation.target,{chapterId:CHAPTER,nodeId:"node-1"});
  assert.deepEqual(suggestion.operation.payload,edited.suggestions[0]!.operation.payload);
});

test("quoted AI review lease loss prevents settlement or review mutations after provider response",async()=>{
  const {sb,calls}=fixture({renewLeaseLost:true});
  assert.deepEqual(await runOneQuotedAiReviewJob(sb,{leaseSeconds:0.03,fetcher:async(url)=>{
    if(String(url).endsWith("request-hash"))return Response.json(hashResult());
    await new Promise(resolve=>setTimeout(resolve,30));return Response.json(result());
  }}),{status:"completion_unknown",jobId:JOB});
  assert.equal(calls.some(c=>c.name==="complete_quoted_ai_review_job"),false);
  assert.equal(calls.some(c=>c.name==="hold_quoted_ai_review_for_review"),false);
});

for(const boundary of ["invalid-result","missing-receipt","hash-mismatch","dispatch-marker"] as const){
  test(`quoted AI review lease loss fences ${boundary} before any further mutation or provider dispatch`,async()=>{
    let boundaryEntered=false;
    const {sb,calls}=fixture({renewLeaseLost:true,dispatchWaitMs:boundary==="dispatch-marker"?30:undefined,
      renewLeaseLostWhen:seen=>boundary==="dispatch-marker"?seen.some(call=>call.name==="claim_funded_dispatch"):boundaryEntered});
    let providerPosts=0;
    const outcome=await runOneQuotedAiReviewJob(sb,{leaseSeconds:0.03,fetcher:async(url,init)=>{
      if(String(url).endsWith("request-hash")){
        if(boundary==="hash-mismatch"){boundaryEntered=true;await new Promise(resolve=>setTimeout(resolve,30));}
        return Response.json({...hashResult(),inputSha256:boundary==="hash-mismatch"?"b".repeat(64):HASH});
      }
      if(init?.method==="GET")return new Response("missing",{status:404});
      providerPosts++;boundaryEntered=true;
      if(boundary!=="dispatch-marker")await new Promise(resolve=>setTimeout(resolve,30));
      if(boundary==="missing-receipt")throw new Error("lost provider response");
      return Response.json(boundary==="invalid-result"?{...result(),status:"failed"}:result());
    }});
    assert.deepEqual(outcome,{status:"completion_unknown",jobId:JOB});
    assert.equal(calls.some(c=>c.name==="complete_quoted_ai_review_job"),false);
    assert.equal(calls.some(c=>c.name==="hold_quoted_ai_review_for_review"),false);
    assert.equal(calls.some(c=>c.name==="release_quoted_ai_review_before_dispatch"),false);
    assert.equal(providerPosts,boundary==="invalid-result"||boundary==="missing-receipt"?1:0);
    assert.equal(calls.some(c=>c.name==="claim_funded_dispatch"),boundary!=="hash-mismatch");
  });
}

test("funded AI review holds an uncertain post-dispatch outcome and never sends a second request", async (t) => {
  const previousToken = process.env.AI_SERVICE_TOKEN; process.env.AI_SERVICE_TOKEN = "test-service-token";
  t.after(() => previousToken === undefined ? delete process.env.AI_SERVICE_TOKEN : process.env.AI_SERVICE_TOKEN = previousToken);
  const { sb, calls } = fixture(); let postCalls = 0; let receiptReads = 0;
  const outcome = await runOneQuotedAiReviewJob(sb, { fetcher: async (url, init) => {
    if (String(url).endsWith("/v1/ai/text/request-hash")) return Response.json(hashResult());
    if (init?.method === "GET") { receiptReads++; return new Response("not found", { status: 404 }); }
    postCalls++; throw new Error("lost provider response");
  } });
  assert.deepEqual(outcome, { status: "requires_review", jobId: JOB });
  assert.equal(postCalls, 1); assert.equal(receiptReads, 1);
  assert.equal(calls.filter((call) => call.name === "claim_funded_dispatch").length, 1);
  assert.equal(calls.filter((call) => call.name === "hold_quoted_ai_review_for_review").length, 1);
  assert.equal(calls.some((call) => call.name === "complete_quoted_ai_review_job"), false);
});
