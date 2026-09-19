import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.AI_SERVICE_URL = "http://ai.test";

const { buildApp } = await import("./app.js");

type Row = Record<string, unknown>;
interface Store { tables: Record<string, Row[]>; rpcCalls: { name: string; args: Row }[]; metadataInsertError?: string }

function fakeSupabase(store: Store) {
  return {
    auth: { getUser: async (token: string) => token === "good"
      ? { data: { user: { id: USER } }, error: null }
      : { data: { user: null }, error: { message: "bad" } } },
    from: (table: string) => {
      const rows = (store.tables[table] ??= []);
      const filters: [string, unknown][] = [];
      let limit: number | null = null;
      let descending = false;
      let pendingInsert: Row | null = null;
      let pendingUpdate: Row | null = null;
      const selected = () => {
        let result = rows.filter((row) => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
        if (descending) result = [...result].reverse();
        return limit == null ? result : result.slice(0, limit);
      };
      const mutate = () => {
        if (pendingInsert) {
          const row = { ...pendingInsert, created_at: pendingInsert.created_at ?? new Date().toISOString() };
          rows.push(row); pendingInsert = null; return [row];
        }
        if (pendingUpdate) {
          const result = selected();
          result.forEach((row) => Object.assign(row, pendingUpdate)); pendingUpdate = null; return result;
        }
        return selected();
      };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = (key: string, value: unknown) => { filters.push([key, value]); return builder; };
      builder.in = (key: string, values: unknown[]) => { filters.push([key, values]); return builder; };
      builder.gte = () => builder;
      builder.order = (_key: string, options?: { ascending?: boolean }) => { descending ||= options?.ascending === false; return builder; };
      builder.limit = (value: number) => { limit = value; return builder; };
      builder.insert = (row: Row) => { pendingInsert = row; return builder; };
      builder.update = (row: Row) => { pendingUpdate = row; return builder; };
      builder.single = async () => {
        if (table === "ai_jobs" && pendingInsert?.agent_type === "metadata" && store.metadataInsertError) {
          pendingInsert = null;
          return { data: null, error: { code: store.metadataInsertError } };
        }
        if (table === "ai_jobs" && pendingInsert?.agent_type === "metadata" && rows.some((row) =>
          row.agent_type === "metadata" && row.book_id === pendingInsert!.book_id && row.created_by === pendingInsert!.created_by
          && ["queued", "running"].includes(String(row.status)))) {
          pendingInsert = null;
          return { data: null, error: { code: "23505" } };
        }
        return { data: mutate()[0] ?? null, error: null };
      };
      builder.maybeSingle = async () => ({ data: mutate()[0] ?? null, error: null });
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: mutate(), error: null });
      return builder;
    },
    rpc: async (name: string, args: Row) => {
      store.rpcCalls.push({ name, args });
      if (name === "search_book_context") return { data: store.tables.search_results ?? [], error: null };
      if (name === "complete_ai_job") {
        const job = store.tables.ai_jobs.find((row) => row.id === args.p_job_id);
        if (!job) return { data: null, error: { code: "P0002" } };
        Object.assign(job, { status: "succeeded", model: args.p_model, usage_json: args.p_usage, completed_at: new Date().toISOString() });
        for (const value of args.p_suggestions as Row[]) store.tables.ai_suggestions.push({
          id: value.id, ai_job_id: job.id, entity_type: value.entityType, entity_id: value.entityId,
          operation_json: value.operation, rationale: value.rationale, confidence: value.confidence, status: "pending",
        });
        return { data: job, error: null };
      }
      if (name === "complete_metadata_ai_job") {
        const job = store.tables.ai_jobs.find((row) => row.id === args.p_job_id);
        if (!job) return { data: null, error: { code: "P0002" } };
        Object.assign(job, {
          status: "succeeded", model: args.p_model, usage_json: args.p_usage,
          output_ref: { candidate: args.p_candidate, diagnostics: args.p_diagnostics, reviewRequired: true, savedMetadataUpdated: false },
          completed_at: new Date().toISOString(),
        });
        return { data: job, error: null };
      }
      if (name === "accept_ai_suggestion") {
        const suggestion = store.tables.ai_suggestions.find((row) => row.id === args.p_suggestion_id);
        if (suggestion) suggestion.status = "accepted";
        return { data: { id: VERSION_2, version_number: 2, content_json: args.p_content_json }, error: null };
      }
      if (name === "reject_ai_suggestion") {
        const suggestion = store.tables.ai_suggestions.find((row) => row.id === args.p_suggestion_id);
        if (!suggestion) return { data: null, error: { code: "P0002" } };
        suggestion.status = "rejected"; return { data: suggestion, error: null };
      }
      return { data: null, error: { code: "42883" } };
    },
  } as never;
}

