import { test } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";

const { buildApp } = await import("./app.js");
const USER = "d7000000-0000-4000-8000-000000000001";
const BOOK = "d7000000-0000-4000-8000-000000000002";
const WORKSPACE = "d7000000-0000-4000-8000-000000000003";
const PROJECT = "d7000000-0000-4000-8000-000000000004";
const CHAPTER = "d7000000-0000-4000-8000-000000000005";
const VERSION = "d7000000-0000-4000-8000-000000000006";

type Row = Record<string, unknown>;
function fakeSupabase(role = "editor", seed: Partial<Record<string, Row[]>> = {}) {
  const tables: Record<string, Row[]> = {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "Source", author_name: "Author", language: "en" }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role, status: "active" }],
    translation_projects: [], translation_chapters: [], ai_jobs: [], chapters: [], ...seed,
  };
  const calls: { name: string; args: Row }[] = [];
  const client = {
    auth: { getUser: async (token: string) => token === "good" ? { data: { user: { id: USER } }, error: null } : { data: { user: null }, error: { message: "bad" } } },
    rpc: async (name: string, args: Row) => {
      calls.push({ name, args });
      if (name === "accept_translation_quote") return {data:{id:PROJECT,book_id:BOOK,created_by:USER,status:"queued"},error:null};
      if (name === "cancel_quoted_translation") return { data: { projectId: PROJECT, status: "cancelled", releasedCredits: "2", cancelledChapters: 1 }, error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      const filters: [string, unknown][] = []; let limit: number | null = null;
      const selected = () => (tables[table] ?? []).filter((item) => filters.every(([key, value]) => Array.isArray(value) ? value.includes(item[key]) : item[key] === value)).slice(0, limit ?? undefined);
      const builder: Record<string, unknown> = {};
      builder.select = () => builder; builder.eq = (key: string, value: unknown) => { filters.push([key, value]); return builder; };
      builder.in = (key: string, values: unknown[]) => { filters.push([key, values]); return builder; };
      builder.order = () => builder; builder.limit = (value: number) => { limit = value; return builder; };
      builder.maybeSingle = async () => ({ data: selected()[0] ?? null, error: null });
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: selected(), error: null });
      return builder;
    },
  };
  return { client: client as never, calls };
}

test("private proposal reads cannot reveal another payer's saved offer",async()=>{
  const fake=fakeSupabase("editor",{translation_quote_proposals:[{id:PROJECT,book_id:BOOK,user_id:WORKSPACE}]});
  const app=await buildApp(()=>fake.client);
  try {
    const response=await app.inject({method:"GET",url:`/v1/translation-quotes/${PROJECT}`,headers:{authorization:"Bearer good"}});
    assert.equal(response.statusCode,404);
  }finally{await app.close();}
});

test("quote preparation requires explicit consent and editing access before queueing", async () => {
  const fake=fakeSupabase(); const app=await buildApp(()=>fake.client);
  const payload={targetLanguage:"es",modelId:"test-model",idempotencyKey:"quote-request-1"};
  try {
    for (const extra of [{},{allowProviderTokenCounting:false},{allowProviderTokenCounting:true,price:0}]) {
      const response=await app.inject({method:"POST",url:`/v1/books/${BOOK}/translation-quotes`,headers:{authorization:"Bearer good"},payload:{...payload,...extra}});
      assert.equal(response.statusCode,422);
    }
    assert.equal(fake.calls.length,0);
  } finally { await app.close(); }
  const viewer=fakeSupabase("viewer"); const viewerApp=await buildApp(()=>viewer.client);
  try {
    const response=await viewerApp.inject({method:"POST",url:`/v1/books/${BOOK}/translation-quotes`,headers:{authorization:"Bearer good"},payload:{...payload,allowProviderTokenCounting:true}});
    assert.equal(response.statusCode,403); assert.equal(viewer.calls.length,0);
  } finally { await viewerApp.close(); }
});

