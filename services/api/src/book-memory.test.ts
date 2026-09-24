import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { bookMemoryRoutes } from "./routes/book-memory.js";
import { metadataGenerationRoutes } from "./routes/metadata-generation.js";
import { bookBibleGenerationRoutes } from "./routes/book-bible-generation.js";

const BOOK = "11111111-1111-4111-8111-111111111111";
const OTHER_BOOK = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "33333333-3333-4333-8333-333333333333";
const CHAPTER = "44444444-4444-4444-8444-444444444444";
const IMAGE = "55555555-5555-4555-8555-555555555555";
const VERSION = "66666666-6666-4666-8666-666666666666";
const USER = "77777777-7777-4777-8777-777777777777";
const TIME = "2026-08-31T08:00:00.000Z";
const SOURCE_TEXT = "Elara carries a silver compass.";
const SOURCE_HASH = createHash("sha256").update(SOURCE_TEXT).digest("hex");
const auth = { authorization: "Bearer good" };
type Row = Record<string, unknown>;
type Store = Record<string, Row[]>;

// Stateful query fake checks route filters and mutations, but intentionally
// does not simulate RLS. Database policy tests are a separate acceptance gate.
function fakeSupabase(store: Store, failTable?: string) {
  return {
    auth: { getUser: async (token: string) => ({ data: { user: token === "good" ? { id: USER } : null }, error: null }) },
    async rpc(name: string, args: Record<string, unknown>) {
      if (name !== "complete_book_bible_ai_job") return { data: null, error: { code: "42883" } };
      const job = (store.ai_jobs ?? []).find((row) => row.id === args.p_job_id);
      if (!job) return { data: null, error: { code: "P0002" } };
      if (job.status !== "succeeded") {
        job.status = "succeeded";
        job.output_ref = { candidates: args.p_candidates, reviewRequired: true, savedBibleUpdated: false };
        (store.usage_events ??= []).push({ ai_job_id: job.id, quantity: args.p_credit_quantity });
      }
      return { data: { ...job }, error: null };
    },
    from(table: string) {
      const rows = store[table] ??= [];
      const filters: ((row: Row) => boolean)[] = [];
      let operation = "read";
      let payload: Row = {};
      let ascending = true;
      let orderColumn: string | null = null;
      let rowLimit = Infinity;
      let result: { data: Row[] | null; error: unknown } | undefined;
      const run = () => {
        if (result) return result;
        if (table === failTable) return result = { data: null, error: { message: "deliberate database failure" } };
        let found = rows.filter((row) => filters.every((filter) => filter(row)));
        if (operation === "insert") {
          if (table === "book_metadata" && rows.some((row) => row.book_id === payload.book_id)) return result = { data: null, error: { code: "23505" } };
          const row = { id: randomUUID(), created_at: TIME, updated_at: TIME, ...payload };
          rows.push(row); found = [row];
        }
        if (operation === "update") found.forEach((row) => Object.assign(row, payload));
        if (operation === "delete") found.forEach((row) => rows.splice(rows.indexOf(row), 1));
        if (orderColumn) found.sort((a, b) => String(a[orderColumn!]).localeCompare(String(b[orderColumn!])) * (ascending ? 1 : -1));
        return result = { data: found.slice(0, rowLimit).map((row) => ({ ...row })), error: null };
      };
      const builder = {
        select() { return this; },
        limit(value: number) { rowLimit = value; return this; },
        eq(column: string, value: unknown) { filters.push((row) => row[column] === value); return this; },
        gte(column: string, value: unknown) { filters.push((row) => String(row[column]) >= String(value)); return this; },
        is(column: string, value: unknown) { filters.push((row) => row[column] === value); return this; },
        in(column: string, values: unknown[]) { filters.push((row) => values.includes(row[column])); return this; },
        order(column: string, options?: { ascending: boolean }) { orderColumn = column; ascending = options?.ascending ?? true; return this; },
        insert(value: Row) { operation = "insert"; payload = value; return this; },
        update(value: Row) { operation = "update"; payload = value; return this; },
        delete() { operation = "delete"; return this; },
        async maybeSingle() { const value = run(); return { ...value, data: value.data?.[0] ?? null }; },
        async single() { return this.maybeSingle(); },
        then(resolve: (value: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
      };
      return builder;
    },
  } as never;
}

function initialStore(role = "editor"): Store {
  return {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "The Long Way Home", author_name: "Ada", updated_at: TIME }],
    workspace_members: [{ user_id: USER, workspace_id: WORKSPACE, role, status: "active" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, title: "Arrival", current_document_version_id: VERSION }],
    document_versions: [{ id: VERSION, chapter_id: CHAPTER, content_json: { nodes: [{ id: "n1", type: "paragraph", text: SOURCE_TEXT }] } }],
    assets: [{ id: IMAGE, workspace_id: WORKSPACE, name: "Elara.png", mime_type: "image/png", checksum: "a".repeat(64), storage_path: "private/image.png", size_bytes: 100, deleted_at: null }],
    asset_versions: [{ asset_id: IMAGE, mime_type: "image/png", checksum: "a".repeat(64), storage_path: "private/image.png", size_bytes: 100, scan_status: "clean" }],
  };
}