const USER = "a0000000-0000-4000-8000-000000000001";
const ORG = "a0000000-0000-4000-8000-000000000002";
const WORKSPACE = "a0000000-0000-4000-8000-000000000003";
const BOOK = "a0000000-0000-4000-8000-000000000004";
const CHAPTER = "a0000000-0000-4000-8000-000000000005";
const VERSION_1 = "a0000000-0000-4000-8000-000000000006";
const VERSION_2 = "a0000000-0000-4000-8000-000000000007";
const SUGGESTION = "a0000000-0000-4000-8000-000000000008";
const auth = { authorization: "Bearer good" };

function baseStore(): Store {
  return { rpcCalls: [], tables: {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "Novel", author_name: "Author", language: "en" }],
    workspaces: [{ id: WORKSPACE, organization_id: ORG }],
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role: "editor", status: "active" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, title: "One", order_index: 0, current_document_version_id: VERSION_1 }],
    document_versions: [{ id: VERSION_1, chapter_id: CHAPTER, version_number: 1, content_json: { schemaVersion: "1.0", nodes: [{ id: "n1", type: "paragraph", text: "Old text" }] } }],
    subscriptions: [{ id: "paid-sub", organization_id: ORG, plan_id: "paid-plan", status: "active" }],
    plans: [{ id: "paid-plan", name: "Paid fixture", entitlements_json: { ai_credits_monthly: 100 } }],
    usage_events: [], style_guides: [], book_bible_items: [], book_metadata: [{ book_id: BOOK, description: "Author saved copy" }], ai_jobs: [], ai_suggestions: [],
  } };
}

function metadataResult(sourcePatch: Row = {}) {
  return {
    status: "succeeded", provider: "mock", model: "mock-metadata-1", diagnostics: [],
    usage: { inputTokens: 20, outputTokens: 10, estimatedCostUsd: 0 },
    suggestions: [{
      suggestionKind: "metadata_candidate",
      description: "A novelist follows a difficult path home.",
      keywords: ["literary journey", "homecoming"],
      categories: ["Fiction / Literary"],
      audience: "Adult literary-fiction readers",
      rationale: "Grounded in the cited opening.",
      confidence: 0.88,
      sourceRefs: [{
        chapterId: CHAPTER, documentVersionId: VERSION_1, nodeId: "n1",
        textHash: createHash("sha256").update("Old text").digest("hex"),
        ...sourcePatch,
      }],
      status: "pending",
    }],
  };
}

function aiResult() {
  return {
    status: "succeeded", provider: "mock", model: "mock-1", diagnostics: [],
    usage: { inputTokens: 10, outputTokens: 4, estimatedCostUsd: 0 },
    suggestions: [{
      id: "ignored", chapterId: CHAPTER, nodeId: "n1", rationale: "Clearer wording", confidence: 0.9,
      operation: { operationId: "provider-op", type: "replace_text", target: { chapterId: CHAPTER, nodeId: "n1" }, payload: { nodeId: "n1", from: 0, to: 3, text: "New" }, expectedVersion: 1 },
    }],
  };
}

