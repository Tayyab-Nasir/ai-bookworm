import test from "node:test";
import assert from "node:assert/strict";
import { createClient } from "@bookworm/api-client";
import { forgetCommunityJoin, readCommunityJoin, rememberCommunityJoin, type CommunityJoinMarker } from "../lib/community-join-recovery";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const COMMUNITY = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";
const NEXT = "55555555-5555-4555-8555-555555555555";
const marker: CommunityJoinMarker = { version: 1, communityId: COMMUNITY, operationId: OPERATION };

function memoryStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); } };
}

test("community recovery stores one opaque actor-scoped identity and never clears a newer one", () => {
  const storage = memoryStorage();
  rememberCommunityJoin(storage, ACTOR, marker);
  assert.deepEqual(readCommunityJoin(storage, ACTOR), marker);
  assert.equal(readCommunityJoin(storage, OTHER), null);
  assert.doesNotMatch([...storage.values.values()][0], /token|email|name/i);
  assert.throws(() => rememberCommunityJoin(storage, ACTOR, { ...marker, operationId: NEXT }));
  assert.equal(forgetCommunityJoin(storage, ACTOR, { ...marker, operationId: NEXT }), false);
  assert.deepEqual(readCommunityJoin(storage, ACTOR), marker);
  assert.equal(forgetCommunityJoin(storage, ACTOR, marker), true);
  assert.equal(readCommunityJoin(storage, ACTOR), null);
  storage.values.set(`bookworm:community-join:v1:${ACTOR}`, JSON.stringify({ ...marker, token: "not-allowed" }));
  assert.throws(() => readCommunityJoin(storage, ACTOR), /recovery is unavailable/);
});

test("community join SDK keeps the same actor and operation for request, read and close", async () => {
  const original = globalThis.fetch;
  const requests: { url: string; body: unknown; actor: string | null; idempotency: string | null }[] = [];
  globalThis.fetch = async (input, options) => {
    const headers = new Headers(options?.headers);
    requests.push({ url: String(input), body: JSON.parse(String(options?.body)), actor: headers.get("x-bookworm-actor"), idempotency: headers.get("idempotency-key") });
    return Response.json({ state: "closed" });
  };
  try {
    const api = createClient({ baseUrl: "/api/backend", expectedActor: ACTOR, idempotencyKey: () => { throw new Error("must use the original operation ID"); } });
    await api.requestCommunityJoin(COMMUNITY, OPERATION);
    await api.recoverCommunityJoin(COMMUNITY, OPERATION);
    await api.closeCommunityJoin(COMMUNITY, OPERATION);
    assert.deepEqual(requests.map(request => request.url), [
      `/api/backend/v1/communities/${COMMUNITY}/join-operations`,
      `/api/backend/v1/communities/${COMMUNITY}/join-operations/recover`,
      `/api/backend/v1/communities/${COMMUNITY}/join-operations/close`,
    ]);
    assert.ok(requests.every(request => request.actor === ACTOR && request.idempotency === null));
    assert.ok(requests.every(request => JSON.stringify(request.body) === JSON.stringify({ operationId: OPERATION })));
  } finally { globalThis.fetch = original; }
});

test("community join SDK does not replay a lost response", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("synthetic lost response"); };
  try {
    const api = createClient({ baseUrl: "/api/backend", expectedActor: ACTOR });
    await assert.rejects(api.requestCommunityJoin(COMMUNITY, OPERATION));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
