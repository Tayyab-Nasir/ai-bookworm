import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { imageQuoteRoutes } from "./routes/image-quotes.js";
import { imageRequestHash, type ImageQuoteRequest } from "./lib/image-pricing.js";
import { quoteUsage } from "./lib/usage-pricing.js";

const USER = "ea000000-0000-4000-8000-000000000001";
const WORKSPACE = "ea000000-0000-4000-8000-000000000002";
const JOB = "ea000000-0000-4000-8000-000000000003";
const QUOTE = "ea000000-0000-4000-8000-000000000004";
const dimensions = ["text_input", "image_input", "text_output", "image_output"] as const;
const headers = { authorization: "Bearer valid" };

async function setup() {
  const request: ImageQuoteRequest = { jobId: JOB, workspaceId: WORKSPACE, userId: USER, bookId: null,
    kind: "cover", model: "fixture-image", prompt: "PRIVATE-PROMPT", size: "1024x1024", quality: "low", references: [] };
  const now = Date.now();
  const quote = quoteUsage({ scope: { jobId: JOB, workspaceId: WORKSPACE, userId: USER, inputSha256: imageRequestHash(request) },
    price: { version: "fixture", provider: "openai", model: request.model,
      rates: dimensions.map(dimension => ({ dimension, microUsdPerMillionTokens: "1000000" })) },
    policy: { version: "fixture", approved: true, microUsdPerCredit: "10", markupBasisPoints: 10000, platformMicroUsd: "0", minimumCredits: "1" },
    maximumTokens: [{ dimension: "text_input", tokens: "100" }, { dimension: "image_input", tokens: "100" },
      { dimension: "text_output", tokens: "10" }, { dimension: "image_output", tokens: "100" }],
    createdAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() });
  const rows: Record<string, Record<string, any>[]> = {
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role: "designer", status: "active" }],
    image_quote_snapshots: [{ id: QUOTE, user_id: USER, workspace_id: WORKSPACE, book_id: null,
      generation_job_id: JOB, request_json: request, request_sha256: imageRequestHash(request), quote_json: quote, expires_at: quote.expiresAt }],
  };
  const client = {
    auth: { getUser: async (token: string) => ({ data: { user: token === "valid" ? { id: USER } : null }, error: null }) },
    from(table: string) {
      const filters: [string, unknown][] = [];
      return { select() { return this; }, eq(key: string, value: unknown) { filters.push([key, value]); return this; },
        async maybeSingle() { return { data: rows[table]?.find((row) => filters.every(([key, value]) => row[key] === value)) ?? null, error: null }; } };
    },
    async rpc(name: string, args: Record<string, any>) {
      if (name === "accept_image_quote") {
        assert.equal(args.p_quote_id, QUOTE);
        assert.equal(args.p_user_id, USER);
        if (args.p_expected_credits !== Number(quote.reservedCredits)) return { data: null, error: { code: "23514" } };
        return { data: { id: JOB, workspace_id: WORKSPACE, created_by: USER, billing_mode: "quoted", status: "queued" }, error: null };
      }
      assert.equal(name, "save_image_quote_snapshot", "quote creation must never call a funding or generation RPC");
      const previous = rows.image_quote_snapshots!.find((row) => row.idempotency_key === args.p_idempotency_key);
      if (previous) return { data: previous, error: null };
      const row = { id: "ea000000-0000-4000-8000-000000000005", user_id: args.p_user_id,
        workspace_id: args.p_workspace_id, book_id: args.p_book_id, generation_job_id: args.p_job_id,
        idempotency_key: args.p_idempotency_key, request_json: args.p_request, request_sha256: args.p_request_sha256,
        quote_json: args.p_quote, expires_at: args.p_quote.expiresAt };
      rows.image_quote_snapshots!.push(row);
      return { data: row, error: null };
    },
  };
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(makeAuthPlugin(() => client as never));
  imageQuoteRoutes(app);
  await app.ready();
  return { app, rows };
}

