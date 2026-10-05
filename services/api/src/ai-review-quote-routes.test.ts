import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { aiReviewQuoteRoutes } from "./routes/ai-review-quotes.js";

const BOOK = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const CHAPTER = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const TOKEN = "synthetic-ai-review-token";
const SOURCE = "Mira finds a map beneath the old theatre.";
type Row = Record<string, any>;
const auth = { authorization: "Bearer valid" };

function catalog() {
  return JSON.stringify({ version: "synthetic-ai-v1", approved: true, approvalReference: "tests-only",
    effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", quoteLifetimeSeconds: 600,
    entries: [{ id: "writer", label: "Synthetic writer", maxInputTokens: 10000, maxOutputTokens: 1200,
      price: { version: "price-v1", provider: "openai", model: "gpt-6-astra-2026-09-01", rates: [
        { dimension: "text_input", microUsdPerMillionTokens: "1000000" },
        { dimension: "text_cached_input", microUsdPerMillionTokens: "100000" },
        { dimension: "text_output", microUsdPerMillionTokens: "2000000" }] },
      policy: { version: "policy-v1", approved: true, microUsdPerCredit: "1000", markupBasisPoints: 15000,
        platformMicroUsd: "100", minimumCredits: "1" } }] });
}

function setup(role = "writer") {
  const state: Record<string, Row[]> = {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "The Old Theatre", author_name: "Mira Vale", language: "en" }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role, status: "active" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, title: "The Map", order_index: 0, current_document_version_id: VERSION }],
    document_versions: [{ id: VERSION, chapter_id: CHAPTER, version_number: 3, content_json: { nodes: [
      { id: "node-1", type: "paragraph", text: SOURCE }] } }],
    style_guides: [], book_bible_items: [], ai_review_token_quote_requests: [], ai_jobs: [],
  };
  const rpcCalls: { name: string; args: Row }[] = [];
  const factory = ((token?: string) => ({
    auth: { getUser: async (value: string) => ({ data: { user: value === "valid" ? { id: USER } : null }, error: null }) },
    async rpc(name: string, args: Row) {
      rpcCalls.push({ name, args });
      if (name === "request_ai_review_token_quote") {
        const existing = state.ai_review_token_quote_requests.find((item) => item.user_id === args.p_user_id && item.idempotency_key === args.p_idempotency_key);
        if (existing) return { data: { request: { ...existing }, claimed: false }, error: null };
        const request = { id: randomUUID(), user_id: args.p_user_id, workspace_id: args.p_workspace_id,
          book_id: args.p_book_id, generation_job_id: args.p_generation_job_id,
          generation_request_json: args.p_generation_request, catalog_json: args.p_catalog,
          source_versions_json: args.p_source_versions, idempotency_key: args.p_idempotency_key,
          status: "counting", lease_token: randomUUID(), lease_expires_at: new Date(Date.now() + 180_000).toISOString(),
          request_sha256: null, counted_input_tokens: null, usage_quote_json: null, error_code: null,
          accepted_job_id: null, created_at: new Date().toISOString() };
        state.ai_review_token_quote_requests.push(request);
        return { data: { request: { ...request }, claimed: true }, error: null };
      }
      if (name === "complete_ai_review_token_quote_count") {
        const request = state.ai_review_token_quote_requests.find((item) => item.id === args.p_request_id)!;
        Object.assign(request, { status: "ready", lease_token: null, lease_expires_at: null,
          request_sha256: args.p_request_sha256, counted_input_tokens: args.p_counted_input_tokens,
          usage_quote_json: args.p_usage_quote });
        return { data: { ...request }, error: null };
      }
      if (name === "fail_ai_review_token_quote_count") {
        const request = state.ai_review_token_quote_requests.find((item) => item.id === args.p_request_id);
        if (request) Object.assign(request, { status: "failed", lease_token: null, lease_expires_at: null, error_code: args.p_error_code });
        return { data: true, error: null };
      }
      if (name === "accept_ai_review_token_quote") {
        const request = state.ai_review_token_quote_requests.find((item) => item.id === args.p_request_id)!;
        const job = { id: request.generation_job_id, book_id: request.book_id, created_by: request.user_id,
          billing_mode: "quoted", status: "queued" };
        Object.assign(request, { accepted_job_id: job.id, accepted_at: new Date().toISOString() });
        state.ai_jobs.push(job);
        return { data: job, error: null };
      }
      return { data: null, error: { code: "42883" } };
    },
    from(table: string) {
      const rows = state[table] ?? (state[table] = []);
      const filters: ((row: Row) => boolean)[] = [];
      let columns = "*"; let sort = ""; let ascending = true; let max = Number.POSITIVE_INFINITY;
      const builder: any = {
        select(value = "*") { columns = value; return this; },
        eq(key: string, value: unknown) { filters.push((item) => item[key] === value); return this; },
        in(key: string, values: unknown[]) { filters.push((item) => values.includes(item[key])); return this; },
        order(key: string, options?: { ascending?: boolean }) { sort = key; ascending = options?.ascending ?? true; return this; },
        limit(value: number) { max = value; return this; },
        async maybeSingle() {
          let found = rows.filter((item) => filters.every((filter) => filter(item)));
          if (sort) found = [...found].sort((a, b) => String(a[sort]).localeCompare(String(b[sort])) * (ascending ? 1 : -1));
          const item = found[0];
          return { data: item ? columns === "*" ? { ...item } : Object.fromEntries(columns.split(",").map((column) => [column, item[column]])) : null, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          let found = rows.filter((item) => filters.every((filter) => filter(item)));
          if (sort) found = [...found].sort((a, b) => String(a[sort]).localeCompare(String(b[sort])) * (ascending ? 1 : -1));
          const data = found.slice(0, max).map((item) => columns === "*" ? { ...item } : Object.fromEntries(columns.split(",").map((column) => [column, item[column]])));
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
    __token: token,
  })) as never;
  return { state, rpcCalls, factory };
}

async function makeApp(factory: ReturnType<typeof setup>["factory"], fetcher: typeof fetch) {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(makeAuthPlugin(factory));
  await app.register(async (v1) => aiReviewQuoteRoutes(v1, { fetcher }), { prefix: "/v1" });
  return app;
}

function payload(overrides: Row = {}) {
  return { modelId: "writer", agentType: "proofreader", chapterIds: [CHAPTER], idempotencyKey: "review-quote-key-0001",
    contextPolicy: { includeBookBible: true, includeStyleGuide: true, includeRelatedContext: false, semanticTopK: 5, maxTokens: 4096 },
    allowProviderTokenCounting: true, ...overrides };
}

test("AI review quote requires explicit counting consent and a writing role before provider counting", async (t) => {
  const previousCatalog = process.env.AI_REVIEW_PRICING_CATALOG_JSON;
  process.env.AI_REVIEW_PRICING_CATALOG_JSON = catalog();
  t.after(() => previousCatalog === undefined ? delete process.env.AI_REVIEW_PRICING_CATALOG_JSON : process.env.AI_REVIEW_PRICING_CATALOG_JSON = previousCatalog);
  const { factory } = setup("reviewer"); let countCalls = 0;
  const app = await makeApp(factory, async () => { countCalls++; throw new Error("must not contact counter"); }); t.after(() => app.close());
  const denied = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/ai-review/quotes`, headers: auth, payload: payload() });
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal(countCalls, 0);
  const { factory: editorFactory } = setup();
  const editorApp = await makeApp(editorFactory, async () => { countCalls++; throw new Error("must not contact counter"); }); t.after(() => editorApp.close());
  const noConsent = await editorApp.inject({ method: "POST", url: `/v1/books/${BOOK}/ai-review/quotes`, headers: auth,
    payload: payload({ allowProviderTokenCounting: false }) });
  assert.equal(noConsent.statusCode, 422, noConsent.body);
  assert.equal(countCalls, 0);
});

test("AI review quote binds consented source request, counts once, and replays without another provider call", async (t) => {
  const previousCatalog = process.env.AI_REVIEW_PRICING_CATALOG_JSON; const previousToken = process.env.AI_SERVICE_TOKEN;
  process.env.AI_REVIEW_PRICING_CATALOG_JSON = catalog(); process.env.AI_SERVICE_TOKEN = TOKEN;
  t.after(() => { if (previousCatalog === undefined) delete process.env.AI_REVIEW_PRICING_CATALOG_JSON; else process.env.AI_REVIEW_PRICING_CATALOG_JSON = previousCatalog;
    if (previousToken === undefined) delete process.env.AI_SERVICE_TOKEN; else process.env.AI_SERVICE_TOKEN = previousToken; });
  const { factory, state, rpcCalls } = setup(); let countCalls = 0; let sent: Row | undefined;
  const app = await makeApp(factory, async (url, init) => {
    countCalls++; assert.equal(String(url), "http://127.0.0.1:8000/v1/ai/text/quote");
    assert.equal(new Headers(init?.headers).get("x-service-token"), TOKEN);
    sent = JSON.parse(String(init?.body));
    return Response.json({ inputTokens: 420, inputSha256: "a".repeat(64), model: "gpt-6-astra-2026-09-01", maxOutputTokens: 1200, agentType: "proofreader" });
  }); t.after(() => app.close());
  const request = payload();
  const first = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/ai-review/quotes`, headers: auth, payload: request });
  assert.equal(first.statusCode, 201, first.body); assert.equal(first.headers["cache-control"], "private, no-store");
  assert.equal(countCalls, 1); assert.equal(state.ai_review_token_quote_requests.length, 1);
  assert.equal(sent?.input.chapters[CHAPTER].nodes[0].text, SOURCE);
  assert.deepEqual(sent?.input.chapterIds, [CHAPTER]);
  assert.equal(state.ai_review_token_quote_requests[0].source_versions_json[0].documentVersionId, VERSION);
  assert.equal(rpcCalls[0]?.name, "request_ai_review_token_quote");
  assert.equal(rpcCalls[1]?.name, "complete_ai_review_token_quote_count");
  const quote = first.json().quote;
  assert.equal(quote.status, "ready"); assert.equal(quote.countedInputTokens, 420); assert.ok(quote.reservedCredits > 0);
  const replay = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/ai-review/quotes`, headers: auth, payload: request });
  assert.equal(replay.statusCode, 200, replay.body); assert.equal(countCalls, 1, "ready quote replay called provider counter again");
  assert.equal(replay.json().quote.reservedCredits, quote.reservedCredits);
  const changed = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/ai-review/quotes`, headers: auth,
    payload: payload({ userInstruction: "Change my request" }) });
  assert.equal(changed.statusCode, 409, changed.body); assert.equal(countCalls, 1);
  const wrongPrice = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/ai-review/quotes/${quote.requestId}/accept`, headers: auth,
    payload: { expectedCredits: quote.reservedCredits + 1 } });
  assert.equal(wrongPrice.statusCode, 409, wrongPrice.body); assert.equal(rpcCalls.at(-1)?.name, "complete_ai_review_token_quote_count");
  const accepted = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/ai-review/quotes/${quote.requestId}/accept`, headers: auth,
    payload: { expectedCredits: quote.reservedCredits } });
  assert.equal(accepted.statusCode, 202, accepted.body); assert.equal(accepted.json().status, "queued");
  assert.equal(rpcCalls.at(-1)?.name, "accept_ai_review_token_quote");
  const status = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/ai-review/quotes/${first.json().quote.requestId}`, headers: auth });
  assert.equal(status.statusCode, 200, status.body); assert.equal(status.headers["cache-control"], "private, no-store");
  assert.equal(status.json().quote.reservedCredits, quote.reservedCredits);
  assert.equal(status.json().job.status, "queued");
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/ai-review/models`, headers: auth })).statusCode, 200);
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/ai-review/models` })).statusCode, 401);
});

test("AI review counter failures fail the quote request without creating a generation job", async (t) => {
  const previousCatalog = process.env.AI_REVIEW_PRICING_CATALOG_JSON; const previousToken = process.env.AI_SERVICE_TOKEN;
  process.env.AI_REVIEW_PRICING_CATALOG_JSON = catalog(); process.env.AI_SERVICE_TOKEN = TOKEN;
  t.after(() => { if (previousCatalog === undefined) delete process.env.AI_REVIEW_PRICING_CATALOG_JSON; else process.env.AI_REVIEW_PRICING_CATALOG_JSON = previousCatalog;
    if (previousToken === undefined) delete process.env.AI_SERVICE_TOKEN; else process.env.AI_SERVICE_TOKEN = previousToken; });
  const { factory, state } = setup();
  const app = await makeApp(factory, async () => new Response("counter unavailable", { status: 503 })); t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/ai-review/quotes`, headers: auth, payload: payload() });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(state.ai_review_token_quote_requests.length, 1);
  assert.equal(state.ai_review_token_quote_requests[0]?.status, "failed");
  assert.equal(state.ai_jobs.length, 0, "quote counting created a generation job");
  assert.deepEqual(state.ai_review_token_quote_requests[0]?.generation_request_json.input.chapterIds, [CHAPTER]);
});