test("AI review queues private canonical pointers without calling the provider in the HTTP request", async () => {
  const store = baseStore();
  const requests: Row[] = [];
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Row);
    return new Response(JSON.stringify(aiResult()), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const response = await app.inject({ method: "POST", url: "/v1/ai/jobs", headers: auth, payload: {
    bookId: BOOK, chapterIds: [CHAPTER], agentType: "proofreader", idempotencyKey: "request-0001",
  } });
  assert.equal(response.statusCode, 202);
  assert.equal(response.json().status, "queued");
  assert.equal(response.json().suggestions.length, 0);
  assert.equal("input_ref" in response.json(), false);
  assert.equal("idempotency_key" in response.json(), false);
  assert.deepEqual(response.json().chapter_ids, [CHAPTER]);
  assert.equal(requests.length, 0);
  assert.deepEqual((store.tables.ai_jobs[0].input_ref as Row).chapterVersions, [{ chapterId: CHAPTER, version: 1 }]);
  assert.equal(JSON.stringify(store.tables.ai_jobs[0].input_ref).includes("Old text"), false);
  assert.equal(store.rpcCalls.some((call) => call.name === "complete_ai_job"), false);
  assert.equal(store.tables.ai_suggestions.length, 0);
  await app.close();
});

test("AI review history is book-scoped and omits private job input", async () => {
  const store = baseStore();
  store.tables.ai_jobs.push({
    id: "a0000000-0000-4000-8000-000000000010", workspace_id: WORKSPACE, book_id: BOOK,
    agent_type: "writer", status: "succeeded", model: "mock-1", usage_json: { inputTokens: 12, outputTokens: 8 },
    input_ref: { chapterVersions: [{ chapterId: CHAPTER, version: 1 }], userInstruction: "Private drafting instruction", contextSources: [{ id: "private-source" }] },
    idempotency_key: "private-request-key", created_by: USER, created_at: "2026-09-11T00:00:00.000Z", completed_at: "2026-09-11T00:00:01.000Z",
  });
  store.tables.ai_jobs.push({
    id: "a0000000-0000-4000-8000-000000000011", workspace_id: WORKSPACE, book_id: "a0000000-0000-4000-8000-000000000012",
    agent_type: "proofreader", status: "succeeded", input_ref: { chapterVersions: [{ chapterId: CHAPTER, version: 1 }] },
  });
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => new Response() });
  const response = await app.inject({ method: "GET", url: `/v1/ai/jobs?bookId=${BOOK}&limit=8`, headers: auth });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.equal(response.json().jobs.length, 1);
  assert.deepEqual(response.json().jobs[0].chapter_ids, [CHAPTER]);
  assert.equal(response.json().jobs[0].context_source_count, 1);
  assert.equal(JSON.stringify(response.json()).includes("Private drafting instruction"), false);
  assert.equal(JSON.stringify(response.json()).includes("private-request-key"), false);
  await app.close();
});

test("a queued AI review has no provider side effect or credit before the worker claims it", async () => {
  const store = baseStore();
  let called = false;
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => { called = true; return new Response(JSON.stringify(aiResult())); } });
  const response = await app.inject({ method: "POST", url: "/v1/ai/jobs", headers: auth, payload: {
    bookId: BOOK, chapterIds: [CHAPTER], agentType: "proofreader", idempotencyKey: "request-0002",
  } });
  assert.equal(response.statusCode, 202);
  assert.equal(store.tables.ai_jobs[0].status, "queued");
  assert.equal(store.rpcCalls.some((call) => call.name === "complete_ai_job"), false);
  assert.equal(store.tables.usage_events.length, 0);
  await app.close();
});

test("writer receives book-scoped cited context but persists only source identifiers", async () => {
  const store = baseStore();
  store.tables.search_results = [{ id: "chunk", chapter_id: CHAPTER, document_version_id: VERSION_1, text_hash: "hash", excerpt: "Private silver compass passage" }];
  let called = false;
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async (_url, init) => {
    called = true; return new Response(JSON.stringify(aiResult()));
  } });
  const response = await app.inject({ method: "POST", url: "/v1/ai/jobs", headers: auth, payload: {
    bookId: BOOK, chapterIds: [CHAPTER], agentType: "writer", userInstruction: "Continue Elara's silver compass story", idempotencyKey: "writer-retrieval-1",
  } });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(called, false);
  assert.equal(JSON.stringify(store.tables.ai_jobs[0].input_ref).includes("Private silver"), false);
  assert.equal((store.tables.ai_jobs[0].input_ref as Row).userInstruction, "Continue Elara's silver compass story");
  await app.close();
});

