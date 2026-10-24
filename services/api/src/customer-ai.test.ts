import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import Fastify from "fastify";
import { customerAiRoutes } from "./routes/customer-ai.js";
import { customerAiPreparation } from "./lib/customer-ai-prepare.js";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";
import { safeRequestLog, isAiConnectionPath } from "./lib/redact.js";
import { ids, sha, sourceFixture } from "./testing/customer-ai-fixture.js";
import type { SupabaseFactory } from "./lib/supabase.js";

// Transport fixture only. Real authorization, fee and lifecycle assertions are
// in customer-ai-preparations.test.sql; no provider/database network is used.
function backend() {
  const source = sourceFixture(), connection = randomUUID(), policyId = randomUUID();
  const selected = { workspaceId: ids.workspace, bookId: ids.book, connectionId: connection,
    credentialRevision: 1, provider: "openai", agentType: "writer" };
  const policy = { id: policyId, provider: "openai", agentType: "writer", policy: { model: "synthetic-1",
    responseModels: ["synthetic-1"], maxOutputTokens: 1024, upstream: null as string | null, responseUpstreams: [] as string[] },
    platformFee: { mode: "per_request_credits", credits: 2 }, expiresAt: new Date(Date.now() + 3600000).toISOString() };
  const settings = { error: "", loseAfter: "", policyRows: undefined as unknown[] | undefined,
    alterReceipt: (r: any): unknown => r, privateCalls: 0, privateError: false };
  const receipts = new Map<string, any>(), calls: { name: string; args: Record<string, any> }[] = [];
  let jobs = 0;
  const factory: SupabaseFactory = (token, fetcher) => {
    if (token !== undefined) return source.factory(token, fetcher);
    assert.equal(typeof fetcher, "function");
    return { rpc: async (name: string, args: Record<string, any>) => {
      calls.push({ name, args: structuredClone(args) }); assert.equal(args.p_owner_id, ids.owner);
      if (settings.error) return { error: { code: settings.error, message: "private-database-detail" }, data: null };
      if (name === "customer_ai_preparation_options") return { data: settings.policyRows ?? [policy], error: null };
      const op = args.p_operation_id, old = receipts.get(op);
      let r = old ?? { operationId: op, status: "not_found" };
      if (name === "prepare_customer_ai_request") {
        if (!old) {
          r = { operationId: op, jobId: null, workspaceId: args.p_workspace_id, bookId: args.p_book_id,
            connectionId: args.p_connection_id, credentialRevision: args.p_revision, policyId: args.p_policy_id,
            provider: policy.provider, agentType: policy.agentType, model: policy.policy.model,
            maxOutputTokens: policy.agentType === "bookbible" ? Math.min(policy.policy.maxOutputTokens, 6000) : policy.policy.maxOutputTokens,
            platformFee: structuredClone(policy.platformFee), providerCostStatus: "unknown", contextOmitted: args.p_context_omitted,
            chapterCount: args.p_sources.length, status: "prepared", createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 900000).toISOString() };
          receipts.set(op, r);
        }
      } else {
        assert.equal(name, "customer_ai_request_action");
        if (args.p_action === "confirm" && r.status === "prepared") { jobs++; r.status = "queued"; r.jobId = randomUUID(); }
        if (args.p_action === "cancel") {
          if (!["prepared", "closed", "queued", "cancelled"].includes(r.status)) return { error: { code: "40001" }, data: null };
          r.status = r.jobId ? "cancelled" : "closed";
        }
        if (args.p_action === "recover") {
          if (!["queued", "running", "requires_review", "succeeded"].includes(r.status)) return { error: { code: "40001" }, data: null };
          r.status = "succeeded";
        }
      }
      if (settings.loseAfter === name) throw new Error("private-response-lost-detail");
      return { data: settings.alterReceipt(structuredClone(r)), error: null };
    } } as unknown as ReturnType<SupabaseFactory>;
  };
  const preparer = customerAiPreparation(factory, { serviceUrl: "https://private-ai.example", serviceToken: "synthetic-service-token",
    fetcher: async (url, init) => {
      settings.privateCalls++; assert.equal(url, "https://private-ai.example/v1/internal/customer-text/prepare");
      assert.equal(init?.redirect, "error"); assert(init?.signal); assert(!String(init?.body).includes(source.actor.accessToken));
      if (settings.privateError) throw new Error("private-upstream-detail");
      const { scope, requestJson } = JSON.parse(String(init?.body));
      return Response.json({ provider: scope.provider, agentType: scope.agentType, model: scope.policy.model,
        maxOutputTokens: scope.agentType === "bookbible" ? Math.min(scope.policy.maxOutputTokens, 6000) : scope.policy.maxOutputTokens,
        sourceSha256: sha(requestJson), requestSha256: "a".repeat(64), contextOmitted: 0 });
    } });
  const body = () => ({ operationId: randomUUID(), selection: structuredClone(selected), policyId, source: structuredClone(source.input) });
  return { source, selected, policy, settings, receipts, calls, factory, preparer, body, jobs: () => jobs };
}
async function fixture(db = backend(), enabled = true) {
  const logs: string[] = [], app = Fastify({ logger: { level: "info", stream: { write: (line: string) => { logs.push(line); } }, serializers: { req: safeRequestLog } } });
  app.addHook("onRequest", async (req, reply) => { if (isAiConnectionPath(req.url)) reply.header("cache-control", "private, no-store"); });
  await app.register(async child => {
    await child.register(errorHandlerPlugin); await child.register(makeAuthPlugin(db.factory)); await child.register(idempotencyPlugin);
    customerAiRoutes(child, enabled ? { preparation: db.preparer } : {});
  }, { prefix: "/v1" });
  const send = (action: string, payload: unknown, actor: string | null = ids.owner, suffix = "") => app.inject({ method: "POST",
    url: `/v1/account/customer-ai/${action}${suffix}`, headers: { authorization: "Bearer synthetic-user-session",
      "idempotency-key": "same-header-durable-not-memory", ...(actor ? { "x-bookworm-actor": actor } : {}) }, payload: payload as object });
  return { db, app, logs, send };
}
test("canonical preparation is durable without job/key/provider activation; exact confirmation recovers after restart", async () => {
  const db = backend(), f = await fixture(db), body = db.body();
  try {
    const choices = await f.send("options", body.selection); assert.equal(choices.statusCode, 200, choices.body);
    assert.deepEqual(choices.json().options[0], { id: db.policy.id, provider: "openai", agentType: "writer", model: "synthetic-1",
      maxOutputTokens: 1024, upstream: null, platformFee: { mode: "per_request_credits", credits: 2 }, providerCostStatus: "unknown", expiresAt: db.policy.expiresAt });
    const prepare = await f.send("prepare", body); assert.equal(prepare.statusCode, 200, prepare.body);
    assert.equal(prepare.headers["cache-control"], "private, no-store"); assert.equal(db.jobs(), 0);
    const saved = prepare.json().receipt; assert.equal(saved.status, "prepared"); assert.equal(saved.jobId, null);
    const args = db.calls.find(c => c.name === "prepare_customer_ai_request")!.args;
    assert.equal(args.p_owner_id, ids.owner); assert.equal(args.p_revision, 1); assert.equal(args.p_request_sha256, "a".repeat(64));
    assert.equal(args.p_request.input.chapters[ids.chapter].nodes[0].text, db.source.nodes[0].text);
    assert(!JSON.stringify(args).includes("not-for-model")); assert(!prepare.body.includes("Rain fell."));
    assert(!prepare.body.includes("requestSha256")); assert(!prepare.body.includes(body.source.userInstruction!));
    assert.equal((await f.send("prepare", body)).statusCode, 200, "Durable operation bypasses process-local idempotency Map");
    db.settings.loseAfter = "customer_ai_request_action";
    const confirm = await f.send("confirm", { operationId: body.operationId, expectedPlatformFeeCredits: 2, consent: true });
    assert.equal(confirm.statusCode, 503); assert.equal(db.jobs(), 1);
  } finally { await f.app.close(); }
  db.settings.loseAfter = "";
  const recovered = await fixture(db); try {
    const status = await recovered.send("status", { operationId: body.operationId }); assert.equal(status.statusCode, 200);
    assert.equal(status.json().receipt.status, "queued"); const job = status.json().receipt.jobId;
    const again = await recovered.send("confirm", { operationId: body.operationId, expectedPlatformFeeCredits: 2, consent: true });
    assert.equal(again.statusCode, 200); assert.equal(again.json().receipt.jobId, job); assert.equal(db.jobs(), 1);
    assert.equal(db.settings.privateCalls, 2, "Status/confirmation never invoke preparation or generation");
    assert(!recovered.logs.join("").includes("private-response-lost-detail"));
  } finally { await recovered.app.close(); }
});
test("lost preparation is read-only recoverable without resending manuscript or private preparation", async () => {
  const f = await fixture(), body = f.db.body(); try {
    f.db.settings.loseAfter = "prepare_customer_ai_request";
    assert.equal((await f.send("prepare", body)).statusCode, 503);
    f.db.settings.loseAfter = "";
    const r = await f.send("status", { operationId: body.operationId }); assert.equal(r.statusCode, 200); assert.equal(r.json().receipt.status, "prepared");
    assert.equal(f.db.settings.privateCalls, 1); assert.equal(f.db.jobs(), 0);
    assert.deepEqual(f.db.calls.at(-1)!.args, { p_owner_id: ids.owner, p_operation_id: body.operationId, p_action: "status", p_expected_fee: null, p_consent: false });
  } finally { await f.app.close(); }
});
test("configuration removal blocks creation but preserves status, cancellation and receipt-only recovery", async () => {
  const db = backend(), f = await fixture(db), body = db.body(), pending = db.body();
  await f.send("prepare", body); await f.send("confirm", { operationId: body.operationId, expectedPlatformFeeCredits: 2, consent: true });
  await f.send("prepare", pending); await f.app.close();
  const disabled = await fixture(db, false); try {
    for (const [action, payload] of [["options", db.selected], ["prepare", db.body()], ["confirm", { operationId: body.operationId, expectedPlatformFeeCredits: 2, consent: true }]] as const) {
      const n = db.calls.length; assert.equal((await disabled.send(action, payload)).statusCode, 503); assert.equal(db.calls.length, n);
    }
    assert.equal((await disabled.send("status", { operationId: body.operationId })).json().receipt.status, "queued");
    assert.equal((await disabled.send("recover", { operationId: body.operationId })).json().receipt.status, "succeeded");
    assert.equal((await disabled.send("cancel", { operationId: pending.operationId })).json().receipt.status, "closed");
    assert.equal((await disabled.send("cancel", { operationId: body.operationId })).statusCode, 409);
    assert.equal(db.settings.privateCalls, 2); assert.equal(db.jobs(), 1);
  } finally { await disabled.app.close(); }
});
test("all six operations require the original authenticated actor and exact body shape before service RPC", async () => {
  const f = await fixture(), b = f.db.body(); try {
    for (const [action, payload] of [["options", b.selection], ["prepare", b], ["confirm", { operationId: b.operationId, expectedPlatformFeeCredits: 2, consent: true }],
      ["status", { operationId: b.operationId }], ["cancel", { operationId: b.operationId }], ["recover", { operationId: b.operationId }]] as const) {
      assert.equal((await f.send(action, payload, null)).statusCode, 422);
      assert.equal((await f.send(action, payload, ids.other)).statusCode, 409);
      assert.equal((await f.send(action, { ...payload, ownerId: ids.other })).statusCode, 422);
      assert.equal((await f.send(action, payload, ids.owner, "?apiKey=forbidden")).statusCode, 422);
    }
    assert.equal(f.db.calls.length, 0); assert.equal(f.db.settings.privateCalls, 0);
    assert.equal((await f.app.inject({ method: "POST", url: "/v1/account/customer-ai/status", payload: { operationId: b.operationId } })).statusCode, 401);
  } finally { await f.app.close(); }
});
test("client cannot choose endpoints, source text, unknown context or unconsented fee", async () => {
  const f = await fixture(), body = f.db.body(); try {
    for (const change of [ { selection: { ...body.selection, endpoint: "https://unapproved.example" } },
      { source: { ...body.source, chapters: [{ ...body.source.chapters[0], text: "forged manuscript" }] } },
      { source: { ...body.source, contextPolicy: { ...body.source.contextPolicy, includeRelatedContext: true } } },
      { source: { ...body.source, bookId: ids.other } }, { source: { ...body.source, agentType: "proofreader" } },
      { apiKey: "never-in-browser-request" } ]) assert.equal((await f.send("prepare", { ...body, ...change })).statusCode, 422);
    for (const c of [{ consent: false }, { expectedPlatformFeeCredits: -1 }, { expectedPlatformFeeCredits: 1.5 }, { consent: null }])
      assert.equal((await f.send("confirm", { operationId: body.operationId, expectedPlatformFeeCredits: 2, consent: true, ...c })).statusCode, 422);
    assert.equal(f.db.calls.length, 0); assert.equal(f.db.settings.privateCalls, 0);
  } finally { await f.app.close(); }
});
test("stale or forged policy catalog fails before canonical loading and private service", async () => {
  const f = await fixture(); try {
    const p = f.db.policy;
    for (const rows of [[p, p], Array.from({ length: 51 }, () => ({ ...p, id: randomUUID() })), [{ ...p, provider: "xai" }],
      [{ ...p, expiresAt: "2000-01-01T00:00:00Z" }], [{ ...p, platformFee: { mode: "platform_plan", credits: 2 } }],
      [{ ...p, policy: { ...p.policy, endpoint: "https://unapproved.example" } }]]) {
      f.db.settings.policyRows = rows; assert.equal((await f.send("prepare", f.db.body())).statusCode, 503);
    }
    f.db.settings.policyRows = [];
    assert.equal((await f.send("prepare", f.db.body())).statusCode, 409);
    assert.equal(f.db.settings.privateCalls, 0); assert.equal(f.db.source.reads.length, 0);
  } finally { await f.app.close(); }
});
test("canonical source change and private service failure never persist a preparation", async () => {
  const f = await fixture(); try {
    f.db.source.data.chapters[0].current_document_version_id = ids.other;
    assert.equal((await f.send("prepare", f.db.body())).statusCode, 409);
    assert.equal(f.db.settings.privateCalls, 0);
    f.db.source.data.chapters[0].current_document_version_id = ids.version; f.db.settings.privateError = true;
    assert.equal((await f.send("prepare", f.db.body())).statusCode, 503);
    assert(f.db.calls.every(c => c.name === "customer_ai_preparation_options"));
    assert(!f.logs.join("").includes("private-upstream-detail"));
  } finally { await f.app.close(); }
});
for (const [code, status] of [["42501", 403], ["40001", 409], ["23505", 409], ["23514", 403], ["22023", 422], ["P0429", 429], ["P0002", 404], ["PGRST202", 503]] as const) {
  test(`database ${code} is redacted and mapped to ${status} without retry`, async () => {
    const f = await fixture(); try {
      f.db.settings.error = code; const r = await f.send("status", { operationId: randomUUID() });
      assert.equal(r.statusCode, status); assert.equal(f.db.calls.length, 1);
      assert(!r.body.includes("private-database-detail")); assert(!f.logs.join("").includes("private-database-detail"));
    } finally { await f.app.close(); }
  });
}
test("receipts reject wrong identity, hidden source, fee, model and lifecycle metadata", async () => {
  const f = await fixture(); try {
    for (const delta of [{ operationId: ids.other }, { connectionId: ids.other }, { credentialRevision: 2 }, { policyId: ids.other },
      { bookId: ids.other }, { provider: "xai" }, { model: "different" }, { chapterCount: 2 }, { contextOmitted: 1 },
      { platformFee: { mode: "per_request_credits", credits: 3 } }, { requestSha256: "a".repeat(64) }, { status: "queued", jobId: null }]) {
      f.db.settings.alterReceipt = r => ({ ...r, ...delta });
      assert.equal((await f.send("prepare", f.db.body())).statusCode, 503);
    }
  } finally { await f.app.close(); }
});
test("an invalid saved recovery receipt is a review conflict, not a payment or regeneration prompt", async () => {
  const f = await fixture(); try {
    f.db.settings.error = "23514";
    const r = await f.send("recover", { operationId: randomUUID() });
    assert.equal(r.statusCode, 409); assert(r.body.includes("Keep this request for review"));
    assert.equal(f.db.settings.privateCalls, 0); assert.equal(f.db.calls.length, 1);
  } finally { await f.app.close(); }
});
test("all five providers and six text agents preserve their exact selected model and fee; Bible cap is explicit", async () => {
  for (const provider of ["openai", "anthropic", "google", "openrouter", "xai"]) {
    for (const agentType of ["writer", "proofreader", "copyeditor", "consistency", "metadata", "bookbible"] as const) {
      const db = backend(); Object.assign(db.selected, { provider, agentType }); Object.assign(db.policy, { provider, agentType });
      db.source.input.agentType = agentType; db.policy.policy.maxOutputTokens = 9000;
      if (provider === "openrouter") Object.assign(db.policy.policy, { upstream: "synthetic", responseUpstreams: ["Synthetic"] });
      const f = await fixture(db); try {
        const r = await f.send("prepare", db.body()); assert.equal(r.statusCode, 200, `${provider}/${agentType}: ${r.body}`);
        assert.equal(r.json().receipt.provider, provider); assert.equal(r.json().receipt.agentType, agentType);
        assert.equal(r.json().receipt.maxOutputTokens, agentType === "bookbible" ? 6000 : 9000);
        assert.equal(r.json().receipt.platformFee.credits, 2); assert.equal(db.jobs(), 0);
      } finally { await f.app.close(); }
    }
  }
});
test("malformed or oversized JSON, URL and request ID canaries never enter responses/logs", async () => {
  const f = await fixture(); const canary = "private-request-canary-0123456789"; try {
    for (const payload of [`{"operationId":"${canary}"broken`, JSON.stringify({ operationId: canary.repeat(6000) })]) {
      const r = await f.app.inject({ method: "POST", url: `/v1/account/customer-ai/status?secret=${canary}`,
        headers: { "content-type": "application/json", "x-request-id": canary, authorization: "Bearer synthetic-user-session" }, payload });
      assert([400, 413].includes(r.statusCode)); assert(!r.body.includes(canary)); assert(!f.logs.join("").includes(canary));
      assert.equal(r.headers["cache-control"], "private, no-store");
    }
    assert.equal(f.db.calls.length, 0);
  } finally { await f.app.close(); }
});
test("real API registration defaults creation off and applies private cache headers; explicit dependency enables preparation only", async () => {
  const { loadEnv, resetEnvCache } = await import("@bookworm/config");
  resetEnvCache();
  loadEnv({ SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_ANON_KEY: "synthetic-anon", SUPABASE_SERVICE_ROLE_KEY: "synthetic-service",
    REDIS_URL: "redis://127.0.0.1:1", QDRANT_URL: "http://127.0.0.1:1", NODE_ENV: "test", LOG_LEVEL: "error" });
  const { buildApp } = await import("./app.js");
  try {
    for (const enabled of [false, true]) {
      const db = backend(), app = await buildApp(db.factory, enabled ? { customerAiPreparation: db.preparer } : {});
      try {
        const headers = { authorization: "Bearer synthetic-user-session", "x-bookworm-actor": ids.owner };
        const r = await app.inject({ method: "POST", url: "/v1/account/customer-ai/prepare", headers, payload: db.body() });
        assert.equal(r.statusCode, enabled ? 200 : 503, r.body);
        assert.equal(r.headers["cache-control"], "private, no-store"); assert.equal(r.headers.pragma, "no-cache");
        assert.equal(db.jobs(), 0); assert.equal(db.settings.privateCalls, enabled ? 1 : 0);
        const status = await app.inject({ method: "POST", url: "/v1/account/customer-ai/status", headers, payload: { operationId: randomUUID() } });
        assert.equal(status.statusCode, 200); assert.equal(status.json().receipt.status, "not_found");
      } finally { await app.close(); }
    }
  } finally { resetEnvCache(); }
});
