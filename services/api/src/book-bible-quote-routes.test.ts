import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { bookBibleQuoteRoutes } from "./routes/book-bible-quotes.js";

const BOOK = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const CHAPTER = "33333333-3333-4333-8333-333333333333";
const VERSION = "44444444-4444-4444-8444-444444444444";
const USER = "55555555-5555-4555-8555-555555555555";
const TOKEN = "book-bible-counter-test-token";
const SOURCE = "Mira finds a map beneath the old theatre.";
const auth = { authorization: "Bearer valid" };
type Row = Record<string, any>;

function catalog() {
  return JSON.stringify({ version: "synthetic-bible-v1", approved: true, approvalReference: "tests-only",
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
    document_versions: [{ id: VERSION, chapter_id: CHAPTER, version_number: 3,
      content_json: { nodes: [{ id: "node-1", type: "paragraph", text: SOURCE }] } }],
    book_bible_items: [], style_guides: [], book_bible_token_quote_requests: [], ai_jobs: [], usage_events: [], credit_reservations: [],
  };
  const rpcCalls: { name: string; args: Row }[] = [];
  const factory = ((token?: string) => ({
    auth: { getUser: async (value: string) => ({ data: { user: value === "valid" ? { id: USER } : null }, error: null }) },
    async rpc(name: string, args: Row) {
      rpcCalls.push({ name, args });
      if (name === "request_book_bible_token_quote") {
        const existing = state.book_bible_token_quote_requests.find((item) => item.user_id === args.p_user_id
          && item.idempotency_key === args.p_idempotency_key);
        if (existing) return { data: { request: { ...existing }, claimed: false }, error: null };
        const request = { id: randomUUID(), user_id: args.p_user_id, workspace_id: args.p_workspace_id,
          book_id: args.p_book_id, generation_job_id: args.p_generation_job_id,
          generation_request_json: args.p_generation_request, catalog_json: args.p_catalog,
          source_versions_json: args.p_source_versions, source_sha256: createHash("sha256").update(JSON.stringify(args.p_source_versions)).digest("hex"),
          generation_request_sha256: null, counted_input_tokens: null, usage_quote_json: null,
          idempotency_key: args.p_idempotency_key, status: "counting", lease_token: randomUUID(),
          lease_expires_at: new Date(Date.now() + 180_000).toISOString(), error_code: null,
          accepted_job_id: null, accepted_at: null, created_at: new Date().toISOString() };
        state.book_bible_token_quote_requests.push(request);
        return { data: { request: { ...request }, claimed: true }, error: null };
      }
      if (name === "complete_book_bible_token_quote_count") {
        const request = state.book_bible_token_quote_requests.find((item) => item.id === args.p_request_id)!;
        Object.assign(request, { status: "ready", lease_token: null, lease_expires_at: null,
          generation_request_sha256: args.p_request_sha256, counted_input_tokens: args.p_counted_input_tokens,
          usage_quote_json: args.p_usage_quote });
        return { data: { ...request }, error: null };
      }
      if (name === "fail_book_bible_token_quote_count") {
        const request = state.book_bible_token_quote_requests.find((item) => item.id === args.p_request_id);
        if (request) Object.assign(request, { status: "failed", lease_token: null, lease_expires_at: null, error_code: args.p_error_code });
        return { data: true, error: null };
      }
      if (name === "accept_book_bible_token_quote") {
        const request = state.book_bible_token_quote_requests.find((item) => item.id === args.p_request_id)!;
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
        eq(key: string, value: unknown) { filters.push((row) => row[key] === value); return this; },
        in(key: string, values: unknown[]) { filters.push((row) => values.includes(row[key])); return this; },
        order(key: string, options?: { ascending?: boolean }) { sort = key; ascending = options?.ascending ?? true; return this; },
        limit(value: number) { max = value; return this; },
        async maybeSingle() {
          let found = rows.filter((row) => filters.every((filter) => filter(row)));
          if (sort) found = [...found].sort((a, b) => String(a[sort]).localeCompare(String(b[sort])) * (ascending ? 1 : -1));
          const row = found[0];
          return { data: row ? columns === "*" ? { ...row } : Object.fromEntries(columns.split(",").map((column) => [column, row[column]])) : null, error: null };
        },
        then(resolve: (value: unknown) => unknown) {
          let found = rows.filter((row) => filters.every((filter) => filter(row)));
          if (sort) found = [...found].sort((a, b) => String(a[sort]).localeCompare(String(b[sort])) * (ascending ? 1 : -1));
          const data = found.slice(0, max).map((row) => columns === "*" ? { ...row } : Object.fromEntries(columns.split(",").map((column) => [column, row[column]])));
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
  await app.register(async (v1) => bookBibleQuoteRoutes(v1, { fetcher }), { prefix: "/v1" });
  return app;
}

function payload(overrides: Row = {}) {
  return { modelId: "writer", chapterIds: [CHAPTER], idempotencyKey: "bible-quote-key-0001", maxTokens: 4096,
    allowProviderTokenCounting: true, ...overrides };
}

function withEnv(t: { after: (fn: () => void) => void }) {
  const previousCatalog = process.env.BOOK_BIBLE_PRICING_CATALOG_JSON;
  const previousToken = process.env.AI_SERVICE_TOKEN;
  process.env.BOOK_BIBLE_PRICING_CATALOG_JSON = catalog();
  process.env.AI_SERVICE_TOKEN = TOKEN;
  t.after(() => {
    if (previousCatalog === undefined) delete process.env.BOOK_BIBLE_PRICING_CATALOG_JSON;
    else process.env.BOOK_BIBLE_PRICING_CATALOG_JSON = previousCatalog;
    if (previousToken === undefined) delete process.env.AI_SERVICE_TOKEN;
    else process.env.AI_SERVICE_TOKEN = previousToken;
  });
}

test("Book Bible model listing is authenticated and fails closed without an approved catalog", async (t) => {
  const previous = process.env.BOOK_BIBLE_PRICING_CATALOG_JSON;
  delete process.env.BOOK_BIBLE_PRICING_CATALOG_JSON;
  t.after(() => previous === undefined ? delete process.env.BOOK_BIBLE_PRICING_CATALOG_JSON : process.env.BOOK_BIBLE_PRICING_CATALOG_JSON = previous);
  const { factory } = setup();
  const app = await makeApp(factory, async () => { throw new Error("model listing must not call provider"); }); t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/bible/models` })).statusCode, 401);
  const response = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/bible/models`, headers: auth });
  assert.equal(response.statusCode, 503, response.body);
});

test("Book Bible quote requires explicit consent and writer access before token counting", async (t) => {
  withEnv(t);
  const { factory: reviewerFactory } = setup("reviewer"); let countCalls = 0;
  const reviewerApp = await makeApp(reviewerFactory, async () => { countCalls++; throw new Error("must not count"); }); t.after(() => reviewerApp.close());
  const denied = await reviewerApp.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/quotes`, headers: auth, payload: payload() });
  assert.equal(denied.statusCode, 403, denied.body); assert.equal(countCalls, 0);
  const { factory } = setup();
  const app = await makeApp(factory, async () => { countCalls++; throw new Error("must not count"); }); t.after(() => app.close());
  const noConsent = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/quotes`, headers: auth,
    payload: payload({ allowProviderTokenCounting: false }) });
  assert.equal(noConsent.statusCode, 422, noConsent.body); assert.equal(countCalls, 0);
});

test("Book Bible quote counts only the selected saved batch and version, then ready replay does not recount", async (t) => {
  withEnv(t);
  const { factory, state, rpcCalls } = setup(); let countCalls = 0; let countedRequest: Row | undefined;
  const app = await makeApp(factory, async (url, init) => {
    countCalls++;
    assert.equal(String(url), "http://127.0.0.1:8000/v1/ai/text/quote");
    assert.equal(new Headers(init?.headers).get("x-service-token"), TOKEN);
    countedRequest = JSON.parse(String(init?.body));
    return Response.json({ inputTokens: 420, inputSha256: "a".repeat(64), model: "gpt-6-astra-2026-09-01",
      maxOutputTokens: 1200, agentType: "bookbible" });
  }); t.after(() => app.close());
  const request = payload();
  const created = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/quotes`, headers: auth, payload: request });
  assert.equal(created.statusCode, 201, created.body); assert.equal(created.headers["cache-control"], "private, no-store");
  assert.equal(countCalls, 1); assert.equal(state.book_bible_token_quote_requests.length, 1);
  assert.deepEqual(countedRequest?.input.chapterIds, [CHAPTER]);
  assert.deepEqual(Object.keys(countedRequest?.input.chapters ?? {}), [CHAPTER]);
  assert.equal(countedRequest?.input.chapters[CHAPTER].documentVersionId, VERSION);
  assert.equal(countedRequest?.input.chapters[CHAPTER].nodes[0].text, SOURCE);
  assert.deepEqual(state.book_bible_token_quote_requests[0]?.source_versions_json.versions,
    [{ chapterId: CHAPTER, version: 3, documentVersionId: VERSION }]);
  assert.equal(rpcCalls[0]?.name, "request_book_bible_token_quote");
  assert.equal(rpcCalls[0]?.args.p_provider_counting_consent, true);
  assert.equal(rpcCalls[1]?.name, "complete_book_bible_token_quote_count");
  const quote = created.json().quote;
  assert.equal(quote.status, "ready"); assert.equal(quote.countedInputTokens, 420); assert.ok(quote.reservedCredits > 0);
  const replay = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/quotes`, headers: auth, payload: request });
  assert.equal(replay.statusCode, 200, replay.body); assert.equal(countCalls, 1, "ready quote replay called token counter again");
  assert.equal(replay.json().quote.reservedCredits, quote.reservedCredits);
  assert.deepEqual(state.ai_jobs, []); assert.deepEqual(state.usage_events, []); assert.deepEqual(state.credit_reservations, []);
});

test("Book Bible provider/count failures create no job, usage, or funded reservation", async (t) => {
  withEnv(t);
  const { factory, state, rpcCalls } = setup();
  const app = await makeApp(factory, async () => new Response("counter unavailable", { status: 503 })); t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/quotes`, headers: auth, payload: payload() });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(state.book_bible_token_quote_requests.length, 1);
  assert.equal(state.book_bible_token_quote_requests[0]?.status, "failed");
  assert.equal(rpcCalls.at(-1)?.name, "fail_book_bible_token_quote_count");
  assert.deepEqual(state.ai_jobs, []); assert.deepEqual(state.usage_events, []); assert.deepEqual(state.credit_reservations, []);
  assert.equal(rpcCalls.some(({ name }) => name === "accept_book_bible_token_quote"), false);
});

test("Book Bible acceptance checks exact expected credits and delegates acceptance only once", async (t) => {
  withEnv(t);
  const { factory, state, rpcCalls } = setup();
  const app = await makeApp(factory, async () => Response.json({ inputTokens: 420, inputSha256: "a".repeat(64),
    model: "gpt-6-astra-2026-09-01", maxOutputTokens: 1200, agentType: "bookbible" })); t.after(() => app.close());
  const created = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/quotes`, headers: auth, payload: payload() });
  assert.equal(created.statusCode, 201, created.body);
  const { requestId, reservedCredits } = created.json().quote;
  const wrong = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/quotes/${requestId}/accept`, headers: auth,
    payload: { expectedCredits: reservedCredits + 1 } });
  assert.equal(wrong.statusCode, 409, wrong.body);
  assert.equal(rpcCalls.filter(({ name }) => name === "accept_book_bible_token_quote").length, 0);
  assert.deepEqual(state.ai_jobs, []);
  const accepted = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/quotes/${requestId}/accept`, headers: auth,
    payload: { expectedCredits: reservedCredits } });
  assert.equal(accepted.statusCode, 202, accepted.body); assert.equal(accepted.json().status, "queued");
  assert.equal(rpcCalls.at(-1)?.name, "accept_book_bible_token_quote");
  assert.equal(rpcCalls.at(-1)?.args.p_expected_credits, reservedCredits);
  assert.equal(rpcCalls.filter(({ name }) => name === "accept_book_bible_token_quote").length, 1);
  assert.equal(state.ai_jobs.length, 1);
});

