import test from "node:test";
import assert from "node:assert/strict";
import { ApiClientError, createClient, type BookBibleMutationBody } from "@bookworm/api-client";

const BOOK = "b1000000-0000-4000-8000-000000000001", ITEM = "b1000000-0000-4000-8000-000000000002", REQUEST = "b1000000-0000-4000-8000-000000000003", ACTOR = "b1000000-0000-4000-8000-000000000004";
const intent: BookBibleMutationBody = { requestId: REQUEST, type: "character", name: "Elara", attributes: { role: "Mapmaker" }, sourceRefs: [{ chapterId: ITEM, nodeId: "original" }] };
test("Book Bible SDK preserves durable request identity and exact write/recovery endpoints", async () => {
  const original = globalThis.fetch; const requests: { url: string; method: string; body: unknown; key: string | null; actor: string | null }[] = [];
  globalThis.fetch = async (input, options) => {
    requests.push({ url: String(input), method: String(options?.method), body: options?.body ? JSON.parse(String(options.body)) : undefined,
      key: new Headers(options?.headers).get("idempotency-key"), actor: new Headers(options?.headers).get("x-bookworm-actor") });
    const isClosure = String(input).endsWith("/close");
    return Response.json({ receipt: null, disposition: null, item: null, replayed: false, closed: isClosure,
      closure: isClosure ? { requestId: REQUEST, bookId: BOOK, closedAt: "2026-10-13T08:00:00.000Z" } : null });
  };
  try {
    const api = createClient({ baseUrl: "https://api.example.test", idempotencyKey: () => { throw new Error("Bible requests must not mint another retry identity"); } });
    await api.createBookBibleItem(BOOK, intent, ACTOR);
    await api.updateBookBibleItem(BOOK, ITEM, { ...intent, expectedUpdatedAt: "2026-10-13T08:00:00.000Z", expectedIncarnationId: ITEM }, ACTOR);
    await api.deleteBookBibleItem(BOOK, ITEM, { requestId: REQUEST, expectedUpdatedAt: "2026-10-13T08:00:00.000Z", expectedIncarnationId: ITEM }, ACTOR);
    await api.recoverBookBibleMutation(BOOK, REQUEST, ACTOR);
    const closed = await api.closeBookBibleMutation(BOOK, REQUEST, ACTOR);
    assert.equal(closed.closed, true); assert.deepEqual(closed.closure, { requestId: REQUEST, bookId: BOOK, closedAt: "2026-10-13T08:00:00.000Z" });
    assert.deepEqual(requests.map(request => [request.method, request.url]), [
      ["POST", `https://api.example.test/v1/books/${BOOK}/bible`], ["PUT", `https://api.example.test/v1/books/${BOOK}/bible/${ITEM}`],
      ["DELETE", `https://api.example.test/v1/books/${BOOK}/bible/${ITEM}`], ["GET", `https://api.example.test/v1/books/${BOOK}/bible/requests/${REQUEST}`],
      ["POST", `https://api.example.test/v1/books/${BOOK}/bible/requests/${REQUEST}/close`],
    ]);
    assert.deepEqual(requests[0].body, intent); assert.equal(requests[3].body, undefined); assert.deepEqual(requests[4].body, {}); assert.ok(requests.every(request => request.key === null && request.actor === ACTOR));
    assert.deepEqual(requests[1].body, { ...intent, expectedUpdatedAt: "2026-10-13T08:00:00.000Z", expectedIncarnationId: ITEM });
    assert.deepEqual(requests[2].body, { requestId: REQUEST, expectedUpdatedAt: "2026-10-13T08:00:00.000Z", expectedIncarnationId: ITEM });
  } finally { globalThis.fetch = original; }
});
for (const failure of ["lost-reply", "503", "invalid-json"]) test(`Book Bible SDK never automatically replays ${failure}`, async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; if (failure === "lost-reply") throw new TypeError("Reply lost after commitment");
    return failure === "503" ? Response.json({ error: { code: "unavailable", message: "Recover original request", requestId: "trace" } }, { status: 503 }) : new Response("not json"); };
  try { const api = createClient({ baseUrl: "https://api.example.test" });
    for (const operation of [() => api.createBookBibleItem(BOOK, intent, ACTOR), () => api.closeBookBibleMutation(BOOK, REQUEST, ACTOR)]) {
      calls = 0;
      if (failure === "503") await assert.rejects(operation(), ApiClientError);
      else await assert.rejects(operation());
      assert.equal(calls, 1);
    } }
  finally { globalThis.fetch = original; }
});
