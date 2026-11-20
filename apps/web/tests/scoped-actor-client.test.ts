import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "../../../packages/api-client/src/index";

const actor = "11111111-1111-4111-8111-111111111111";
const otherActor = "22222222-2222-4222-8222-222222222222";

test("actor-bound client injects the original actor into reads and writes", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { method: string; actor: string | null; auth: string | null }[] = [];
  globalThis.fetch = async (_url, init) => {
    const headers = new Headers(init?.headers);
    calls.push({ method: init?.method ?? "GET", actor: headers.get("x-bookworm-actor"), auth: headers.get("authorization") });
    return Response.json({});
  };
  try {
    const client = createClient({ baseUrl: "/api/backend", expectedActor: actor, token: "synthetic-token", idempotencyKey: () => "synthetic-idempotency" });
    await client.listWorkspaces();
    await client.listWorkspaces(actor);
    await client.createWorkspace({ name: "Synthetic", orgName: "Synthetic", slug: "synthetic" });
    assert.deepEqual(calls.map(call => call.method), ["GET", "GET", "POST"]);
    assert(calls.every(call => call.actor === actor && call.auth === "Bearer synthetic-token"));
    await assert.rejects(client.listWorkspaces(otherActor), /requested account does not match/);
    assert.equal(calls.length, 3, "a conflicting explicit actor must be rejected before dispatch");
  } finally { globalThis.fetch = originalFetch; }
});

test("unbound client still permits explicit actors and does not invent one", async () => {
  const originalFetch = globalThis.fetch; const actors: (string | null)[] = [];
  globalThis.fetch = async (_url, init) => { actors.push(new Headers(init?.headers).get("x-bookworm-actor")); return Response.json({}); };
  try {
    const client = createClient({ baseUrl: "/api/backend" });
    await client.listWorkspaces(); await client.listWorkspaces(otherActor);
    assert.deepEqual(actors, [null, otherActor]);
  } finally { globalThis.fetch = originalFetch; }
});

test("referral reads and claim carry the verified actor to the BFF", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { method: string; actor: string | null; url: string }[] = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ method: init?.method ?? "GET", actor: new Headers(init?.headers).get("x-bookworm-actor"), url: String(url) });
    return Response.json({});
  };
  try {
    const client = createClient({ baseUrl: "/api/backend", expectedActor: actor });
    await client.getReferralCode(); await client.listReferrals(); await client.listCreditLedger(); await client.claimReferral("bw-12345678");
    assert.deepEqual(calls.map(call => call.method), ["GET", "GET", "GET", "POST"]);
    assert(calls.every(call => call.actor === actor));
    assert.deepEqual(calls.map(call => call.url), ["/api/backend/v1/referrals/code", "/api/backend/v1/referrals", "/api/backend/v1/referrals/ledger", "/api/backend/v1/referrals/claim"]);
  } finally { globalThis.fetch = originalFetch; }
});

test("community discovery and join carry their original actor", async () => {
  const originalFetch = globalThis.fetch;
  const calls: { method: string; path: string; actor: string | null }[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ method: init?.method ?? "GET", path: String(input), actor: new Headers(init?.headers).get("x-bookworm-actor") });
    return Response.json({});
  };
  try {
    const client = createClient({ baseUrl: "/api/backend", expectedActor: actor, idempotencyKey: () => "synthetic-idempotency" });
    await client.listCommunities();
    await client.listCommunityMemberships();
    await client.joinCommunity("33333333-3333-4333-8333-333333333333");
    assert.deepEqual(calls, [
      { method: "GET", path: "/api/backend/v1/communities", actor },
      { method: "GET", path: "/api/backend/v1/communities/memberships", actor },
      { method: "POST", path: "/api/backend/v1/communities/33333333-3333-4333-8333-333333333333/join", actor },
    ]);
  } finally { globalThis.fetch = originalFetch; }
});