test("Book Bible quote status is scoped, read-only, and never calls the provider", async (t) => {
  withEnv(t);
  const { factory, state, rpcCalls } = setup(); let countCalls = 0;
  const app = await makeApp(factory, async () => { countCalls++; throw new Error("status must not call provider"); }); t.after(() => app.close());
  const requestId = randomUUID();
  const row = { id: requestId, user_id: USER, workspace_id: WORKSPACE, book_id: BOOK, generation_job_id: randomUUID(),
    idempotency_key: "status-only-key", generation_request_json: { model: "gpt-6-astra-2026-09-01", maxOutputTokens: 1200 },
    catalog_json: {}, source_versions_json: {}, source_sha256: "b".repeat(64), generation_request_sha256: null,
    counted_input_tokens: null, usage_quote_json: null, status: "counting", lease_token: randomUUID(), lease_expires_at: null,
    error_code: null, accepted_job_id: null, accepted_at: null, created_at: new Date().toISOString() };
  state.book_bible_token_quote_requests.push(row);
  const response = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/bible/quotes/${requestId}`, headers: auth });
  assert.equal(response.statusCode, 200, response.body); assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.json().quote.status, "counting"); assert.equal(response.json().job, null);
  assert.equal(countCalls, 0); assert.deepEqual(rpcCalls, []);
  const otherBook = await app.inject({ method: "GET", url: `/v1/books/${"66666666-6666-4666-8666-666666666666"}/bible/quotes/${requestId}`, headers: auth });
  assert.equal(otherBook.statusCode, 404);
});