async function appWith(store: Store, failTable?: string, aiFetch?: typeof fetch) {
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(makeAuthPlugin(() => fakeSupabase(store, failTable)));
  await app.register(async (v1) => bookMemoryRoutes(v1), { prefix: "/v1" });
  await app.register(async (v1) => metadataGenerationRoutes(v1, { fetcher: async () => { throw new Error("History must never call an AI provider"); } }), { prefix: "/v1" });
  await app.register(async (v1) => bookBibleGenerationRoutes(v1, { fetcher: aiFetch ?? (async () => { throw new Error("Test transport must not dispatch AI"); }) }), { prefix: "/v1" });
  return app;
}

const entry = { type: "character", name: "Elara", description: "A mapmaker", attributes: { appearance: "Silver hair" }, imageAssetIds: [IMAGE], sourceRefs: [{ chapterId: CHAPTER, documentVersionId: VERSION, note: "Opening scene" }] };

test("Book Bible evidence reads the exact pinned passage and identifies historical versions", async (t) => {
  const store = initialStore("viewer");
  store.document_versions[0].version_number = 7;
  const app = await appWith(store); t.after(() => app.close());
  const url = `/v1/books/${BOOK}/bible/evidence`;
  const payload = { chapterId: CHAPTER, documentVersionId: VERSION, nodeId: "n1", textHash: SOURCE_HASH };
  const response = await app.inject({ method: "POST", url, headers: auth, payload });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json(), { chapterTitle: "Arrival", versionNumber: 7, isCurrentVersion: true,
    text: SOURCE_TEXT, truncated: false });
  store.chapters[0].current_document_version_id = randomUUID();
  const historical = await app.inject({ method: "POST", url, headers: auth, payload });
  assert.equal(historical.json().text, SOURCE_TEXT);
  assert.equal(historical.json().isCurrentVersion, false);
  assert.equal(store.book_bible_items?.length ?? 0, 0);
});

test("Book Bible evidence denies foreign, fabricated and hash-mismatched passages", async (t) => {
  const store = initialStore();
  const app = await appWith(store); t.after(() => app.close());
  const url = `/v1/books/${BOOK}/bible/evidence`;
  const payload = { chapterId: CHAPTER, documentVersionId: VERSION, nodeId: "n1", textHash: SOURCE_HASH };
  assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401);
  for (const [change, status] of [[{ textHash: "a".repeat(64) }, 409], [{ documentVersionId: randomUUID() }, 404],
    [{ chapterId: randomUUID() }, 404], [{ nodeId: "invented" }, 404]] as const) {
    const response = await app.inject({ method: "POST", url, headers: auth, payload: { ...payload, ...change } });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(response.body.includes(SOURCE_TEXT), false);
  }
  store.chapters[0].book_id = OTHER_BOOK;
  assert.equal((await app.inject({ method: "POST", url, headers: auth, payload })).statusCode, 404);
});

