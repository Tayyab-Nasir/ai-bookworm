import { test } from "node:test";
import assert from "node:assert/strict";
import { recoverHeldAiReviewReceipt, runOneAiReviewJob } from "./lib/ai-review-worker.js";

const USER = "a0000000-0000-4000-8000-000000000001";
const WORKSPACE = "a0000000-0000-4000-8000-000000000003";
const BOOK = "a0000000-0000-4000-8000-000000000004";
const CHAPTER = "a0000000-0000-4000-8000-000000000005";
const JOB = "a0000000-0000-4000-8000-000000000009";
const LEASE = "a0000000-0000-4000-8000-000000000010";
type Row = Record<string, unknown>;

function workerSupabase(options: { markerReplyLost?: boolean } = {}) {
  const tables: Record<string, Row[]> = {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "Novel", author_name: "Author", language: "en" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, title: "One", order_index: 0 }],
    document_versions: [{ chapter_id: CHAPTER, version_number: 1, content_json: { schemaVersion: "1.0", nodes: [{ id: "n1", type: "paragraph", text: "Old text" }] } }],
    style_guides: [], book_bible_items: [], ai_jobs: [], ai_review_service_receipts: [],
  };
  const claim = { id: JOB, workspace_id: WORKSPACE, book_id: BOOK, created_by: USER, agent_type: "proofreader", lease_token: LEASE,
    input_ref: { chapterVersions: [{ chapterId: CHAPTER, version: 1 }], userInstruction: null, contextPolicy: { includeBookBible: true, includeStyleGuide: true, includeRelatedContext: false, semanticTopK: 5, maxTokens: 4096 } } };
  const calls: { name: string; args: Row }[] = [];
  const sb = {
    from: (table: string) => {
      const filters: [string, unknown][] = []; let ordered = false; let capped: number | undefined;
      const selected = () => { let result = (tables[table] ?? []).filter((value) => filters.every(([key, expected]) => value[key] === expected)); if (ordered) result = [...result]; return capped == null ? result : result.slice(0, capped); };
      const builder: Record<string, unknown> = {};
      builder.select = () => builder; builder.eq = (key: string, value: unknown) => { filters.push([key, value]); return builder; };
      builder.order = () => { ordered = true; return builder; }; builder.limit = (value: number) => { capped = value; return builder; };
      builder.maybeSingle = async () => ({ data: selected()[0] ?? null, error: null });
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: selected(), error: null }); return builder;
    },
    rpc: async (name: string, args: Row) => {
      calls.push({ name, args });
      if (name === "claim_ai_review_job") return { data: [claim], error: null };
      if (name === "claim_ai_review_receipt_recovery") return { data: { ...claim, status: "running" }, error: null };
      if (name === "mark_ai_review_dispatched") return options.markerReplyLost
        ? { data: null, error: { message: "lost reply" } } : { data: true, error: null };
      if (name === "mark_ai_review_outcome_unconfirmed") return { data: { ...claim, status: "running", error_code: "ai_provider_outcome_unconfirmed" }, error: null };
      if (name === "complete_leased_ai_review_job") return { data: { ...claim, status: "succeeded" }, error: null };
      if (name === "fail_ai_review_job") return { data: { ...claim, status: "queued" }, error: null };
      if (name === "renew_ai_review_lease") return { data: true, error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
  } as never;
  return { sb, calls, tables };
}

test("AI review worker rehydrates saved chapter versions only after a fenced claim", async () => {
  const { sb, calls } = workerSupabase(); let request: Row | undefined;
  const outcome = await runOneAiReviewJob(sb, { fetcher: async (_url, init) => {
    request = JSON.parse(String(init?.body)) as Row;
    return Response.json({ jobId: JOB, workspaceId: WORKSPACE, bookId: BOOK, agentType: "proofreader", status: "succeeded", provider: "mock", model: "mock-1", diagnostics: [], usage: { inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0 }, suggestions: [{ chapterId: CHAPTER, nodeId: "n1", rationale: "Clearer", confidence: 0.9, operation: { operationId: "provider", type: "replace_text", target: { chapterId: CHAPTER, nodeId: "n1" }, payload: { nodeId: "n1", from: 0, to: 3, text: "New" }, expectedVersion: 1 } }] });
  } });
  assert.deepEqual(outcome, { status: "succeeded", jobId: JOB });
  assert.equal(JSON.stringify(request).includes("Old text"), true);
  const completed = calls.find((call) => call.name === "complete_leased_ai_review_job")!;
  assert.ok(calls.findIndex((call) => call.name === "mark_ai_review_dispatched") < calls.findIndex((call) => call.name === "complete_leased_ai_review_job"));
  assert.equal(completed.args.p_lease_token, LEASE);
  assert.equal((completed.args.p_suggestions as Row[]).length, 1);
});

test("AI review worker holds an uncertain paid service reply without redispatch or leaking provider text", async () => {
  const { sb, calls } = workerSupabase();
  const outcome = await runOneAiReviewJob(sb, { fetcher: async () => new Response("provider details", { status: 503 }) });
  assert.deepEqual(outcome, { status: "requires_review", jobId: JOB });
  assert.equal(calls.filter((call) => call.name === "mark_ai_review_outcome_unconfirmed").length, 1);
  assert.equal(calls.some((call) => call.name === "fail_ai_review_job"), false);
});