test("concurrent metadata keys cannot start a second provider call and completion releases the slot", async (t) => {
  const store = baseStore();
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => {
    calls++; entered(); await gate;
    return new Response(JSON.stringify(metadataResult()));
  } });
  t.after(() => app.close());
  const generate = (key: string) => app.inject({ method: "POST", url: `/v1/books/${BOOK}/metadata/generate`, headers: auth,
    payload: { idempotencyKey: key, chapterIds: [CHAPTER] } });
  const first = generate("concurrent-first").then((response) => response);
  await started;
  try {
    const second = await generate("concurrent-second");
    assert.equal(second.statusCode, 409, second.body);
    assert.equal(second.json().error.details.jobId, store.tables.ai_jobs[0].id);
    assert.equal(second.json().error.details.status, "running");
    assert.equal(calls, 1);
    assert.equal(store.tables.ai_jobs.length, 1);
  } finally { release(); }
  assert.equal((await first).statusCode, 201);
  assert.equal((await generate("concurrent-second")).statusCode, 201);
  assert.equal(calls, 2);
});

test("lost metadata response remains reserved and recovery reads one existing result without regenerating", async (t) => {
  const store = baseStore();
  let receipt: Row | null = null;
  let generationCalls = 0;
  let recoveryCalls = 0;
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async (_url, init) => {
    if (init?.method === "POST") {
      generationCalls++;
      const body = JSON.parse(String(init.body));
      receipt = { ...metadataResult(), jobId: body.jobId, bookId: BOOK, workspaceId: WORKSPACE, agentType: "metadata" };
      throw new Error("Connection lost after provider completion");
    }
    assert.equal(init?.method, "GET"); recoveryCalls++;
    return new Response(JSON.stringify(receipt));
  } });
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/metadata/generate`, headers: auth,
    payload: { idempotencyKey: "lost-result-recovery", chapterIds: [CHAPTER] } });
  assert.equal(response.statusCode, 503);
  const job = store.tables.ai_jobs[0];
  assert.equal(job.status, "running");
  const recover = () => app.inject({ method: "POST", url: `/v1/books/${BOOK}/metadata/jobs/${job.id}/recover`, headers: auth, payload: {} });
  assert.equal((await recover()).statusCode, 200);
  assert.equal(job.status, "succeeded");
  assert.equal((await recover()).statusCode, 200);
  assert.equal(generationCalls, 1);
  assert.equal(recoveryCalls, 1);
  assert.equal(store.rpcCalls.filter((call) => call.name === "complete_metadata_ai_job").length, 1);
  assert.equal(store.tables.book_metadata[0].description, "Author saved copy");
});

test("metadata recovery refuses foreign receipts and never frees an unknown request", async (t) => {
  const store = baseStore();
  const job = { id: VERSION_2, book_id: BOOK, workspace_id: WORKSPACE, created_by: USER, agent_type: "metadata", status: "running",
    input_ref: { contextSources: [{ chapterId: CHAPTER, documentVersionId: VERSION_1, nodeId: "n1", textHash: createHash("sha256").update("Old text").digest("hex") }] } };
  store.tables.ai_jobs.push(job);
  let calls = 0;
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => {
    calls++; return new Response(JSON.stringify({ ...metadataResult(), jobId: job.id, bookId: BOOK, workspaceId: "foreign", agentType: "metadata" }));
  } });
  t.after(() => app.close());
  const url = `/v1/books/${BOOK}/metadata/jobs/${job.id}/recover`;
  assert.equal((await app.inject({ method: "POST", url, headers: auth, payload: {} })).statusCode, 503);
  assert.equal(job.status, "running");
  assert.equal(store.rpcCalls.length, 0);
  job.created_by = "another-user";
  assert.equal((await app.inject({ method: "POST", url, headers: auth, payload: {} })).statusCode, 404);
  assert.equal(calls, 1);
});

test("metadata reservation quota and role failures stop before provider execution", async (t) => {
  for (const [code, status] of [["23514", 422], ["42501", 403]] as const) {
    const store = baseStore(); store.metadataInsertError = code;
    let calls = 0;
    const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => { calls++; return new Response(JSON.stringify(metadataResult())); } });
    t.after(() => app.close());
    const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/metadata/generate`, headers: auth,
      payload: { idempotencyKey: "quota-race-request", chapterIds: [CHAPTER] } });
    assert.equal(response.statusCode, status, response.body);
    assert.equal(calls, 0);
    assert.equal(store.tables.ai_jobs.length, 0);
  }
});

