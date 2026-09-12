import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runOneAudiobookJob } from "./lib/audiobook-worker.js";

const JOB = "b6000000-0000-4000-8000-000000000001";
const PROJECT = "b6000000-0000-4000-8000-000000000002";
const DOCUMENT = "b6000000-0000-4000-8000-000000000003";
const WORKSPACE = "b6000000-0000-4000-8000-000000000004";
const LEASE = "b6000000-0000-4000-8000-000000000005";
const text = "A saved narration segment.";

function fakeSupabase() {
  const objects = new Map<string, Buffer>();
  const receipts: Record<string, unknown>[] = [];
  const rpcCalls: { name: string; args: Record<string, unknown> }[] = [];
  const client = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args });
      if (name === "claim_audiobook_job") return { data: [{
        id: JOB, workspace_id: WORKSPACE, lease_token: LEASE,
        input_ref: { audiobookProjectId: PROJECT, documentVersionId: DOCUMENT, segmentIndex: 0,
          textStart: 0, textEnd: Array.from(text).length, textSha256: createHash("sha256").update(text).digest("hex"), creditUnits: 1 },
      }], error: null };
      if (name === "renew_audiobook_lease") return { data: true, error: null };
      if (name === "complete_audiobook_segment") return { data: [{ id: JOB, status: "succeeded" }], error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      let inserted: Record<string, unknown> | null = null;
      const builder: Record<string, unknown> = {};
      builder.select = () => builder;
      builder.eq = () => builder;
      builder.maybeSingle = async () => {
        if (table === "audiobook_completion_receipts") return { data: receipts[0] ?? null, error: null };
        if (table === "audiobook_projects") return { data: { id: PROJECT, voice: "marin", instructions: "Warm.", speed: 1, status: "running" }, error: null };
        if (table === "document_versions") return { data: { id: DOCUMENT, plain_text: text }, error: null };
        return { data: null, error: null };
      };
      builder.insert = (value: Record<string, unknown>) => {
        inserted = value;
        if (table === "audiobook_completion_receipts") receipts.push({ ...value });
        builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: inserted, error: null });
        return builder;
      };
      builder.then = (resolve: (value: unknown) => unknown) => resolve({ data: inserted, error: null });
      return builder;
    },
    storage: { from: () => ({
      download: async (path: string) => objects.has(path)
        ? { data: new Blob([new Uint8Array([...objects.get(path)!])]), error: null }
        : { data: null, error: { message: "not found" } },
      upload: async (path: string, bytes: Buffer) => { objects.set(path, bytes); return { data: { path }, error: null }; },
    }) },
  };
  return { client: client as never, objects, receipts, rpcCalls };
}

test("audiobook worker rehydrates pinned text, stores a receipt, and completes once", async () => {
  const fake = fakeSupabase();
  const calls: string[] = [];
  const bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]);
  const result = await runOneAudiobookJob(fake.client, { speechGenerator: async (input) => {
    calls.push(input.text);
    return { bytes, mimeType: "audio/mpeg", provider: "openai", model: "gpt-4o-mini-tts", requestId: "req_1",
      usage: { inputTokens: 7, outputTokens: 80, estimatedCostUsd: 0.000964, latencyMs: 20, inputCharacters: 26, estimationMethod: "word-rate-v1" } };
  } });
  assert.deepEqual(result, { status: "succeeded", jobId: JOB });
  assert.deepEqual(calls, [text]);
  assert.equal(fake.receipts.length, 1);
  assert.equal(fake.objects.size, 1);
  assert.equal(fake.rpcCalls.filter((call) => call.name === "complete_audiobook_segment").length, 1);
});
