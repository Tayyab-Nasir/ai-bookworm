import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { AppError } from "./errors.js";
import { makeAuthPlugin } from "./plugins/auth.js";
import { communityRoutes } from "./routes/community.js";
import type { SupabaseFactory } from "./lib/supabase.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const COMMUNITY = "33333333-3333-4333-8333-333333333333";
const OPERATION = "44444444-4444-4444-8444-444444444444";

async function fixture(result: { data: unknown; error: { code: string; message: string } | null }) {
  const calls: { name: string; params: Record<string, unknown>; token: string | undefined }[] = [];
  const factory = ((token?: string) => ({
    auth: { getUser: async () => ({ data: { user: { id: token === "a" ? A : B } }, error: null }) },
    rpc: async (name: string, params: Record<string, unknown>) => { calls.push({ name, params, token }); return result; },
  })) as unknown as SupabaseFactory;
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.status : 500).send({ error: error instanceof Error ? error.message : "Unexpected error" }));
  await app.register(makeAuthPlugin(factory));
  await app.register(communityRoutes);
  return { app, calls };
}

test("join, read and close bind the original identity to the verified actor", async () => {
  const { app, calls } = await fixture({ data: { state: "closed" }, error: null });
  try {
    for (const [suffix, name] of [["", "request_community_join"], ["/recover", "read_community_join_operation"], ["/close", "close_community_join_operation"]]) {
      const response = await app.inject({ method: "POST", url: `/communities/${COMMUNITY}/join-operations${suffix}`,
        headers: { authorization: "Bearer a", "x-bookworm-actor": A }, payload: { operationId: OPERATION } });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["cache-control"], "private, no-store");
      assert.deepEqual(response.json(), { state: "closed" });
      assert.deepEqual(calls.at(-1), { name, token: undefined, params: { p_community_id: COMMUNITY, p_user_id: A, p_operation_id: OPERATION } });
    }
    const before = calls.length;
    const crossed = await app.inject({ method: "POST", url: `/communities/${COMMUNITY}/join-operations/close`,
      headers: { authorization: "Bearer b", "x-bookworm-actor": A }, payload: { operationId: OPERATION } });
    assert.equal(crossed.statusCode, 409);
    const spoofed = await app.inject({ method: "POST", url: `/communities/${COMMUNITY}/join-operations`,
      headers: { authorization: "Bearer a" }, payload: { operationId: OPERATION, userId: B } });
    assert.equal(spoofed.statusCode, 422);
    assert.equal(calls.length, before);
  } finally { await app.close(); }
});

test("an absent receipt is a read result, not a confirmed cancellation", async () => {
  const { app } = await fixture({ data: { state: "not_seen" }, error: null });
  try {
    const recover = await app.inject({ method: "POST", url: `/communities/${COMMUNITY}/join-operations/recover`,
      headers: { authorization: "Bearer a" }, payload: { operationId: OPERATION } });
    assert.deepEqual(recover.json(), { state: "not_seen" });
    const request = await app.inject({ method: "POST", url: `/communities/${COMMUNITY}/join-operations`,
      headers: { authorization: "Bearer a" }, payload: { operationId: OPERATION } });
    assert.equal(request.statusCode, 503);
  } finally { await app.close(); }
});

test("database failures and malformed receipts never become a confirmed join", async () => {
  for (const [result, status] of [
    [{ data: null, error: { code: "23505", message: "private upstream detail" } }, 409],
    [{ data: null, error: { code: "54000", message: "private upstream detail" } }, 429],
    [{ data: null, error: { code: "40001", message: "private upstream detail" } }, 503],
    [{ data: { state: "joined", role: "member" }, error: null }, 503],
    [{ data: { state: "rejected", reason: "unexpected" }, error: null }, 503],
  ] as const) {
    const { app } = await fixture(result);
    try {
      const response = await app.inject({ method: "POST", url: `/communities/${COMMUNITY}/join-operations`,
        headers: { authorization: "Bearer a" }, payload: { operationId: OPERATION } });
      assert.equal(response.statusCode, status);
      assert.doesNotMatch(response.body, /private upstream detail/);
    } finally { await app.close(); }
  }
});

test("legacy join retains its response contract through the atomic operation", async () => {
  for (const alreadyMember of [false, true]) {
    const { app, calls } = await fixture({ data: { state: "joined", role: "member", alreadyMember }, error: null });
    try {
      const response = await app.inject({ method: "POST", url: `/communities/${COMMUNITY}/join`, headers: { authorization: "Bearer a" } });
      assert.equal(response.statusCode, alreadyMember ? 200 : 201);
      assert.deepEqual(response.json(), { communityId: COMMUNITY, role: "member", ...(alreadyMember ? { alreadyMember: true } : {}) });
      assert.equal(calls[0]?.params.p_operation_id, null);
    } finally { await app.close(); }
  }
});
