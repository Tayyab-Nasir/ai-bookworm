import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteUsage } from "./lib/usage-pricing.js";
import { runOneQuotedBookBibleJob } from "./lib/quoted-book-bible-worker.js";

const USER = "b1000000-0000-4000-8000-000000000001";
const WORKSPACE = "b1000000-0000-4000-8000-000000000002";
const BOOK = "b1000000-0000-4000-8000-000000000003";
const CHAPTER = "b1000000-0000-4000-8000-000000000004";
const VERSION = "b1000000-0000-4000-8000-000000000005";
const JOB = "b1000000-0000-4000-8000-000000000006";
const QUOTE_REQUEST = "b1000000-0000-4000-8000-000000000007";
const LEASE = "b1000000-0000-4000-8000-000000000008";
const HASH = "b".repeat(64);
const MODEL = "gpt-6-astra-2026-09-01";
type Row = Record<string, any>;

function fixture(options:{leaseLost?:boolean;dispatchWaitMs?:number;leaseLostWhen?:(calls:{name:string}[])=>boolean;
  completionReplyLost?:boolean;completionReplyThrown?:boolean;completionReadbackOverride?:Row;completionFundingOverride?:Row;
  completionWaitMs?:number}={}) {
  const evidence = { chapterId: CHAPTER, documentVersionId: VERSION, nodeId: "node-1", textHash: HASH };
  const generationRequest = { jobId: JOB, workspaceId: WORKSPACE, bookId: BOOK, agentType: "bookbible", model: MODEL,
    maxOutputTokens: 100, contextPolicy: { includeBookBible: true, includeRelatedContext: false, semanticTopK: 0, maxTokens: 4096 },
    input: { chapterIds: [CHAPTER], chapters: { [CHAPTER]: { documentVersionId: VERSION, version: 1,
      nodes: [{ id: "node-1", text: "A saved passage.", textHash: HASH }] } },
      userInstruction: "Extract only cited facts." } };
  const sourceVersions = { versions: [{ chapterId: CHAPTER, documentVersionId: VERSION, version: 1 }],
    reading: { fingerprint: HASH, pageIndex: 0 } };
  const quote = quoteUsage({ scope: { jobId: JOB, userId: USER, workspaceId: WORKSPACE, inputSha256: HASH },
    price: { version: "price-v1", provider: "openai", model: MODEL, rates: [
      { dimension: "text_input", microUsdPerMillionTokens: "1000000" },
      { dimension: "text_cached_input", microUsdPerMillionTokens: "100000" },
      { dimension: "text_output", microUsdPerMillionTokens: "2000000" }] },
    policy: { version: "policy-v1", approved: true, microUsdPerCredit: "1000", markupBasisPoints: 15000,
      platformMicroUsd: "100", minimumCredits: "1" },
    maximumTokens: [{ dimension: "text_input", tokens: "10" }, { dimension: "text_cached_input", tokens: "10" },
      { dimension: "text_output", tokens: "100" }], createdAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 600_000).toISOString() });
  const requestRow = { id: QUOTE_REQUEST, user_id: USER, workspace_id: WORKSPACE, book_id: BOOK,
    generation_job_id: JOB, generation_request_json: generationRequest, source_versions_json: sourceVersions,
    source_sha256: HASH, generation_request_sha256: HASH, usage_quote_json: quote, status: "ready", accepted_job_id: JOB };
  const job = { id: JOB, workspace_id: WORKSPACE, book_id: BOOK, created_by: USER, agent_type: "bookbible",
    billing_mode: "quoted", lease_token: LEASE, model: MODEL,
    input_ref: { bookBibleQuoteRequestId: QUOTE_REQUEST, sourceSha256: HASH, generationRequestSha256: HASH,
      chapterVersions: sourceVersions.versions, contextSources: [evidence], reading: sourceVersions.reading, generationRequest } };
  const tables: Record<string, Row[]> = { book_bible_token_quote_requests: [requestRow],
    funded_usage_quotes: [{ job_id: JOB, user_id: USER, workspace_id: WORKSPACE, quote_json: quote,
      reserved_credits: Number(quote.reservedCredits), status: "held", settlement_json: null, dispatched_at: null }] };
  const calls: { name: string; args: Row }[] = [];
  const sb = {
    from(table: string) {
      const filters: [string, unknown][] = [];
      const rows = tables[table] ?? [];
      const found = () => rows.filter((row) => filters.every(([key, value]) => row[key] === value));
      const query: any = { select() { return this; }, eq(key: string, value: unknown) { filters.push([key, value]); return this; },
        async maybeSingle() { return { data: found()[0] ?? null, error: null }; } };
      return query;
    },
    async rpc(name: string, args: Row) {
      calls.push({ name, args });
      if (name === "claim_quoted_book_bible_job") return { data: [job], error: null };
      if (name === "renew_quoted_book_bible_lease") return { data: !(options.leaseLost&&(options.leaseLostWhen?.(calls)??true)), error: null };
      if (name === "claim_funded_dispatch") {
        if(options.dispatchWaitMs)await new Promise(resolve=>setTimeout(resolve,options.dispatchWaitMs));
        tables.funded_usage_quotes![0]!.dispatched_at = new Date().toISOString(); return { data: true, error: null };
      }
      if (name === "complete_quoted_book_bible_job") {
        tables.ai_jobs=[{...job,status:"succeeded",...options.completionReadbackOverride}];
        tables.funded_usage_quotes![0]!.status="settled";tables.funded_usage_quotes![0]!.settlement_json=args.p_settlement;
        Object.assign(tables.funded_usage_quotes![0]!,options.completionFundingOverride);
        if(options.completionWaitMs)await new Promise(resolve=>setTimeout(resolve,options.completionWaitMs));
        if(options.completionReplyThrown)throw new Error("lost completion transport reply");
        return options.completionReplyLost?{data:null,error:{code:"503"}}:{data:{...job,status:"succeeded"},error:null};
      }
      if (name === "hold_quoted_book_bible_for_review") return { data: true, error: null };
      if (name === "release_quoted_book_bible_before_dispatch") return { data: true, error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
  } as never;
  const result = (measured: boolean) => ({ jobId: JOB, workspaceId: WORKSPACE, bookId: BOOK,
    agentType: "bookbible", status: "succeeded", provider: "openai", model: MODEL,
    requestId: "req-book-bible-123", suggestions: [], diagnostics: [], usage: { inputTokens: 6, outputTokens: 10,
      estimatedCostUsd: 0.001, ...(measured ? { measuredTokens: [
        { dimension: "text_input", tokens: "5" }, { dimension: "text_cached_input", tokens: "1" },
        { dimension: "text_output", tokens: "10" }] } : {}) } });
  const fetcher: typeof fetch = async (url) => String(url).endsWith("/v1/ai/text/request-hash")
    ? Response.json({ inputSha256: HASH, model: MODEL, maxOutputTokens: 100, agentType: "bookbible" })
    : Response.json(result(true));
  return { sb, calls, fetcher, result, tables, job, quote };
}

test("Book Bible accepts chapter maps reordered by PostgreSQL JSONB", async () => {
  const { sb, calls, fetcher, job } = fixture();
  const laterChapter = "b1000000-0000-4000-8000-000000000009";
  const generation = job.input_ref.generationRequest;
  generation.input.chapterIds = [laterChapter, CHAPTER];
  Object.assign(generation.input.chapters, { [laterChapter]: { ...generation.input.chapters[CHAPTER] } });
  job.input_ref.chapterVersions.push({ chapterId: laterChapter, documentVersionId: VERSION, version: 1 });
  assert.deepEqual(await runOneQuotedBookBibleJob(sb, { fetcher }), { status: "succeeded", jobId: JOB });
  assert.equal(calls.filter((call) => call.name === "claim_funded_dispatch").length, 1);
});

test("Book Bible refuses duplicate chapter IDs before provider dispatch", async () => {
  const { sb, calls, job } = fixture();
  job.input_ref.generationRequest.input.chapterIds = [CHAPTER, CHAPTER];
  let requests = 0;
  assert.deepEqual(await runOneQuotedBookBibleJob(sb, { fetcher: async () => {
    requests++; throw new Error("invalid snapshot must not reach provider");
  } }), { status: "completion_unknown", jobId: JOB });
  assert.equal(requests, 0);
  assert.equal(calls.some((call) => call.name === "claim_funded_dispatch"), false);
});

test("Book Bible recovers an already dispatched job from its receipt without generating again", async () => {
  const { sb, calls, tables, result } = fixture();
  tables.funded_usage_quotes![0]!.dispatched_at = new Date().toISOString();
  const requests: { url: string; method: string }[] = [];
  const outcome = await runOneQuotedBookBibleJob(sb, { fetcher: async (url, init) => {
    requests.push({ url: String(url), method: init?.method ?? "GET" });
    return Response.json(result(true));
  } });
  assert.deepEqual(outcome, { status: "succeeded", jobId: JOB });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.ok(requests[0]?.url.includes(JOB));
  assert.equal(calls.some((call) => call.name === "claim_funded_dispatch"), false);
  assert.equal(calls.filter((call) => call.name === "complete_quoted_book_bible_job").length, 1);
});

test("Book Bible holds a missing dispatched receipt without retrying generation or refunding", async () => {
  const { sb, calls, tables } = fixture();
  tables.funded_usage_quotes![0]!.dispatched_at = new Date().toISOString();
  const methods: string[] = [];
  const outcome = await runOneQuotedBookBibleJob(sb, { fetcher: async (_url, init) => {
    methods.push(init?.method ?? "GET");
    return new Response("unavailable", { status: 503 });
  } });
  assert.deepEqual(outcome, { status: "requires_review", jobId: JOB });
  assert.deepEqual(methods, ["GET"]);
  assert.equal(calls.some((call) => ["claim_funded_dispatch", "complete_quoted_book_bible_job",
    "release_quoted_book_bible_before_dispatch"].includes(call.name)), false);
  assert.equal(calls.find((call) => call.name === "hold_quoted_book_bible_for_review")?.args.p_reason, "provider_outcome_unknown");
});

test("funded Book Bible worker verifies pins and atomically completes only measured usage", async () => {
  const { sb, calls, fetcher } = fixture();
  const outcome = await runOneQuotedBookBibleJob(sb, { fetcher });
  assert.deepEqual(outcome, { status: "succeeded", jobId: JOB });
  const dispatched = calls.findIndex((call) => call.name === "claim_funded_dispatch");
  const completed = calls.findIndex((call) => call.name === "complete_quoted_book_bible_job");
  assert.ok(dispatched >= 0 && dispatched < completed);
  assert.equal((calls[completed]?.args.p_settlement as Row).status, "settle");
  assert.equal((calls[completed]?.args.p_usage as Row).measuredTokens.length, 3);
});

test("funded Book Bible worker holds a provider receipt without measured tokens for review", async () => {
  const { sb, calls, result } = fixture();
  const fetcher: typeof fetch = async (url) => String(url).endsWith("/v1/ai/text/request-hash")
    ? Response.json({ inputSha256: HASH, model: MODEL, maxOutputTokens: 100, agentType: "bookbible" })
    : Response.json(result(false));
  const outcome = await runOneQuotedBookBibleJob(sb, { fetcher });
  assert.deepEqual(outcome, { status: "requires_review", jobId: JOB });
  assert.equal(calls.some((call) => call.name === "complete_quoted_book_bible_job"), false);
  assert.equal(calls.find((call) => call.name === "hold_quoted_book_bible_for_review")?.args.p_reason, "usage_unreconciled");
});

for(const boundary of ["invalid-result","missing-receipt","hash-mismatch","dispatch-marker","valid-result"] as const){
  test(`Book Bible lease loss fences ${boundary} before any further mutation or provider dispatch`,async()=>{
    let boundaryEntered=false;
    const {sb,calls,result}=fixture({leaseLost:true,dispatchWaitMs:boundary==="dispatch-marker"?30:undefined,
      leaseLostWhen:seen=>boundary==="dispatch-marker"?seen.some(call=>call.name==="claim_funded_dispatch"):boundaryEntered});
    let providerPosts=0;
    const outcome=await runOneQuotedBookBibleJob(sb,{leaseSeconds:0.03,fetcher:async(url,init)=>{
      if(String(url).endsWith("request-hash")){
        if(boundary==="hash-mismatch"){boundaryEntered=true;await new Promise(resolve=>setTimeout(resolve,30));}
        return Response.json({inputSha256:boundary==="hash-mismatch"?"c".repeat(64):HASH,
          model:MODEL,maxOutputTokens:100,agentType:"bookbible"});
      }
      if(init?.method==="GET")return new Response("missing",{status:404});
      providerPosts++;boundaryEntered=true;
      if(boundary!=="dispatch-marker")await new Promise(resolve=>setTimeout(resolve,30));
      if(boundary==="missing-receipt")throw new Error("lost provider response");
      return Response.json(boundary==="invalid-result"?{...result(true),status:"failed"}:result(true));
    }});
    assert.deepEqual(outcome,{status:"completion_unknown",jobId:JOB});
    assert.equal(calls.some(call=>call.name==="complete_quoted_book_bible_job"),false);
    assert.equal(calls.some(call=>call.name==="hold_quoted_book_bible_for_review"),false);
    assert.equal(calls.some(call=>call.name==="release_quoted_book_bible_before_dispatch"),false);
    assert.equal(providerPosts,boundary==="invalid-result"||boundary==="missing-receipt"||boundary==="valid-result"?1:0);
    assert.equal(calls.some(call=>call.name==="claim_funded_dispatch"),boundary!=="hash-mismatch");
  });
}

test("Book Bible confirms lost completion replies through exact scoped authoritative job state",async()=>{
  for(const options of [{completionReplyLost:true},{completionReplyThrown:true},
    {completionReplyLost:true,completionWaitMs:30,leaseLost:true,
      leaseLostWhen:(seen:{name:string}[])=>seen.some(call=>call.name==="complete_quoted_book_bible_job")}]){
    const {sb,calls,result}=fixture(options);let providerPosts=0;let receiptReads=0;
    assert.deepEqual(await runOneQuotedBookBibleJob(sb,{leaseSeconds:0.03,fetcher:async(url,init)=>{
      if(String(url).endsWith("request-hash"))return Response.json({inputSha256:HASH,model:MODEL,maxOutputTokens:100,agentType:"bookbible"});
      if(init?.method==="GET")receiptReads++;else providerPosts++;
      return Response.json(result(true));
    }}),{status:"succeeded",jobId:JOB});
    assert.equal(providerPosts,1);assert.equal(receiptReads,0);
    assert.equal(calls.filter(call=>call.name==="complete_quoted_book_bible_job").length,1);
    assert.equal(calls.some(call=>["hold_quoted_book_bible_for_review","release_quoted_book_bible_before_dispatch"].includes(call.name)),false);
  }
});

test("Book Bible never promotes foreign, unpinned or unfinished completion readback",async()=>{
  for(const completionReadbackOverride of [{id:CHAPTER},{workspace_id:CHAPTER},{book_id:CHAPTER},{created_by:CHAPTER},
    {agent_type:"proofreader"},{billing_mode:"operational"},{model:"other-model"},{status:"running"}]){
    const {sb,calls,fetcher}=fixture({completionReplyLost:true,completionReadbackOverride});
    assert.deepEqual(await runOneQuotedBookBibleJob(sb,{fetcher}),{status:"completion_unknown",jobId:JOB});
    assert.equal(calls.filter(call=>call.name==="complete_quoted_book_bible_job").length,1);
    assert.equal(calls.some(call=>["hold_quoted_book_bible_for_review","release_quoted_book_bible_before_dispatch"].includes(call.name)),false);
  }
});

test("Book Bible completion readback requires settled funding with exact provider, owner and request pins",async()=>{
  const {quote}=fixture();
  const changedScope=(scope:Partial<typeof quote.scope>)=>quoteUsage({...quote,scope:{...quote.scope,...scope}});
  for(const completionFundingOverride of [{status:"held",settlement_json:null},
    {quote_json:quoteUsage({...quote,price:{...quote.price,model:"other-model"}})},
    {user_id:CHAPTER,quote_json:changedScope({userId:CHAPTER})},
    {workspace_id:CHAPTER,quote_json:changedScope({workspaceId:CHAPTER})},
    {quote_json:changedScope({inputSha256:"c".repeat(64)})},
    {quote_json:{...quote,price:{...quote.price,provider:"mock"}}}]){
    const {sb,calls,fetcher}=fixture({completionReplyLost:true,completionFundingOverride});
    assert.deepEqual(await runOneQuotedBookBibleJob(sb,{fetcher}),{status:"completion_unknown",jobId:JOB});
    assert.equal(calls.filter(call=>call.name==="complete_quoted_book_bible_job").length,1);
    assert.equal(calls.some(call=>["hold_quoted_book_bible_for_review","release_quoted_book_bible_before_dispatch"].includes(call.name)),false);
  }
});

test("Book Bible candidates preserve the Python trimmed raw receipt contract and exact citations",async()=>{
  const evidence={chapterId:CHAPTER,documentVersionId:VERSION,nodeId:"node-1",textHash:HASH};
  for(const values of [{name:"Mira",description:"Keeper of the saved map.",valid:true},
    {name:" Mira ",description:"Keeper of the saved map.",valid:false},
    {name:"Mira",description:" Keeper of the saved map.\n",valid:false}]){
    const {sb,calls,result}=fixture();
    const raw={...result(true),suggestions:[{suggestionKind:"book_bible_candidate",status:"pending",type:"character",
      name:values.name,description:values.description,attributes:{occupation:"keeper"},sourceRefs:[evidence],confidence:0.9}]};
    assert.deepEqual(await runOneQuotedBookBibleJob(sb,{fetcher:async(url)=>Response.json(String(url).endsWith("request-hash")
      ?{inputSha256:HASH,model:MODEL,maxOutputTokens:100,agentType:"bookbible"}:raw)}),
    {status:values.valid?"succeeded":"requires_review",jobId:JOB});
    const completion=calls.find(call=>call.name==="complete_quoted_book_bible_job");
    if(values.valid)assert.deepEqual(completion?.args.p_candidates,raw.suggestions);
    else{assert.equal(completion,undefined);assert.equal(calls.find(call=>call.name==="hold_quoted_book_bible_for_review")?.args.p_reason,"invalid_result");}
  }
});
