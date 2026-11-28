import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { makeAuthPlugin } from "./plugins/auth.js";
import type { SupabaseFactory } from "./lib/supabase.js";
import { AppError } from "./errors.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
test("optional actor binding rejects crossover before read and write handlers, without replacing bearer identity", async () => {
  const app = Fastify();
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof AppError ? error.status : 500).send({ error: "fixture-request-refused" }));
  let handled = 0;
  const factory = (() => ({ auth: { getUser: async () => ({ data: { user: { id: A } }, error: null }) } })) as unknown as SupabaseFactory;
  await app.register(makeAuthPlugin(factory));
  app.route({ method: ["GET", "POST"], url: "/v1/workspaces", handler: async req => { handled++; return { viewerId: req.userId }; } });
  try {
    for (const method of ["GET", "POST"] as const) {
      for (const [actor, status] of [[undefined, 200], ["invalid", 422], ["", 422], [B, 409], [A, 200]] as const) {
        const before = handled;
        const response = await app.inject({ method, url: "/v1/workspaces", headers: { authorization: "Bearer fixture-token", ...(actor === undefined ? {} : { "x-bookworm-actor": actor }) } });
        assert.equal(response.statusCode, status);
        assert.equal(handled, before + (status === 200 ? 1 : 0));
        if (status === 200) assert.equal(response.json().viewerId, A);
      }
    }
  } finally { await app.close(); }
});