test("AI review worker does not call the provider when the durable dispatch marker reply is lost", async () => {
  const { sb, calls } = workerSupabase({ markerReplyLost: true }); let providerCalls = 0;
  const outcome = await runOneAiReviewJob(sb, { fetcher: async () => { providerCalls++; return new Response("unexpected"); } });
  assert.deepEqual(outcome, { status: "completion_unknown", jobId: JOB });
  assert.equal(providerCalls, 0);
  assert.equal(calls.some((call) => call.name === "fail_ai_review_job"), false);
});

test("AI review worker freezes a lost network reply instead of retrying the provider", async () => {
  const { sb, calls } = workerSupabase(); let providerCalls = 0; let receiptReads = 0;
  const outcome = await runOneAiReviewJob(sb, { fetcher: async (_url, init) => { if (init?.method === "GET") { receiptReads++; return new Response(null, { status: 404 }); } providerCalls++; throw new Error("socket closed"); } });
  assert.deepEqual(outcome, { status: "requires_review", jobId: JOB });
  assert.equal(providerCalls, 1);
  assert.equal(receiptReads, 1);
  assert.equal(calls.some((call) => call.name === "fail_ai_review_job"), false);
});

test("AI review worker settles a saved result after a lost POST reply without regeneration", async () => {
  const { sb, calls } = workerSupabase(); let providerCalls = 0; let receiptReads = 0;
  const outcome = await runOneAiReviewJob(sb, { fetcher: async (_url, init) => {
    if (init?.method === "GET") {
      receiptReads++;
      return Response.json({ jobId: JOB, workspaceId: WORKSPACE, bookId: BOOK, agentType: "proofreader",
        status: "succeeded", provider: "mock", model: "mock-1", diagnostics: [],
        usage: { inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0 }, suggestions: [] });
    }
    providerCalls++; throw new Error("lost reply");
  } });
  assert.deepEqual(outcome, { status: "succeeded", jobId: JOB });
  assert.equal(providerCalls, 1);
  assert.equal(receiptReads, 1);
  assert.equal(calls.filter((call) => call.name === "complete_leased_ai_review_job").length, 1);
  assert.equal(calls.some((call) => call.name === "mark_ai_review_outcome_unconfirmed"), false);
});

test("AI review worker refuses a saved receipt for a different job", async () => {
  const { sb, calls } = workerSupabase();
  const outcome = await runOneAiReviewJob(sb, { fetcher: async (_url, init) => init?.method === "GET"
    ? Response.json({ jobId: "a0000000-0000-4000-8000-000000000099", workspaceId: WORKSPACE, bookId: BOOK,
      agentType: "proofreader", status: "succeeded", provider: "mock", model: "mock-1", diagnostics: [],
      usage: { inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0 }, suggestions: [] })
    : new Response(null, { status: 503 }) });
  assert.deepEqual(outcome, { status: "requires_review", jobId: JOB });
  assert.equal(calls.some((call) => call.name === "complete_leased_ai_review_job"), false);
});

test("operator recovery settles only a saved matching receipt without any provider call", async () => {
  const { sb, calls, tables } = workerSupabase();
  tables.ai_review_service_receipts.push({ job_id: JOB, result_json: {
    jobId: JOB, workspaceId: WORKSPACE, bookId: BOOK, agentType: "proofreader",
    status: "succeeded", provider: "mock", model: "mock-1", diagnostics: [],
    usage: { inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0 }, suggestions: [],
  } });
  const outcome = await recoverHeldAiReviewReceipt(sb, { jobId: JOB, actorId: USER, incidentRef: "INC-REVIEW-123" });
  assert.deepEqual(outcome, { status: "succeeded", jobId: JOB });
  assert.equal(calls.filter((call) => call.name === "complete_leased_ai_review_job").length, 1);
  assert.equal(calls.some((call) => call.name === "mark_ai_review_dispatched"), false);
  assert.deepEqual(calls[0]?.args, { p_job_id: JOB, p_actor_id: USER, p_incident_ref: "INC-REVIEW-123",
    p_receipt_reviewed: true, p_provider_reviewed: true, p_lease_seconds: 300 });
});

test("operator recovery keeps a mismatched saved receipt on hold", async () => {
  const { sb, calls, tables } = workerSupabase();
  tables.ai_review_service_receipts.push({ job_id: JOB, result_json: {
    jobId: "a0000000-0000-4000-8000-000000000099", workspaceId: WORKSPACE, bookId: BOOK,
    agentType: "proofreader", status: "succeeded", provider: "mock", model: "mock-1",
    diagnostics: [], usage: { inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0 }, suggestions: [],
  } });
  const outcome = await recoverHeldAiReviewReceipt(sb, { jobId: JOB, actorId: USER, incidentRef: "INC-REVIEW-123" });
  assert.deepEqual(outcome, { status: "requires_review", jobId: JOB });
  assert.equal(calls.some((call) => call.name === "complete_leased_ai_review_job"), false);
  assert.equal(calls.some((call) => call.name === "mark_ai_review_outcome_unconfirmed"), true);
});
