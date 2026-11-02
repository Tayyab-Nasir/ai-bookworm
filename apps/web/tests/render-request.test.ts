import { test } from "node:test";
import assert from "node:assert/strict";
import { clearRenderPointer, persistRenderPointer, readRenderPointer, validateRenderStatus, type RenderPointer } from "../lib/render-request";
import { createClient } from "@bookworm/api-client";

const pointer: RenderPointer = { schema: 1, actor: "a0000000-0000-4000-8000-000000000001", bookId: "b0000000-0000-4000-8000-000000000001", editionId: "c0000000-0000-4000-8000-000000000001", requestId: "d0000000-0000-4000-8000-000000000001" };
const jobId = "e0000000-0000-4000-8000-000000000001";
function memory() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
}
test("render recovery persists only the account and request identity and refuses replacement", () => {
  const store = memory(); persistRenderPointer(store, pointer);
  assert.deepEqual(readRenderPointer(store, pointer.actor, pointer.bookId, pointer.editionId), pointer);
  assert.throws(() => persistRenderPointer(store, { ...pointer, requestId: jobId }), /original render/);
  assert.equal(readRenderPointer(store, jobId, pointer.bookId, pointer.editionId), null);
  assert.throws(() => clearRenderPointer(store, { ...pointer, requestId: jobId }), /changed/);
  clearRenderPointer(store, pointer);
  assert.equal(readRenderPointer(store, pointer.actor, pointer.bookId, pointer.editionId), null);
});
test("render status must bind the original request and never treats missing as completed", () => {
  const response = { bookId: pointer.bookId, editionId: pointer.editionId, requestId: pointer.requestId, job: null };
  assert.equal(validateRenderStatus(response, pointer), null);
  assert.deepEqual(validateRenderStatus({ ...response, job: { id: jobId, status: "running" } }, pointer), { id: jobId, status: "running" });
  assert.throws(() => validateRenderStatus({ ...response, requestId: jobId }, pointer), /different request/);
  assert.throws(() => validateRenderStatus({ ...response, job: { id: jobId, status: "unknown" } }, pointer), /could not be verified/);
});
test("storage failure stops dispatch and malformed pointers are never discarded", () => {
  assert.throws(() => persistRenderPointer({ getItem: () => null, setItem: () => { throw new Error("blocked"); } }, pointer), /No render was sent/);
  assert.throws(() => readRenderPointer({ getItem: () => '{"schema":1}' }, pointer.actor, pointer.bookId, pointer.editionId), /retained/);
});

test("scoped client binds the original actor on the render POST", async () => {
  const original = globalThis.fetch;
  let headers: Record<string, string> | undefined;
  globalThis.fetch = async (_input, init) => {
    headers = init?.headers as Record<string, string>;
    return Response.json({ jobId, status: "succeeded", artifacts: [] });
  };
  try {
    const client = createClient({ baseUrl: "/api/backend", expectedActor: pointer.actor });
    await client.renderEdition(pointer.editionId, { idempotencyKey: pointer.requestId });
    assert.equal(headers?.["x-bookworm-actor"], pointer.actor);
  } finally { globalThis.fetch = original; }
});