test("Book Bible extraction rejects incomplete reading before reserving credits", async (t) => {
  for (const mode of ["large-text", "many-nodes", "missing-version"] as const) {
    const store = initialStore();
    store.workspaces = [{ id: WORKSPACE, organization_id: randomUUID() }];
    store.subscriptions = [{ organization_id: store.workspaces[0].organization_id, status: "active", plan_id: "paid" }];
    store.plans = [{ id: "paid", entitlements_json: { ai_credits_monthly: 2 } }];
    if (mode === "missing-version") store.document_versions = [];
    else store.document_versions[0].content_json = { nodes: mode === "large-text"
      ? [{ id: "n1", type: "paragraph", text: "a".repeat(25000) }]
      : Array.from({ length: 101 }, (_, index) => ({ id: `n${index}`, type: "paragraph", text: "A fact." })) };
    const app = await appWith(store); t.after(() => app.close());
    const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/generate`, headers: auth,
      payload: { idempotencyKey: randomUUID(), chapterIds: [CHAPTER] } });
    assert.equal(response.statusCode, 422, `${mode}: ${response.body}`);
    assert.equal(store.ai_jobs?.length ?? 0, 0);
    assert.equal(store.usage_events?.length ?? 0, 0);
  }
});

test("Book Bible reading plans are free, version-pinned and resume completed long-node batches", async (t) => {
  const store = initialStore();
  const longText = "😀 harbor fact. ".repeat(3000);
  store.document_versions[0].content_json = { nodes: [{ id: "n1", type: "paragraph", text: longText }] };
  let posts = 0;
  const aiFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    posts++;
    const payload = JSON.parse(String(init?.body));
    const node = payload.input.chapters[CHAPTER].nodes[0];
    assert.equal(node.text, longText.slice(node.excerptStart, node.excerptEnd));
    assert.equal(node.textHash, createHash("sha256").update(longText).digest("hex"));
    return Response.json({ jobId: payload.jobId, workspaceId: WORKSPACE, bookId: BOOK,
      agentType: "bookbible", status: "succeeded", provider: "mock", model: "mock-1", usage: { inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
      suggestions: [], diagnostics: [] });
  };
  const app = await appWith(store, undefined, aiFetch); t.after(() => app.close());
  const planUrl = `/v1/books/${BOOK}/bible/reading-plan`;
  assert.equal((await app.inject({ method: "POST", url: planUrl, payload: { chapterIds: [CHAPTER] } })).statusCode, 401);
  const preview = await app.inject({ method: "POST", url: planUrl, headers: auth, payload: { chapterIds: [CHAPTER] } });
  assert.equal(preview.statusCode, 200, preview.body);
  assert.equal(preview.headers["cache-control"], "private, no-store");
  const plan = preview.json(); assert.ok(plan.pages.length > 1);
  assert.equal(store.ai_jobs?.length ?? 0, 0); assert.equal(posts, 0);
  assert.equal(preview.body.includes("harbor fact"), false);
  store.workspaces = [{ id: WORKSPACE, organization_id: randomUUID() }];
  store.subscriptions = [{ organization_id: store.workspaces[0].organization_id, status: "active", plan_id: "paid" }];
  store.plans = [{ id: "paid", entitlements_json: { ai_credits_monthly: 10 } }];
  const request = { idempotencyKey: randomUUID(), chapterIds: [CHAPTER], reading: { fingerprint: plan.fingerprint, pageIndex: 1 } };
  const generateUrl = `/v1/books/${BOOK}/bible/generate`;
  const first = await app.inject({ method: "POST", url: generateUrl, headers: auth, payload: request });
  assert.equal(first.statusCode, 201, first.body);
  store.plans[0].entitlements_json = { ai_credits_monthly: 0 };
  const again = await app.inject({ method: "POST", url: generateUrl, headers: auth, payload: { ...request, idempotencyKey: randomUUID() } });
  assert.equal(again.statusCode, 200, again.body); assert.equal(posts, 1);
  const resumed = await app.inject({ method: "POST", url: planUrl, headers: auth, payload: { chapterIds: [CHAPTER] } });
  assert.equal(resumed.json().pages[1].completedJobId, first.json().job.id);
  store.document_versions[0].content_json = { nodes: [{ id: "n1", type: "paragraph", text: longText + " changed" }] };
  const stale = await app.inject({ method: "POST", url: generateUrl, headers: auth, payload: { ...request, idempotencyKey: randomUUID(), reading: { ...request.reading, pageIndex: 0 } } });
  assert.equal(stale.statusCode, 409, stale.body); assert.equal(posts, 1);
});

test("Book Bible extraction can select a later chapter and includes its complete large node", async (t) => {
  const store = initialStore();
  store.workspaces = [{ id: WORKSPACE, organization_id: randomUUID() }];
  store.subscriptions = [{ organization_id: store.workspaces[0].organization_id, status: "active", plan_id: "paid" }];
  store.plans = [{ id: "paid", entitlements_json: { ai_credits_monthly: 2 } }];
  const laterId = randomUUID(); const laterVersion = randomUUID(); const fullText = "a".repeat(9000);
  store.chapters.push(...Array.from({ length: 2 }, (_, index) => ({ id: randomUUID(), book_id: BOOK, order_index: index + 1 })),
    { id: laterId, book_id: BOOK, order_index: 3, title: "Fourth chapter", current_document_version_id: laterVersion });
  store.document_versions.push({ id: laterVersion, chapter_id: laterId,
    content_json: { nodes: [{ id: "later-node", type: "paragraph", text: fullText }] } });
  const aiFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const input = JSON.parse(String(init?.body));
    assert.deepEqual(input.input.chapterIds, [laterId]);
    assert.equal(input.input.chapters[laterId].nodes[0].text, fullText);
    return Response.json({ jobId: input.jobId, workspaceId: WORKSPACE, bookId: BOOK, agentType: "bookbible",
      status: "succeeded", provider: "mock", model: "mock-1", suggestions: [], diagnostics: [],
      usage: { inputTokens: 2000, outputTokens: 10, estimatedCostUsd: 0 } });
  };
  const app = await appWith(store, undefined, aiFetch); t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/generate`, headers: auth,
    payload: { idempotencyKey: randomUUID(), chapterIds: [laterId] } });
  assert.equal(response.statusCode, 201, response.body);
});

test("Book Bible draft history is book-scoped, review-only, and redacts job input", async (t) => {
  const store = initialStore();
  const candidate = { suggestionKind: "book_bible_candidate", status: "pending", type: "character",
    name: "Elara", description: "A mapmaker", attributes: { eyes: "silver" }, confidence: 0.8,
    sourceRefs: [{ chapterId: CHAPTER, documentVersionId: VERSION, nodeId: "n1", textHash: SOURCE_HASH }] };
  const job = { id: randomUUID(), book_id: BOOK, agent_type: "bookbible", status: "succeeded",
    created_by: USER, created_at: TIME, input_ref: { secret: "private manuscript" }, output_ref: { candidates: [candidate] } };
  store.ai_jobs = [job, { ...job, id: randomUUID(), book_id: OTHER_BOOK },
    { ...job, id: randomUUID(), status: "running" },
    { ...job, id: randomUUID(), output_ref: { candidates: [{ bad: true }] } }];
  const app = await appWith(store); t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/bible/drafts`, headers: auth });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json(), { drafts: [{ id: job.id, createdAt: TIME, candidates: [candidate] }],
    pending: [{ id: store.ai_jobs[2].id, createdAt: TIME, status: "running" }] });
  assert.equal(response.body.includes("private manuscript"), false);
  assert.equal(store.book_bible_items?.length ?? 0, 0);
});

test("Book Bible generation rejects unpaid access before any provider dispatch", async (t) => {
  const store = initialStore();
  store.workspaces = [{ id: WORKSPACE, organization_id: randomUUID() }];
  const app = await appWith(store); t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/generate`, headers: auth,
    payload: { idempotencyKey: randomUUID(), chapterIds: [CHAPTER] } });
  assert.equal(response.statusCode, 422, response.body);
  assert.equal(response.json().error.code, "quota_exceeded");
  assert.equal(store.ai_jobs?.length ?? 0, 0);
});