test("metadata generation returns a cited review draft without overwriting saved metadata", async () => {
  const store = baseStore();
  store.tables.book_bible_items.push({
    id: "a0000000-0000-4000-8000-000000000088", book_id: BOOK, type: "character",
    name: "Elara", description: "A determined cartographer", attributes_json: { calling: "mapmaker" }, source_refs_json: [],
  });
  const requests: Row[] = [];
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)) as Row);
    return new Response(JSON.stringify(metadataResult()));
  } });
  const response = await app.inject({
    method: "POST", url: `/v1/books/${BOOK}/metadata/generate`, headers: auth,
    payload: { idempotencyKey: "metadata-request-1", chapterIds: [CHAPTER], audience: "Adults", tone: "Evocative" },
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json().candidate.suggestionKind, "metadata_candidate");
  assert.equal(response.json().candidate.status, "pending");
  assert.equal(store.tables.book_metadata[0].description, "Author saved copy");
  const sent = requests[0];
  assert.equal(sent.agentType, "metadata");
  assert.equal((((sent.input as Row).chapters as Row)[CHAPTER] as Row).nodes instanceof Array, true);
  assert.equal(JSON.stringify(sent).includes("Old text"), true);
  assert.deepEqual((((sent.input as Row).bookBible as Row[])[0].attributes), { calling: "mapmaker" });
  assert.equal(JSON.stringify(store.tables.ai_jobs[0].input_ref).includes("Old text"), false);
  const completion = store.rpcCalls.find((call) => call.name === "complete_metadata_ai_job");
  assert.equal(completion?.args.p_credit_quantity, 0);
  assert.equal((completion?.args.p_candidate as Row).status, "pending");
  assert.equal((store.tables.ai_jobs[0].output_ref as Row).savedMetadataUpdated, false);
  await app.close();
});

test("metadata generation rejects unverifiable citations and does not complete or charge", async () => {
  const store = baseStore();
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => new Response(JSON.stringify(metadataResult({
    textHash: "b".repeat(64),
  }))) });
  const response = await app.inject({
    method: "POST", url: `/v1/books/${BOOK}/metadata/generate`, headers: auth,
    payload: { idempotencyKey: "metadata-request-2", chapterIds: [CHAPTER] },
  });
  assert.equal(response.statusCode, 503, response.body);
  assert.equal(store.tables.ai_jobs[0].status, "failed");
  assert.equal(store.rpcCalls.some((call) => call.name === "complete_metadata_ai_job"), false);
  assert.equal(store.tables.usage_events.length, 0);
  assert.equal(store.tables.book_metadata[0].description, "Author saved copy");
  await app.close();
});

test("viewers cannot invoke metadata generation", async () => {
  const store = baseStore();
  store.tables.workspace_members[0].role = "viewer";
  let called = false;
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => {
    called = true; return new Response(JSON.stringify(metadataResult()));
  } });
  const response = await app.inject({
    method: "POST", url: `/v1/books/${BOOK}/metadata/generate`, headers: auth,
    payload: { idempotencyKey: "metadata-request-3", chapterIds: [CHAPTER] },
  });
  assert.equal(response.statusCode, 403, response.body);
  assert.equal(called, false);
  assert.equal(store.tables.ai_jobs.length, 0);
  await app.close();
});

