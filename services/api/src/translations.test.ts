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
      if (name === "cancel_quoted_translation") return { data: { projectId: PROJECT, status: "cancelled", releasedCredits: "2", cancelledChapters: 1 }, error: null };
      if (name === "queue_translation_project") return { data: [{ id: PROJECT, book_id: BOOK, source_language: "en", target_language: "es", status: "queued", chapter_count: 1, completed_chapter_count: 0, credit_units: 2, adopted_book_id: null, created_at: "2026-09-12T00:00:00.000Z", completed_at: null }], error: null };
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

test("translation queue uses the authenticated book, returns safe progress, and never calls a provider", async () => {
  const fake = fakeSupabase(); const app = await buildApp(() => fake.client);
  try {
    const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/translations`, headers: { authorization: "Bearer good" }, payload: { targetLanguage: "es", idempotencyKey: "translation-api-1" } });
    assert.equal(response.statusCode, 202, response.body); assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(fake.calls, [{ name: "queue_translation_project", args: { p_book_id: BOOK, p_target_language: "es", p_idempotency_key: "translation-api-1" } }]);
    assert.equal(response.json().chapters.length, 0);
  } finally { await app.close(); }
});

test("translation routes reject viewers and list output without leaking queued source input", async () => {
  const viewer = fakeSupabase("viewer"); const viewerApp = await buildApp(() => viewer.client);
  try {
    const denied = await viewerApp.inject({ method: "POST", url: `/v1/books/${BOOK}/translations`, headers: { authorization: "Bearer good" }, payload: { targetLanguage: "es", idempotencyKey: "translation-api-2" } });
    assert.equal(denied.statusCode, 403); assert.equal(viewer.calls.length, 0);
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
