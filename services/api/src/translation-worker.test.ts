import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runOneTranslationJob } from "./lib/translation-worker.js";

const JOB = "c6000000-0000-4000-8000-000000000001";
const PROJECT = "c6000000-0000-4000-8000-000000000002";
const TRANSLATION_CHAPTER = "c6000000-0000-4000-8000-000000000003";
const CHAPTER = "c6000000-0000-4000-8000-000000000004";
const DOCUMENT = "c6000000-0000-4000-8000-000000000005";
const WORKSPACE = "c6000000-0000-4000-8000-000000000006";
const LEASE = "c6000000-0000-4000-8000-000000000007";
const source = "A saved chapter for translation.";

function fakeSupabase() {
  const receipts: Record<string, unknown>[] = [];
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "claim_translation_job") return { data: [{ id: JOB, workspace_id: WORKSPACE, lease_token: LEASE, input_ref: {
        translationProjectId: PROJECT, translationChapterId: TRANSLATION_CHAPTER, chapterId: CHAPTER, documentVersionId: DOCUMENT,
        sourceSha256: createHash("sha256").update(source).digest("hex"), sourceLanguage: "en", targetLanguage: "es", creditUnits: 1,
      } }], error: null };
      if (name === "renew_translation_lease") return { data: true, error: null };
      if (name === "complete_translation_chapter") return { data: [{ id: JOB, status: "succeeded" }], error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      let inserted: Record<string, unknown> | null = null; const builder: Record<string, unknown> = {};
      builder.select = () => builder; builder.eq = () => builder;
      builder.maybeSingle = async () => {
        if (table === "translation_completion_receipts") return { data: receipts[0] ?? null, error: null };
        if (table === "translation_projects") return { data: { id: PROJECT, source_language: "en", target_language: "es", status: "running" }, error: null };
        if (table === "document_versions") return { data: { id: DOCUMENT, chapter_id: CHAPTER, plain_text: source }, error: null };
        return { data: null, error: null };
      };
      builder.insert = (value: Record<string, unknown>) => { inserted = value; if (table === "translation_completion_receipts") receipts.push({ ...value }); builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: inserted, error: null }); return builder; };
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: inserted, error: null }); return builder;
    },
  };
  return { client: client as never, receipts, calls };
}

test("translation worker rehydrates pinned text, records a receipt, and completes once", async () => {
  const fake = fakeSupabase(); const inputs: string[] = [];
  const result = await runOneTranslationJob(fake.client, { generator: async (input) => {
    inputs.push(input.text); return { text: "Un capítulo guardado para traducir.", provider: "openai", model: "gpt-6-astra", requestId: "req_translate",
      usage: { inputTokens: 12, outputTokens: 14, estimatedCostUsd: 0.00082, latencyMs: 20 } };
  } });
  assert.deepEqual(result, { status: "succeeded", jobId: JOB });
  assert.deepEqual(inputs, [source]); assert.equal(fake.receipts.length, 1);
  assert.equal(fake.calls.filter((call) => call.name === "complete_translation_chapter").length, 1);
});