test("quote preparation recovery exposes only payer-owned safe progress",async()=>{
  const request={id:PROJECT,user_id:USER,book_id:BOOK,status:"queued",chapters_json:[{chapterId:CHAPTER,private:"hidden"}],
    counts_json:{},proposal_id:null,created_at:"2026-09-19T00:00:00Z",target_language:"es",model_id:"test",catalog_json:{private:"hidden"}};
  const fake=fakeSupabase("editor",{translation_quote_requests:[request,{...request,id:WORKSPACE,user_id:WORKSPACE}]});
  const app=await buildApp(()=>fake.client);
  try {
    const list=await app.inject({method:"GET",url:`/v1/books/${BOOK}/translation-quotes`,headers:{authorization:"Bearer good"}});
    assert.equal(list.statusCode,200,list.body); assert.equal(list.json().requests.length,1);
    assert.equal(list.body.includes("hidden"),false); assert.equal(list.headers["cache-control"],"private, no-store");
    const other=await app.inject({method:"GET",url:`/v1/translation-quote-requests/${WORKSPACE}`,headers:{authorization:"Bearer good"}});
    assert.equal(other.statusCode,404);
    const own=await app.inject({method:"GET",url:`/v1/translation-quote-requests/${PROJECT}`,headers:{authorization:"Bearer good"}});
    assert.equal(own.statusCode,200); assert.equal(own.json().countedChapters,0); assert.equal(own.body.includes("hidden"),false);
  } finally { await app.close(); }
});

test("quote acceptance uses the saved payer-scoped proposal and rejects caller prices", async () => {
  const seed={translation_quote_proposals:[{id:PROJECT,book_id:BOOK,user_id:USER}]};
  const fake=fakeSupabase("editor",seed); const app=await buildApp(()=>fake.client);
  try {
    const bad=await app.inject({method:"POST",url:`/v1/translation-quotes/${PROJECT}/accept`,headers:{authorization:"Bearer good"},payload:{expectedCredits:4,quote:{price:0}}});
    assert.equal(bad.statusCode,422); assert.equal(fake.calls.length,0);
    const good=await app.inject({method:"POST",url:`/v1/translation-quotes/${PROJECT}/accept`,headers:{authorization:"Bearer good"},payload:{expectedCredits:4}});
    assert.equal(good.statusCode,202,good.body);
    assert.deepEqual(fake.calls,[{name:"accept_translation_quote",args:{p_proposal_id:PROJECT,p_user_id:USER,p_expected_credits:4}}]);
  } finally { await app.close(); }
  for (const [role,payer,expected] of [["viewer",USER,403],["editor",WORKSPACE,404]] as const) {
    const denied=fakeSupabase(role,{translation_quote_proposals:[{id:PROJECT,book_id:BOOK,user_id:payer}]});
    const deniedApp=await buildApp(()=>denied.client);
    try {
      const response=await deniedApp.inject({method:"POST",url:`/v1/translation-quotes/${PROJECT}/accept`,headers:{authorization:"Bearer good"},payload:{expectedCredits:4}});
      assert.equal(response.statusCode,expected); assert.equal(denied.calls.length,0);
    } finally { await deniedApp.close(); }
  }
});

test("translation model catalog is authenticated and missing configuration cannot advertise offers", async () => {
  const original = process.env.TRANSLATION_PRICING_CATALOG_JSON;
  delete process.env.TRANSLATION_PRICING_CATALOG_JSON;
  const fake = fakeSupabase(); const app = await buildApp(() => fake.client);
  try {
    const anonymous = await app.inject({method:"GET",url:"/v1/translations/models"});
    assert.equal(anonymous.statusCode,401);
    const missing = await app.inject({method:"GET",url:"/v1/translations/models",headers:{authorization:"Bearer good"}});
    assert.equal(missing.statusCode,503);
    assert.equal(fake.calls.length,0);
  } finally {
    await app.close();
    if (original === undefined) delete process.env.TRANSLATION_PRICING_CATALOG_JSON;
    else process.env.TRANSLATION_PRICING_CATALOG_JSON = original;
  }
});

test("billing route authenticates payer, scopes quotes and returns only public credit totals", async () => {
  const job = "d7000000-0000-4000-8000-000000000008";
  const seed = {
    translation_projects: [{id:PROJECT,book_id:BOOK,workspace_id:WORKSPACE,created_by:USER}],
    translation_chapters: [{project_id:PROJECT,ai_job_id:job}],
    funded_usage_quotes: [{job_id:job,user_id:USER,workspace_id:WORKSPACE,reserved_credits:7,status:"held",settlement_json:null,quote_json:{private:"secret"}}],
  };
  const fake = fakeSupabase("editor",seed); const app = await buildApp(() => fake.client);
  try {
    const response = await app.inject({method:"GET",url:`/v1/translations/${PROJECT}/billing`,headers:{authorization:"Bearer good"}});
    assert.equal(response.statusCode,200,response.body); assert.equal(response.headers["cache-control"],"private, no-store");
    assert.deepEqual(response.json(),{reservedCredits:"7",heldCredits:"7",chargedCredits:"0",returnedCredits:"0",reviewChapters:0,chapterCount:1});
    assert.equal(fake.calls.length,0);
  } finally { await app.close(); }
  const denied = fakeSupabase("editor",{...seed,translation_projects:[{...seed.translation_projects[0],created_by:WORKSPACE}]});
  let serviceAccess = 0;
  const deniedApp = await buildApp((token?: string) => { if (!token) serviceAccess++; return denied.client; });
  try {
    const before = serviceAccess;
    const response = await deniedApp.inject({method:"GET",url:`/v1/translations/${PROJECT}/billing`,headers:{authorization:"Bearer good"}});
    assert.equal(response.statusCode,403); assert.equal(serviceAccess,before);
  } finally { await deniedApp.close(); }
});