test("image acceptance requires consent and enablement; accepted replay survives disabled catalog", async () => {
  const { app, rows } = await setup();
  const old = process.env.IMAGE_QUOTE_PURCHASE_ENABLED;
  const oldCatalog = process.env.IMAGE_PRICING_CATALOG_JSON;
  delete process.env.IMAGE_QUOTE_PURCHASE_ENABLED;
  const url = `/workspaces/${WORKSPACE}/image-quotes/${QUOTE}/accept`;
  const payload = { expectedCredits: rows.image_quote_snapshots![0]!.quote_json.reservedCredits, consentToGenerate: true };
  const savedQuote = rows.image_quote_snapshots![0]!.quote_json;
  process.env.IMAGE_PRICING_CATALOG_JSON = JSON.stringify({ version: "fixture-v1", approved: true,
    effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", quoteLifetimeSeconds: 300,
    entries: [{ id: "fixture-option", label: "Fixture", size: "1024x1024", quality: "low", maxPromptBytes: 1000,
      maxReferenceImages: 0, maximumTokens: { text_input: 100, image_input: 100, text_output: 10, image_output: 100 },
      price: savedQuote.price, policy: savedQuote.policy }] });
  try {
    assert.equal((await app.inject({ method: "POST", url, payload })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { expectedCredits: payload.expectedCredits } })).statusCode, 422);
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 503);
    process.env.IMAGE_QUOTE_PURCHASE_ENABLED = "true";
    const firstPurchase = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(firstPurchase.statusCode, 200);
    assert.equal(firstPurchase.json().jobId, JOB);
    rows.image_quote_acceptances = [{ quote_id: QUOTE, job_id: JOB }];
    delete process.env.IMAGE_QUOTE_PURCHASE_ENABLED;
    const replay = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(replay.statusCode, 200);
    assert.deepEqual(replay.json(), { quoteId: QUOTE, jobId: JOB, status: "queued" });
    assert.equal(replay.headers["cache-control"], "private, no-store");
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { ...payload, expectedCredits: "1" } })).statusCode, 409);
    rows.image_quote_snapshots![0]!.user_id = JOB;
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 404);
  } finally {
    if (old === undefined) delete process.env.IMAGE_QUOTE_PURCHASE_ENABLED; else process.env.IMAGE_QUOTE_PURCHASE_ENABLED = old;
    if (oldCatalog === undefined) delete process.env.IMAGE_PRICING_CATALOG_JSON; else process.env.IMAGE_PRICING_CATALOG_JSON = oldCatalog;
    await app.close();
  }
});

test("accepted image status is read-only, private and available without a catalog", async () => {
  const { app, rows } = await setup();
  const url = `/workspaces/${WORKSPACE}/image-quotes/${QUOTE}/job`;
  try {
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.deepEqual((await app.inject({ url, headers })).json(), { quoteId: QUOTE, accepted: false, job: null });
    rows.image_quote_acceptances = [{ quote_id: QUOTE, job_id: JOB }];
    rows.ai_jobs = [{ id: JOB, workspace_id: WORKSPACE, created_by: USER, billing_mode: "quoted", agent_type: "cover_designer",
      status: "running", output_ref: { private: "PRIVATE-RECEIPT" }, error_code: "PRIVATE-ERROR" }];
    const pending = await app.inject({ url, headers });
    assert.equal(pending.statusCode, 200);
    assert.equal(pending.headers["cache-control"], "private, no-store");
    assert.deepEqual(pending.json().job, { id: JOB, status: "running", assetId: null });
    assert(!pending.body.includes("PRIVATE"));
    rows.ai_jobs[0]!.status = "succeeded";
    assert.equal((await app.inject({ url, headers })).statusCode, 503);
    rows.ai_jobs[0]!.output_ref.assetId = QUOTE;
    assert.equal((await app.inject({ url, headers })).json().job.assetId, QUOTE);
    rows.ai_jobs[0]!.created_by = QUOTE;
    assert.equal((await app.inject({ url, headers })).statusCode, 503);
    rows.image_quote_snapshots![0]!.user_id = QUOTE;
    assert.equal((await app.inject({ url, headers })).statusCode, 404);
  } finally { await app.close(); }
});