test("metadata generation replays the same scoped request without another provider call", async () => {
  const store = baseStore();
  const candidate = metadataResult().suggestions[0];
  store.tables.ai_jobs.push({
    id: "a0000000-0000-4000-8000-000000000099", workspace_id: WORKSPACE, book_id: BOOK,
    agent_type: "metadata", created_by: USER, idempotency_key: "metadata-request-replay",
    status: "succeeded", output_ref: { candidate, reviewRequired: true, savedMetadataUpdated: false },
  });
  let called = false;
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => {
    called = true; return new Response(JSON.stringify(metadataResult()));
  } });
  const response = await app.inject({
    method: "POST", url: `/v1/books/${BOOK}/metadata/generate`, headers: auth,
    payload: { idempotencyKey: "metadata-request-replay", chapterIds: [CHAPTER] },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().candidate.description, candidate.description);
  assert.equal(called, false);
  assert.equal(store.tables.ai_jobs.length, 1);
  assert.equal(store.rpcCalls.length, 0);
  await app.close();
});

test("a failed metadata idempotency key requires an explicit fresh key", async () => {
  const store = baseStore();
  store.tables.ai_jobs.push({
    id: "a0000000-0000-4000-8000-000000000098", workspace_id: WORKSPACE, book_id: BOOK,
    agent_type: "metadata", created_by: USER, idempotency_key: "metadata-request-failed",
    status: "failed", error_code: "ai_service_unavailable", output_ref: null,
  });
  let called = false;
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => {
    called = true; return new Response(JSON.stringify(metadataResult()));
  } });
  const response = await app.inject({
    method: "POST", url: `/v1/books/${BOOK}/metadata/generate`, headers: auth,
    payload: { idempotencyKey: "metadata-request-failed", chapterIds: [CHAPTER] },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error.message, /fresh|new request key/i);
  assert.equal(called, false);
  assert.equal(store.tables.ai_jobs.length, 1);
  await app.close();
});

test("an in-flight metadata idempotency key is retained for safe polling", async () => {
  const store = baseStore();
  store.tables.ai_jobs.push({
    id: "a0000000-0000-4000-8000-000000000097", workspace_id: WORKSPACE, book_id: BOOK,
    agent_type: "metadata", created_by: USER, idempotency_key: "metadata-request-running",
    status: "running", output_ref: null,
  });
  let called = false;
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => {
    called = true; return new Response(JSON.stringify(metadataResult()));
  } });
  const response = await app.inject({
    method: "POST", url: `/v1/books/${BOOK}/metadata/generate`, headers: auth,
    payload: { idempotencyKey: "metadata-request-running", chapterIds: [CHAPTER] },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.match(response.json().error.message, /still processing|same request key/i);
  assert.equal(response.json().error.details.status, "running");
  assert.equal(called, false);
  assert.equal(store.tables.ai_jobs.length, 1);
  await app.close();
});

test("applying and rejecting suggestions use durable review RPCs", async () => {
  const store = baseStore();
  const operation = { operationId: `ai:${SUGGESTION}`, type: "replace_text", target: { chapterId: CHAPTER, nodeId: "n1" }, payload: { nodeId: "n1", from: 0, to: 3, text: "New" }, source: "ai", sourceRef: SUGGESTION, expectedVersion: 1 };
  store.tables.ai_suggestions.push({ id: SUGGESTION, status: "pending", entity_id: CHAPTER, operation_json: operation });
  const app = await buildApp(() => fakeSupabase(store), { aiFetch: async () => new Response() });
  const applied = await app.inject({ method: "POST", url: `/v1/ai/suggestions/${SUGGESTION}/apply`, headers: auth });
  assert.equal(applied.statusCode, 200);
  assert.equal(applied.json().version, 2);
  const secondId = "a0000000-0000-4000-8000-000000000009";
  store.tables.ai_suggestions.push({ id: secondId, status: "pending", entity_id: CHAPTER, operation_json: { ...operation, operationId: `ai:${secondId}`, sourceRef: secondId } });
  const rejected = await app.inject({ method: "POST", url: `/v1/ai/suggestions/${secondId}/reject`, headers: auth });
  assert.equal(rejected.statusCode, 200);
  assert.equal(rejected.json().suggestion.status, "rejected");
  assert.deepEqual(store.rpcCalls.map((call) => call.name), ["accept_ai_suggestion", "reject_ai_suggestion"]);
  await app.close();
});