test("Book Bible recovery never dispatches a second generation when result is unavailable", async (t) => {
  const store = initialStore();
  const job = { id: randomUUID(), book_id: BOOK, workspace_id: WORKSPACE,
    agent_type: "bookbible", status: "running", created_by: USER, created_at: TIME,
    input_ref: { contextSources: [{ chapterId: CHAPTER, documentVersionId: VERSION, nodeId: "n1", textHash: SOURCE_HASH }] } };
  store.ai_jobs = [job];
  const app = await appWith(store); t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/jobs/${job.id}/recover`, headers: auth });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(store.ai_jobs[0].status, "running");
  assert.equal(store.book_bible_items?.length ?? 0, 0);
});

test("paid Book Bible generation stores a cited review draft, replays by key, and never writes canon", async (t) => {
  const store = initialStore();
  store.workspaces = [{ id: WORKSPACE, organization_id: randomUUID() }];
  store.subscriptions = [{ organization_id: store.workspaces[0].organization_id, status: "active", plan_id: "paid" }];
  store.plans = [{ id: "paid", entitlements_json: { ai_credits_monthly: 2 } }];
  let posts = 0;
  const aiFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    assert.equal(init?.method, "POST"); posts++;
    const payload = JSON.parse(String(init.body));
    assert.equal(payload.agentType, "bookbible");
    assert.equal(payload.maxOutputTokens, 6000);
    assert.equal(payload.input.chapters[CHAPTER].nodes[0].text, SOURCE_TEXT);
    assert.equal(payload.input.chapters[CHAPTER].nodes[0].textHash, SOURCE_HASH);
    const result = { jobId: payload.jobId, workspaceId: WORKSPACE, bookId: BOOK, agentType: "bookbible",
      status: "succeeded", provider: "mock", model: "mock-1", usage: { inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0 },
      diagnostics: [], suggestions: [{ suggestionKind: "book_bible_candidate", status: "pending", type: "character",
        name: "Elara", description: "A mapmaker", attributes: { eyes: "silver" }, confidence: 0.8,
        sourceRefs: [{ chapterId: CHAPTER, documentVersionId: VERSION, nodeId: "n1", textHash: SOURCE_HASH }] }] };
    return Response.json(result);
  };
  const app = await appWith(store, undefined, aiFetch); t.after(() => app.close());
  const payload = { idempotencyKey: randomUUID(), chapterIds: [CHAPTER] };
  const url = `/v1/books/${BOOK}/bible/generate`;
  const first = await app.inject({ method: "POST", url, headers: auth, payload });
  assert.equal(first.statusCode, 201, first.body);
  assert.equal(first.json().candidates[0].name, "Elara");
  assert.equal(posts, 1);
  assert.equal(store.book_bible_items?.length ?? 0, 0);
  assert.equal(store.usage_events?.length, 1);
  assert.equal(JSON.stringify(store.ai_jobs?.[0].input_ref).includes(SOURCE_TEXT), false);
  const replay = await app.inject({ method: "POST", url, headers: auth, payload });
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(posts, 1);
  assert.equal(store.usage_events?.length, 1);
  const changed = await app.inject({ method: "POST", url, headers: auth,
    payload: { ...payload, maxTokens: 16000 } });
  assert.equal(changed.statusCode, 409);
});

test("lost Book Bible reply recovers its saved result without another paid POST", async (t) => {
  const store = initialStore();
  store.workspaces = [{ id: WORKSPACE, organization_id: randomUUID() }];
  store.subscriptions = [{ organization_id: store.workspaces[0].organization_id, status: "active", plan_id: "paid" }];
  store.plans = [{ id: "paid", entitlements_json: { ai_credits_monthly: 2 } }];
  let saved: Record<string, unknown> | null = null;
  let posts = 0;
  const aiFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts++;
      const input = JSON.parse(String(init.body));
      saved = { jobId: input.jobId, workspaceId: WORKSPACE, bookId: BOOK, agentType: "bookbible",
        status: "succeeded", provider: "mock", model: "mock-1", usage: { inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0 },
        diagnostics: [], suggestions: [] };
      throw new Error("reply lost after result was saved");
    }
    assert.equal(init?.method, "GET");
    return Response.json(saved);
  };
  const app = await appWith(store, undefined, aiFetch); t.after(() => app.close());
  const key = randomUUID();
  const url = `/v1/books/${BOOK}/bible/generate`;
  const first = await app.inject({ method: "POST", url, headers: auth,
    payload: { idempotencyKey: key, chapterIds: [CHAPTER] } });
  assert.equal(first.statusCode, 503, first.body);
  assert.equal(store.ai_jobs[0].status, "running");
  assert.equal(posts, 1);
  assert.equal(store.usage_events?.length ?? 0, 0);
  const replay = await app.inject({ method: "POST", url, headers: auth,
    payload: { idempotencyKey: key, chapterIds: [CHAPTER] } });
  assert.equal(replay.statusCode, 409);
  assert.equal(posts, 1);
  const recovery = await app.inject({ method: "POST",
    url: `/v1/books/${BOOK}/bible/jobs/${store.ai_jobs[0].id}/recover`, headers: auth });
  assert.equal(recovery.statusCode, 200, recovery.body);
  assert.deepEqual(recovery.json().candidates, []);
  assert.equal(posts, 1);
  assert.equal(store.usage_events.length, 1);
  assert.equal(store.book_bible_items?.length ?? 0, 0);
});

test("Book Bible API holds forged citations without charging or writing canon", async (t) => {
  const store = initialStore();
  store.workspaces = [{ id: WORKSPACE, organization_id: randomUUID() }];
  store.subscriptions = [{ organization_id: store.workspaces[0].organization_id, status: "active", plan_id: "paid" }];
  store.plans = [{ id: "paid", entitlements_json: { ai_credits_monthly: 2 } }];
  const aiFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    return Response.json({ jobId: payload.jobId, workspaceId: WORKSPACE, bookId: BOOK, agentType: "bookbible",
      status: "succeeded", provider: "mock", model: "mock-1", usage: { inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0 },
      diagnostics: [], suggestions: [{ suggestionKind: "book_bible_candidate", status: "pending", type: "character",
        name: "Invented", description: "Unsupported", attributes: {}, confidence: 0.5,
        sourceRefs: [{ chapterId: CHAPTER, documentVersionId: VERSION, nodeId: "n1", textHash: "a".repeat(64) }] }] });
  };
  const app = await appWith(store, undefined, aiFetch); t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/generate`, headers: auth,
    payload: { idempotencyKey: randomUUID(), chapterIds: [CHAPTER] } });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(store.ai_jobs[0].status, "running");
  assert.equal(store.usage_events?.length ?? 0, 0);
  assert.equal(store.book_bible_items?.length ?? 0, 0);
});

