import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreateAiJobRequest, AiJobWithSuggestions } from "@bookworm/api-client";
import { retryableAiDraft } from "../lib/ai-draft-request";

const body = (): CreateAiJobRequest => ({ bookId: "book-a", chapterIds: ["chapter-a"], agentType: "writer", userInstruction: "The original brief", idempotencyKey: "original-key", contextPolicy: { maxTokens: 4096 } });
const job = { id: "saved-job", status: "queued" } as AiJobWithSuggestions;

test("lost enqueue response retries the same body and recovers one accepted job", async () => {
  const accepted = new Map<string, AiJobWithSuggestions>();
  const calls: CreateAiJobRequest[] = [];
  const input = body();
  const request = retryableAiDraft(async (value) => {
    calls.push(structuredClone(value));
    if (!accepted.has(value.idempotencyKey)) { accepted.set(value.idempotencyKey, job); throw new Error("Response lost after commit"); }
    return accepted.get(value.idempotencyKey)!;
  }, input);
  await assert.rejects(request.run(), /Response lost/);
  input.userInstruction = "Changed form"; input.chapterIds[0] = "another-chapter";
  assert.equal(await request.run(), job);
  assert.equal(accepted.size, 1);
  assert.deepEqual(calls, [body(), body()]);
  assert.equal(request.chapterId, "chapter-a");
});

test("concurrent retries and repeated success share one request", async () => {
  let calls = 0;
  const request = retryableAiDraft(async () => { calls++; return job; }, body());
  const [first, second] = await Promise.all([request.run(), request.run()]);
  assert.equal(first, second);
  assert.equal(await request.run(), job);
  assert.equal(calls, 1);
});

test("definite failures allow retry without mutation of the original request", async () => {
  let calls = 0;
  const request = retryableAiDraft(async (value) => {
    calls++;
    assert.equal(value.chapterIds[0], "chapter-a");
    value.chapterIds[0] = "transport-mutation";
    if (calls === 1) throw new Error("Service unavailable");
    return job;
  }, body());
  await assert.rejects(request.run(), /Service unavailable/);
  assert.equal(await request.run(), job);
  assert.equal(calls, 2);
});