test("image quote recovery requires auth and ownership and redacts private snapshots", async () => {
  const { app, rows } = await setup();
  try {
    const url = `/workspaces/${WORKSPACE}/image-quotes/${QUOTE}`;
    assert.equal((await app.inject({ url })).statusCode, 401);
    const result = await app.inject({ url, headers });
    assert.equal(result.statusCode, 200);
    assert.equal(result.headers["cache-control"], "private, no-store");
    assert.equal(result.json().quote.purchaseAvailable, false);
    assert.equal(result.json().quote.status, "ready");
    assert.equal(result.body.includes("PRIVATE-PROMPT"), false);
    assert.equal(result.body.includes("request_json"), false);
    rows.image_quote_snapshots![0]!.user_id = JOB;
    assert.equal((await app.inject({ url, headers })).statusCode, 404);
    rows.workspace_members![0]!.status = "suspended";
    assert.equal((await app.inject({ url, headers })).statusCode, 403);
  } finally { await app.close(); }
});

test("image quote recovery rejects corrupted prices and source pins", async () => {
  const { app, rows } = await setup();
  try {
    const saved = rows.image_quote_snapshots![0]!;
    const credits = saved.quote_json.reservedCredits;
    saved.quote_json.reservedCredits = "1";
    assert.equal((await app.inject({ url: `/workspaces/${WORKSPACE}/image-quotes/${QUOTE}`, headers })).statusCode, 503);
    saved.quote_json.reservedCredits = credits;
    saved.request_json.prompt = "CHANGED-PRIVATE-PROMPT";
    const response = await app.inject({ url: `/workspaces/${WORKSPACE}/image-quotes/${QUOTE}`, headers });
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes("CHANGED-PRIVATE-PROMPT"), false);
  } finally { await app.close(); }
});

test("image catalog fails closed when unconfigured and validates workspace IDs", async () => {
  const { app } = await setup();
  const old = process.env.IMAGE_PRICING_CATALOG_JSON;
  delete process.env.IMAGE_PRICING_CATALOG_JSON;
  try {
    assert.equal((await app.inject({ url: `/workspaces/${WORKSPACE}/image-models`, headers })).statusCode, 503);
    assert.equal((await app.inject({ url: "/workspaces/invalid/image-models", headers })).statusCode, 422);
  } finally {
    if (old === undefined) delete process.env.IMAGE_PRICING_CATALOG_JSON; else process.env.IMAGE_PRICING_CATALOG_JSON = old;
    await app.close();
  }
});

test("model discovery exposes only public options and mirrors the disabled purchase gate", async () => {
  const { app } = await setup();
  const oldCatalog = process.env.IMAGE_PRICING_CATALOG_JSON;
  const oldGate = process.env.IMAGE_QUOTE_PURCHASE_ENABLED;
  process.env.IMAGE_PRICING_CATALOG_JSON = JSON.stringify({ version: "public-v1", approved: true,
    effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", quoteLifetimeSeconds: 300,
    entries: [{ id: "portrait", label: "Portrait", size: "1024x1536", quality: "high", maxPromptBytes: 1000,
      maxReferenceImages: 1, maximumTokens: { text_input: 5, image_input: 5, text_output: 5, image_output: 5 },
      price: { version: "private-price", provider: "openai", model: "fixture-image", rates: ["text_input", "image_input", "text_output", "image_output"].map(dimension => ({ dimension, microUsdPerMillionTokens: "1000000" })) },
      policy: { version: "private-policy", approved: true, microUsdPerCredit: "10", markupBasisPoints: 10000, platformMicroUsd: "0", minimumCredits: "1" } }] });
  delete process.env.IMAGE_QUOTE_PURCHASE_ENABLED;
  try {
    const result = await app.inject({ url: `/workspaces/${WORKSPACE}/image-models`, headers });
    assert.equal(result.statusCode, 200);
    assert.equal(result.json().purchaseAvailable, false);
    assert.deepEqual(result.json().models[0], { id: "portrait", label: "Portrait", model: "fixture-image", size: "1024x1536",
      quality: "high", maxReferenceImages: 1, maxPromptBytes: 1000, priceVersion: "private-price", policyVersion: "private-policy" });
    assert(!result.body.includes("microUsdPerMillionTokens"));
    process.env.IMAGE_QUOTE_PURCHASE_ENABLED = "true";
    assert.equal((await app.inject({ url: `/workspaces/${WORKSPACE}/image-models`, headers })).json().purchaseAvailable, true);
  } finally {
    if (oldCatalog === undefined) delete process.env.IMAGE_PRICING_CATALOG_JSON; else process.env.IMAGE_PRICING_CATALOG_JSON = oldCatalog;
    if (oldGate === undefined) delete process.env.IMAGE_QUOTE_PURCHASE_ENABLED; else process.env.IMAGE_QUOTE_PURCHASE_ENABLED = oldGate;
    await app.close();
  }
});