test("a saved, definite Book Bible AI failure releases its slot without charging", async (t) => {
  const store = initialStore();
  store.workspaces = [{ id: WORKSPACE, organization_id: randomUUID() }];
  store.subscriptions = [{ organization_id: store.workspaces[0].organization_id, status: "active", plan_id: "paid" }];
  store.plans = [{ id: "paid", entitlements_json: { ai_credits_monthly: 2 } }];
  const aiFetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const payload = JSON.parse(String(init?.body));
    return Response.json({ jobId: payload.jobId, workspaceId: WORKSPACE, bookId: BOOK, agentType: "bookbible",
      status: "failed", provider: "mock", model: "mock-1", usage: { inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0 },
      diagnostics: [], suggestions: [], error: "validation failed" });
  };
  const app = await appWith(store, undefined, aiFetch); t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/generate`, headers: auth,
    payload: { idempotencyKey: randomUUID(), chapterIds: [CHAPTER] } });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(store.ai_jobs[0].status, "failed");
  assert.equal(store.usage_events?.length ?? 0, 0);
  assert.equal(store.book_bible_items?.length ?? 0, 0);
});

test("saved metadata drafts recover across fresh app instances without leaking job inputs", async (t) => {
  const store = initialStore();
  const candidate = { suggestionKind: "metadata_candidate", description: "A mapmaker discovers a hidden world beyond the familiar shore.",
    keywords: ["fantasy"], categories: ["Fiction"], audience: "Adults", rationale: "Based on the opening scene", confidence: 0.8,
    sourceRefs: [{ chapterId: CHAPTER, nodeId: "p1" }], status: "pending" };
  const job = { id: randomUUID(), book_id: BOOK, agent_type: "metadata", status: "succeeded", created_at: TIME,
    input_ref: { secret: "private instructions" }, idempotency_key: "private-key", output_ref: { candidate, diagnostics: "private diagnostics" } };
  store.ai_jobs = [job, { ...job, id: randomUUID(), book_id: OTHER_BOOK }, { ...job, id: randomUUID(), agent_type: "writer" },
    { ...job, id: randomUUID(), status: "running" }, { ...job, id: randomUUID(), output_ref: { candidate: {} } }];
  for (let attempt = 0; attempt < 2; attempt++) {
    const app = await appWith(store); t.after(() => app.close());
    const response = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/metadata/drafts`, headers: auth });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(response.json(), { pending: [], drafts: [{ id: job.id, createdAt: TIME, candidate }] });
    assert.equal(response.body.includes("private"), false);
  }
  assert.equal(store.ai_jobs.length, 5);
});

