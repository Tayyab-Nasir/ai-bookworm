import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { workspaceRoutes } from "./routes/workspaces.js";
import { AppError } from "./errors.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";

async function fixture(result: { data: unknown; error: { code: string } | null }) {
  const calls: { token: string | undefined; name: string; args: unknown }[] = [];
  const app = Fastify();
  await app.register(idempotencyPlugin);
  app.decorate("supabaseFactory", ((token?: string) => ({
    rpc: (name: string, args: unknown) => {
      calls.push({ token, name, args });
      return { single: async () => result, then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
    },
  })) as never);
  app.addHook("preHandler", async (req) => {
    req.userId = "11111111-1111-4111-8111-111111111111";
    req.userToken = "scoped-user-jwt";
  });
  app.setErrorHandler((error, _req, reply) => {
    reply.status(error instanceof AppError ? error.status : 500).send({ error: error instanceof Error ? error.message : "internal error" });
  });
  workspaceRoutes(app);
  return { app, calls };
}

test("onboarding uses one user-scoped RPC, no caller-supplied owner or service role", async () => {
  const workspace = { id: "ws", organization_id: "org", name: "Novel" };
  const { app, calls } = await fixture({ data: workspace, error: null });
  try {
    const res = await app.inject({ method: "POST", url: "/workspaces", payload: { name: "  Novel  " } });
    assert.equal(res.statusCode, 201);
    assert.deepEqual(res.json(), workspace);
    assert.deepEqual(calls, [{ token: "scoped-user-jwt", name: "create_workspace_with_owner", args: { p_name: "Novel", p_org_name: null, p_slug: null } }]);
  } finally { await app.close(); }
});

const actor = "11111111-1111-4111-8111-111111111111";
const operation = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const actorHeader = { "x-bookworm-actor": actor };

test("onboarding receipt creation binds the actor and forwards the durable operation identity", async () => {
  const workspace = { id: workspaceId, created_by: actor, name: "Novel" };
  const { app, calls } = await fixture({ data: workspace, error: null });
  try {
    const denied = await app.inject({ method: "POST", url: "/workspaces/onboarding", payload: { name: "Novel", operationId: operation } });
    assert.equal(denied.statusCode, 422);
    assert.equal(calls.length, 0);
    const res = await app.inject({ method: "POST", url: "/workspaces/onboarding", headers: actorHeader, payload: { name: "  Novel  ", operationId: operation } });
    assert.equal(res.statusCode, 201);
    assert.match(res.headers["cache-control"]!, /no-store/);
    assert.deepEqual(res.json(), { viewerId: actor, operationId: operation, workspace });
    assert.deepEqual(calls, [{ token: "scoped-user-jwt", name: "create_workspace_with_receipt", args: { p_operation_id: operation, p_name: "Novel", p_org_name: null, p_slug: null } }]);
  } finally { await app.close(); }
});

test("onboarding rejects a response from another actor and keeps transport failures unconfirmed", async () => {
  for (const result of [
    { data: { id: workspaceId, created_by: "44444444-4444-4444-8444-444444444444" }, error: null },
    { data: null, error: { code: "08006" } },
  ]) {
    const { app } = await fixture(result);
    try {
      const res = await app.inject({ method: "POST", url: "/workspaces/onboarding", headers: actorHeader, payload: { name: "Novel", operationId: operation } });
      assert.equal(res.statusCode, 503);
      assert.match(res.json().error, /could not be confirmed/);
    } finally { await app.close(); }
  }
});

test("durable onboarding retries bypass the process-local idempotency cache", async () => {
  const { app, calls } = await fixture({ data: { id: workspaceId, created_by: actor }, error: null });
  try {
    const request = { method: "POST" as const, url: "/workspaces/onboarding", headers: { ...actorHeader, "idempotency-key": "same-key" }, payload: { name: "Novel", operationId: operation } };
    assert.equal((await app.inject(request)).statusCode, 201);
    assert.equal((await app.inject(request)).statusCode, 201);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].args, calls[1].args);
  } finally { await app.close(); }
});

test("workspace recovery checks and closes only the actor's original operation", async () => {
  for (const [action, status, id] of [["check", "not_found", null], ["close", "closed", null], ["close", "created", workspaceId]] as const) {
    const receipt = { operationId: operation, status, workspaceId: id };
    const { app, calls } = await fixture({ data: receipt, error: null });
    try {
      const res = await app.inject({ method: "POST", url: `/workspaces/onboarding/${action}`, headers: actorHeader, payload: { operationId: operation } });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { viewerId: actor, receipt });
      assert.deepEqual(calls, [{ token: "scoped-user-jwt", name: "workspace_creation_receipt", args: { p_operation_id: operation, p_close: action === "close" } }]);
    } finally { await app.close(); }
  }
});

test("workspace recovery refuses mismatched receipts and an unconfirmed close", async () => {
  for (const receipt of [
    { operationId: workspaceId, status: "closed", workspaceId: null },
    { operationId: operation, status: "not_found", workspaceId: null },
    { operationId: operation, status: "created", workspaceId: null },
  ]) {
    const { app } = await fixture({ data: receipt, error: null });
    try {
      const res = await app.inject({ method: "POST", url: "/workspaces/onboarding/close", headers: actorHeader, payload: { operationId: operation } });
      assert.equal(res.statusCode, 503);
    } finally { await app.close(); }
  }
});

test("onboarding rejects blank names, oversized names, malformed slugs, and ownership injection before RPC", async () => {
  const { app, calls } = await fixture({ data: {}, error: null });
  try {
    for (const payload of [{ name: " " }, { name: "x".repeat(121) }, { name: "N", orgName: " " }, { name: "N", slug: "-bad-" }, { name: "N", owner_user_id: "someone-else" }]) {
      const res = await app.inject({ method: "POST", url: "/workspaces", payload });
      assert.equal(res.statusCode, 422);
    }
    assert.equal(calls.length, 0);
  } finally { await app.close(); }
});

test("onboarding maps SQL failures without exposing provider error details or doing compensating deletes", async () => {
  for (const [code, status] of [["23505", 409], ["42501", 403], ["22023", 422], ["PGRST202", 503], ["42883", 503], ["08006", 500]] as const) {
    const { app, calls } = await fixture({ data: null, error: { code } });
    try {
      const res = await app.inject({ method: "POST", url: "/workspaces", payload: { name: "Novel" } });
      assert.equal(res.statusCode, status, code);
      assert.equal(calls.length, 1);
    } finally { await app.close(); }
  }
});
