import { test } from "node:test";
import assert from "node:assert/strict";
import { runOneAiReviewJob } from "./lib/ai-review-worker.js";

const USER = "a0000000-0000-4000-8000-000000000001";
const WORKSPACE = "a0000000-0000-4000-8000-000000000003";
const BOOK = "a0000000-0000-4000-8000-000000000004";
const CHAPTER = "a0000000-0000-4000-8000-000000000005";
const JOB = "a0000000-0000-4000-8000-000000000009";
const LEASE = "a0000000-0000-4000-8000-000000000010";
type Row = Record<string, unknown>;

function workerSupabase() {
  const tables: Record<string, Row[]> = {
    books: [{ id: BOOK, workspace_id: WORKSPACE, title: "Novel", author_name: "Author", language: "en" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, title: "One", order_index: 0 }],
    document_versions: [{ chapter_id: CHAPTER, version_number: 1, content_json: { schemaVersion: "1.0", nodes: [{ id: "n1", type: "paragraph", text: "Old text" }] } }],
    style_guides: [], book_bible_items: [], ai_jobs: [],
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
      if (name === "complete_leased_ai_review_job") return { data: { ...claim, status: "succeeded" }, error: null };
      if (name === "fail_ai_review_job") return { data: { ...claim, status: "queued" }, error: null };
      if (name === "renew_ai_review_lease") return { data: true, error: null };
      throw new Error(`unexpected RPC ${name}`);
    },
  } as never;
  return { sb, calls };
}

test("AI review worker rehydrates saved chapter versions only after a fenced claim", async () => {
  const { sb, calls } = workerSupabase(); let request: Row | undefined;
  const outcome = await runOneAiReviewJob(sb, { fetcher: async (_url, init) => {
    request = JSON.parse(String(init?.body)) as Row;
    return Response.json({ status: "succeeded", provider: "mock", model: "mock-1", diagnostics: [], usage: { inputTokens: 8, outputTokens: 3, estimatedCostUsd: 0 }, suggestions: [{ chapterId: CHAPTER, nodeId: "n1", rationale: "Clearer", confidence: 0.9, operation: { operationId: "provider", type: "replace_text", target: { chapterId: CHAPTER, nodeId: "n1" }, payload: { nodeId: "n1", from: 0, to: 3, text: "New" }, expectedVersion: 1 } }] });
  } });
  assert.deepEqual(outcome, { status: "succeeded", jobId: JOB });
  assert.equal(JSON.stringify(request).includes("Old text"), true);
  const completed = calls.find((call) => call.name === "complete_leased_ai_review_job")!;
  assert.equal(completed.args.p_lease_token, LEASE);
  assert.equal((completed.args.p_suggestions as Row[]).length, 1);
});

test("AI review worker keeps retryable provider outages queued without exposing provider text", async () => {
  const { sb, calls } = workerSupabase();
  const outcome = await runOneAiReviewJob(sb, { fetcher: async () => new Response("provider details", { status: 503 }) });
  assert.deepEqual(outcome, { status: "queued", jobId: JOB });
  const failed = calls.find((call) => call.name === "fail_ai_review_job")!;
  assert.equal(failed.args.p_error_code, "ai_service_unavailable");
  assert.equal(failed.args.p_error_message, "AI service unavailable");
  assert.equal(failed.args.p_retryable, true);
});