test("metadata history requires authentication and membership and reports database failure", async (t) => {
  const store = initialStore(); store.workspace_members[0].status = "suspended";
  const app = await appWith(store); t.after(() => app.close());
  const url = `/v1/books/${BOOK}/metadata/drafts`;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url, headers: auth })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${OTHER_BOOK}/metadata/drafts`, headers: auth })).statusCode, 404);
  const failing = await appWith(initialStore(), "ai_jobs"); t.after(() => failing.close());
  assert.equal((await failing.inject({ method: "GET", url, headers: auth })).statusCode, 500);
});

test("pending metadata status is scoped to this author and book without exposing inputs", async (t) => {
  const store = initialStore();
  const job = { id: randomUUID(), book_id: BOOK, agent_type: "metadata", status: "running", created_by: USER,
    created_at: TIME, input_ref: { secret: "private" }, idempotency_key: "private-key" };
  store.ai_jobs = [job, { ...job, id: randomUUID(), created_by: randomUUID() },
    { ...job, id: randomUUID(), book_id: OTHER_BOOK }, { ...job, id: randomUUID(), agent_type: "writer" },
    { ...job, id: randomUUID(), status: "failed" }];
  const app = await appWith(store); t.after(() => app.close());
  const read = () => app.inject({ method: "GET", url: `/v1/books/${BOOK}/metadata/drafts`, headers: auth });
  const response = await read();
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { drafts: [], pending: [{ id: job.id, createdAt: TIME, status: "running" }] });
  assert.equal(response.body.includes("private"), false);
  job.status = "failed";
  assert.deepEqual((await read()).json().pending, []);
});

test("book memory requires authentication and active workspace membership", async (t) => {
  const store = initialStore(); store.workspace_members[0].status = "suspended";
  const app = await appWith(store); t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory` })).statusCode, 401);
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth })).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${OTHER_BOOK}/memory`, headers: auth })).statusCode, 404);
});

test("created memory persists across requests and a fresh app instance", async (t) => {
  const store = initialStore();
  const app = await appWith(store); t.after(() => app.close());
  const created = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
  assert.equal(created.statusCode, 201, created.body);
  const item = created.json().item;
  assert.equal(item.book_id, BOOK);
  assert.deepEqual(item.attributes_json, { appearance: "Silver hair", imageAssetIds: [IMAGE] });
  assert.deepEqual(item.source_refs_json, entry.sourceRefs);
  const reopened = await appWith(store); t.after(() => reopened.close());
  const loaded = await reopened.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth });
  assert.equal(loaded.statusCode, 200, loaded.body);
  assert.equal(loaded.json().items[0].id, item.id);
  assert.equal(loaded.json().canEdit, true);
});

test("existing AI candidate types, nested attributes and node references round-trip", async (t) => {
  const app = await appWith(initialStore()); t.after(() => app.close());
  const payload = { ...entry, type: "place", attributes: { palette: ["blue", "silver"], climate: { season: "winter" } }, sourceRefs: [{ chapterId: CHAPTER, nodeId: "n1", textHash: SOURCE_HASH }] };
  const created = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload });
  assert.equal(created.statusCode, 201, created.body);
  assert.deepEqual(created.json().item.source_refs_json, [{ ...payload.sourceRefs[0], documentVersionId: VERSION }]);
  assert.deepEqual(created.json().item.attributes_json.palette, ["blue", "silver"]);
});

test("node-level Bible evidence is pinned to a saved version and rejects invented or stale citations", async (t) => {
  const store = initialStore(); const app = await appWith(store); t.after(() => app.close());
  const url = `/v1/books/${BOOK}/bible`;
  const valid = { ...entry, sourceRefs: [{ chapterId: CHAPTER, nodeId: "n1" }] };
  const saved = await app.inject({ method: "POST", url, headers: auth, payload: valid });
  assert.equal(saved.statusCode, 201, saved.body);
  assert.deepEqual(saved.json().item.source_refs_json, [{ chapterId: CHAPTER, nodeId: "n1", documentVersionId: VERSION, textHash: SOURCE_HASH }]);
  for (const sourceRefs of [
    [{ chapterId: CHAPTER, nodeId: "invented" }],
    [{ chapterId: CHAPTER, nodeId: "n1", textHash: "0".repeat(64) }],
    [{ chapterId: CHAPTER, textHash: SOURCE_HASH }],
    [{ chapterId: CHAPTER, documentVersionId: randomUUID(), nodeId: "n1" }],
  ]) {
    const rejected = await app.inject({ method: "POST", url, headers: auth, payload: { ...entry, sourceRefs } });
    assert.equal(rejected.statusCode, 422, rejected.body);
  }
  assert.equal(store.book_bible_items.length, 1);
  store.chapters[0].current_document_version_id = null;
  assert.equal((await app.inject({ method: "POST", url, headers: auth, payload: valid })).statusCode, 422);
});

test("pinned Bible evidence remains editable after the current chapter version changes", async (t) => {
  const store = initialStore(); const app = await appWith(store); t.after(() => app.close());
  const url = `/v1/books/${BOOK}/bible`;
  const created = await app.inject({ method: "POST", url, headers: auth,
    payload: { ...entry, sourceRefs: [{ chapterId: CHAPTER, nodeId: "n1" }] } });
  assert.equal(created.statusCode, 201, created.body);
  const saved = created.json().item;
  store.chapters[0].current_document_version_id = randomUUID();
  const updated = await app.inject({ method: "PUT", url: `${url}/${saved.id}`, headers: auth,
    payload: { ...entry, name: "Elara the mapmaker", sourceRefs: saved.source_refs_json, expectedUpdatedAt: saved.updated_at } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().item.source_refs_json, saved.source_refs_json);
  const stale = await app.inject({ method: "PUT", url: `${url}/${saved.id}`, headers: auth,
    payload: { ...entry, sourceRefs: [{ ...saved.source_refs_json[0], textHash: "0".repeat(64) }], expectedUpdatedAt: updated.json().item.updated_at } });
  assert.equal(stale.statusCode, 422, stale.body);
  assert.equal(store.book_bible_items[0].name, "Elara the mapmaker");
});

test("viewer can read saved memory but cannot create, replace, delete or edit metadata", async (t) => {
  const store = initialStore("viewer"); const app = await appWith(store); t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth })).json().canEdit, false);
  const calls = [
    { method: "POST" as const, url: `/v1/books/${BOOK}/bible`, payload: entry },
    { method: "PUT" as const, url: `/v1/books/${BOOK}/bible/${IMAGE}`, payload: { ...entry, expectedUpdatedAt: TIME } },
    { method: "DELETE" as const, url: `/v1/books/${BOOK}/bible/${IMAGE}`, payload: { expectedUpdatedAt: TIME } },
    { method: "PUT" as const, url: `/v1/books/${BOOK}/metadata`, payload: { expectedUpdatedAt: null, description: "New description" } },
  ];
  for (const call of calls) assert.equal((await app.inject({ ...call, headers: auth })).statusCode, 403);
  assert.equal(store.book_bible_items?.length ?? 0, 0);
  assert.equal(store.book_metadata?.length ?? 0, 0);
});

test("Bible rejects cross-workspace, incomplete and non-image references", async (t) => {
  for (const patch of [{ workspace_id: "foreign" }, { checksum: "pending" }, { mime_type: "application/pdf" }, { deleted_at: TIME }]) {
    const store = initialStore(); Object.assign(store.assets[0], patch);
    const app = await appWith(store); t.after(() => app.close());
    const res = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
    assert.equal(res.statusCode, 422, res.body);
    assert.equal(store.book_bible_items?.length ?? 0, 0);
  }
});

test("Bible rejects foreign chapter and mismatched document-version citations", async (t) => {
  for (const table of ["chapters", "document_versions"]) {
    const store = initialStore();
    Object.assign(store[table][0], table === "chapters" ? { book_id: OTHER_BOOK } : { chapter_id: OTHER_BOOK });
    const app = await appWith(store); t.after(() => app.close());
    const res = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
    assert.equal(res.statusCode, 422, res.body);
  }
});

test("memory picker and writes reject quarantined or mismatched current image versions", async (t) => {
  for (const patch of [{ scan_status: "pending" }, { scan_status: "infected" }, { scan_status: "error" },
    { scan_status: null }, { checksum: "b".repeat(64) }, { storage_path: "private/old.png" },
    { size_bytes: 101 }, { mime_type: "image/jpeg" }, { asset_id: OTHER_BOOK }]) {
    const store = initialStore(); Object.assign(store.asset_versions[0], patch);
    const app = await appWith(store); t.after(() => app.close());
    const loaded = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth });
    assert.equal(loaded.statusCode, 200, loaded.body);
    assert.deepEqual(loaded.json().imageAssets, [], JSON.stringify(patch));
    const save = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
    assert.equal(save.statusCode, 422, save.body);
    assert.equal(store.book_bible_items?.length ?? 0, 0);
  }
});

test("reference clearance is rechecked on save without deleting historical memory links", async (t) => {
  const store = initialStore(); store.asset_versions[0].scan_status = "trusted_generated";
  const app = await appWith(store); t.after(() => app.close());
  const read = () => app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth });
  const initial = await read();
  assert.equal(initial.json().imageAssets.length, 1);
  assert.equal(initial.body.includes("private/image.png"), false);
  const saved = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
  assert.equal(saved.statusCode, 201, saved.body);
  const item = saved.json().item;
  store.asset_versions[0].scan_status = "infected";
  const changed = await read();
  assert.deepEqual(changed.json().imageAssets, []);
  assert.deepEqual(changed.json().items[0].attributes_json.imageAssetIds, [IMAGE]);
  const url = `/v1/books/${BOOK}/bible/${item.id}`;
  const payload = { ...entry, expectedUpdatedAt: item.updated_at };
  assert.equal((await app.inject({ method: "PUT", url, headers: auth, payload })).statusCode, 422);
  assert.equal((await app.inject({ method: "PUT", url, headers: auth, payload: { ...payload, imageAssetIds: [] } })).statusCode, 200);
  assert.equal(store.assets.length, 1);
});

test("missing versions hide images and clearance lookup errors fail closed", async (t) => {
  const store = initialStore(); store.asset_versions = [];
  const app = await appWith(store); t.after(() => app.close());
  assert.deepEqual((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth })).json().imageAssets, []);
  assert.equal((await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry })).statusCode, 422);
  const failedStore = initialStore();
  const failed = await appWith(failedStore, "asset_versions"); t.after(() => failed.close());
  for (const call of [{ method: "GET" as const, url: `/v1/books/${BOOK}/memory` },
    { method: "POST" as const, url: `/v1/books/${BOOK}/bible`, payload: entry }]) {
    const result = await failed.inject({ ...call, headers: auth });
    assert.equal(result.statusCode, 500, result.body);
    assert.equal(result.body.includes("deliberate database failure"), false);
  }
  assert.equal(failedStore.book_bible_items?.length ?? 0, 0);
});

test("Bible update and delete scope by book and prevent stale overwrites", async (t) => {
  const store = initialStore(); const app = await appWith(store); t.after(() => app.close());
  const create = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
  const item = create.json().item;
  const url = `/v1/books/${BOOK}/bible/${item.id}`;
  const update = await app.inject({ method: "PUT", url, headers: auth, payload: { ...entry, name: "Elara Vale", expectedUpdatedAt: item.updated_at } });
  assert.equal(update.statusCode, 200, update.body);
  assert.equal(update.json().item.name, "Elara Vale");
  assert.notEqual(update.json().item.updated_at, item.updated_at);
  assert.equal((await app.inject({ method: "PUT", url, headers: auth, payload: { ...entry, name: "Stale", expectedUpdatedAt: item.updated_at } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url, headers: auth, payload: { expectedUpdatedAt: item.updated_at } })).statusCode, 409);
  store.books.push({ id: OTHER_BOOK, workspace_id: WORKSPACE });
  assert.equal((await app.inject({ method: "DELETE", url: `/v1/books/${OTHER_BOOK}/bible/${item.id}`, headers: auth, payload: { expectedUpdatedAt: update.json().item.updated_at } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url, headers: auth, payload: { expectedUpdatedAt: update.json().item.updated_at } })).statusCode, 200);
  assert.equal(store.book_bible_items.length, 0);
  assert.equal(store.assets.length, 1);
  assert.equal(store.chapters.length, 1);
});

test("metadata insert and update preserve contributors and reject stale writes", async (t) => {
  const store = initialStore(); const app = await appWith(store); t.after(() => app.close());
  const url = `/v1/books/${BOOK}/metadata`;
  const payload = { expectedUpdatedAt: null, description: "A journey home.", keywords: ["fiction", "fiction"], categories: ["Fiction / Fantasy"], isbn13: "9780306406157", edition: "First", publicationDate: "2026-09-01" };
  const saved = await app.inject({ method: "PUT", url, headers: auth, payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.deepEqual(saved.json().metadata.keywords, ["fiction"]);
  assert.equal((await app.inject({ method: "PUT", url, headers: auth, payload })).statusCode, 409);
  store.book_metadata[0].contributors = [{ name: "Beth", role: "illustrator" }];
  const updated = await app.inject({ method: "PUT", url, headers: auth, payload: { ...payload, expectedUpdatedAt: saved.json().metadata.updated_at, description: "New description." } });
  assert.equal(updated.statusCode, 200, updated.body);
  assert.deepEqual(updated.json().metadata.contributors, [{ name: "Beth", role: "illustrator" }]);
  assert.equal((await app.inject({ method: "PUT", url, headers: auth, payload: { ...payload, expectedUpdatedAt: saved.json().metadata.updated_at } })).statusCode, 409);
  const loaded = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth });
  assert.equal(loaded.json().metadata.description, "New description.");
});

test("invalid input and unknown fields never mutate records", async (t) => {
  const store = initialStore(); const app = await appWith(store); t.after(() => app.close());
  const invalidEntries = [{ ...entry, name: "   " }, { ...entry, book_id: OTHER_BOOK }, { ...entry, attributes: { imageAssetIds: [OTHER_BOOK] } }, { ...entry, sourceRefs: [{ chapterId: "invalid" }] }];
  for (const payload of invalidEntries) assert.equal((await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload })).statusCode, 422);
  for (const payload of [{ expectedUpdatedAt: null, publicationDate: "2026-02-30" }, { expectedUpdatedAt: null, isbn13: "9780306406158" }, { description: "No concurrency token" }, { expectedUpdatedAt: null, title: "wrong table" }]) {
    assert.equal((await app.inject({ method: "PUT", url: `/v1/books/${BOOK}/metadata`, headers: auth, payload })).statusCode, 422);
  }
  assert.equal(store.book_metadata?.length ?? 0, 0);
  assert.equal(store.book_bible_items?.length ?? 0, 0);
});

test("database failures return errors without claiming saved data", async (t) => {
  const store = initialStore(); const app = await appWith(store, "book_bible_items"); t.after(() => app.close());
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/memory`, headers: auth })).statusCode, 500);
  const res = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers: auth, payload: entry });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.includes("deliberate database failure"), false);
});