test("consented image quote creation saves a private offer and supports recovery without generation", async () => {
  const { app, rows } = await setup();
  const old = process.env.IMAGE_PRICING_CATALOG_JSON;
  process.env.IMAGE_PRICING_CATALOG_JSON = JSON.stringify({ version: "fixture", approved: true,
    effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", quoteLifetimeSeconds: 300,
    entries: [{ id: "low-square", label: "Fixture", size: "1024x1024", quality: "low", maxPromptBytes: 10000,
      maxReferenceImages: 1, maximumTokens: { text_input: 100, image_input: 100, text_output: 10, image_output: 100 },
      price: { version: "fixture", provider: "openai", model: "fixture-image", rates:
        ["text_input", "image_input", "text_output", "image_output"].map((dimension) => ({ dimension, microUsdPerMillionTokens: "1000000" })) },
      policy: { version: "fixture", approved: true, microUsdPerCredit: "10", markupBasisPoints: 10000, platformMicroUsd: "0", minimumCredits: "1" } }] });
  const url = `/workspaces/${WORKSPACE}/image-quotes`;
  const payload = { modelId: "low-square", idempotencyKey: "image-quote-test-key", kind: "cover", prompt: "PRIVATE-DIRECTION",
    referenceAssetIds: [], consentToQuoteStorage: true };
  try {
    assert.equal((await app.inject({ method: "POST", url, headers, payload: { ...payload, consentToQuoteStorage: false } })).statusCode, 422);
    assert.equal(rows.image_quote_snapshots!.length, 1);
    const created = await app.inject({ method: "POST", url, headers, payload });
    assert.equal(created.statusCode, 200, created.body);
    assert.equal(created.body.includes("PRIVATE-DIRECTION"), false);
    assert.equal(created.json().purchaseAvailable, false);
    assert.equal(rows.image_quote_snapshots!.length, 2);
    const saved = rows.image_quote_snapshots![1]!;
    assert.ok(saved.request_json.prompt.includes("PRIVATE-DIRECTION"));
    assert.ok(saved.request_json.prompt.includes("Do not render any title"));
    const recovered = await app.inject({ url: `${url}/${created.json().quoteId}`, headers });
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().quote.status, "ready");
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).json().quoteId, created.json().quoteId);
    assert.equal(rows.image_quote_snapshots!.length, 2);
    delete process.env.IMAGE_PRICING_CATALOG_JSON;
    const lookup = await app.inject({ method: "POST", url: `${url}/recover`, headers,
      payload: { idempotencyKey: payload.idempotencyKey } });
    assert.equal(lookup.statusCode, 200, lookup.body);
    assert.equal(lookup.json().quoteId, created.json().quoteId);
    assert.equal(lookup.headers["cache-control"], "private, no-store");
    assert.equal(lookup.body.includes("PRIVATE-DIRECTION"), false);
    assert.equal((await app.inject({ method: "POST", url: `${url}/recover`, headers,
      payload: { idempotencyKey: "unknown-key" } })).statusCode, 404);
    assert.equal(rows.image_quote_snapshots!.length, 2);
    rows.workspace_members![0]!.role = "viewer";
    assert.equal((await app.inject({ method: "POST", url, headers, payload })).statusCode, 403);
  } finally {
    if (old === undefined) delete process.env.IMAGE_PRICING_CATALOG_JSON; else process.env.IMAGE_PRICING_CATALOG_JSON = old;
    await app.close();
  }
});
