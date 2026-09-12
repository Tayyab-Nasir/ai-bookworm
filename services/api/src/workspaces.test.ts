import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { workspaceRoutes } from "./routes/workspaces.js";
import { AppError } from "./errors.js";

async function fixture(result: { data: unknown; error: { code: string } | null }) {
  const calls: { token: string | undefined; name: string; args: unknown }[] = [];
  const app = Fastify();
  app.decorate("supabaseFactory", ((token?: string) => ({
    rpc: (name: string, args: unknown) => {
      calls.push({ token, name, args });
      return { single: async () => result };
    },
  })) as never);
  app.addHook("preHandler", async (req) => {
    req.userId = "11111111-1111-1111-1111-111111111111";
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