test("legacy translation creation is retired and cannot enqueue a provider job", async () => {
  const fake = fakeSupabase(); const app = await buildApp(() => fake.client);
  try {
    const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/translations`, headers: { authorization: "Bearer good" }, payload: { targetLanguage: "es", idempotencyKey: "translation-api-1" } });
    assert.equal(response.statusCode, 410, response.body);
    assert.equal(response.json().error.code, "translation_quote_required");
    assert.equal(fake.calls.length, 0);
  } finally { await app.close(); }
});

test("legacy translation creation is retired for viewers and history does not leak queued source input", async () => {
  const viewer = fakeSupabase("viewer"); const viewerApp = await buildApp(() => viewer.client);
  try {
    const denied = await viewerApp.inject({ method: "POST", url: `/v1/books/${BOOK}/translations`, headers: { authorization: "Bearer good" }, payload: { targetLanguage: "es", idempotencyKey: "translation-api-2" } });
    assert.equal(denied.statusCode, 410); assert.equal(viewer.calls.length, 0);
  } finally { await viewerApp.close(); }
  const history = fakeSupabase("editor", {
    translation_projects: [{ id: PROJECT, book_id: BOOK, source_language: "en", target_language: "es", status: "queued", chapter_count: 1, completed_chapter_count: 0, credit_units: 1, adopted_book_id: null, created_at: "2026-09-12T00:00:00.000Z", completed_at: null }],
    translation_chapters: [{ id: "d7000000-0000-4000-8000-000000000007", project_id: PROJECT, ai_job_id: "d7000000-0000-4000-8000-000000000008", chapter_id: CHAPTER, document_version_id: VERSION, chapter_order: 0, translated_text: null, translated_word_count: null }],
    ai_jobs: [{ id: "d7000000-0000-4000-8000-000000000008", status: "queued", error_code: null, input_ref: { privateSource: "never return this" } }],
    chapters: [{ id: CHAPTER, title: "Opening", order_index: 0 }],
  });
  const historyApp = await buildApp(() => history.client);
  try {
    const listed = await historyApp.inject({ method: "GET", url: `/v1/books/${BOOK}/translations`, headers: { authorization: "Bearer good" } });
    assert.equal(listed.statusCode, 200, listed.body); assert.equal(JSON.stringify(listed.json()).includes("never return this"), false);
    assert.equal(listed.json().projects[0].chapters[0].chapterTitle, "Opening");
  } finally { await historyApp.close(); }
});

test("quoted cancellation binds authenticated creator and rejects refund/actor injection", async () => {
  const seed = { translation_projects: [{ id: PROJECT, book_id: BOOK, created_by: USER, status: "queued" }] };
  const fake = fakeSupabase("editor", seed); const app = await buildApp(() => fake.client);
  try {
    const injected = await app.inject({ method: "POST", url: `/v1/translations/${PROJECT}/cancel`, headers: { authorization: "Bearer good" }, payload: { userId: USER, releasedCredits: 1000 } });
    assert.equal(injected.statusCode, 422); assert.equal(fake.calls.length, 0);
    const ok = await app.inject({ method: "POST", url: `/v1/translations/${PROJECT}/cancel`, headers: { authorization: "Bearer good" }, payload: {} });
    assert.equal(ok.statusCode, 200, ok.body); assert.equal(ok.json().releasedCredits, "2");
    assert.deepEqual(fake.calls, [{ name: "cancel_quoted_translation", args: { p_project_id: PROJECT, p_user_id: USER } }]);
  } finally { await app.close(); }
  for (const [role, creator] of [["viewer", USER], ["editor", PROJECT]]) {
    const denied = fakeSupabase(role, { translation_projects: [{ id: PROJECT, book_id: BOOK, created_by: creator }] });
    const deniedApp = await buildApp(() => denied.client);
    try {
      const response = await deniedApp.inject({ method: "POST", url: `/v1/translations/${PROJECT}/cancel`, headers: { authorization: "Bearer good" }, payload: {} });
      assert.equal(response.statusCode, 403); assert.equal(denied.calls.length, 0);
    } finally { await deniedApp.close(); }
  }
});
