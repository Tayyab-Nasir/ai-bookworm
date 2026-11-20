import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { makeAuthPlugin } from "./plugins/auth.js";
import { storyBlueprintProposalRoutes } from "./routes/story-blueprint-proposals.js";
import { quoteStoryBlueprintUsage, storyBlueprintCatalogSnapshot } from "./lib/story-blueprint-pricing.js";

const BOOK = "b1000000-0000-4000-8000-000000000001";
const WORKSPACE = "b1000000-0000-4000-8000-000000000002";
const USER = "b1000000-0000-4000-8000-000000000003";
const BLUEPRINT = "b1000000-0000-4000-8000-000000000004";
const REQUEST = "b1000000-0000-4000-8000-000000000005";
const JOB = "b1000000-0000-4000-8000-000000000006";
const PROPOSAL = "b1000000-0000-4000-8000-000000000007";
const INPUT_HASH = "d".repeat(64);

const story = {
  workingTitle: "The Clockmaker's Orchard", premise: "An orchard keeps time for a fading city.",
  readerPromise: "A tender mystery.", genre: "Literary fantasy", tone: "Warm and precise",
  pointOfView: "Close third", tense: "Past", targetWordCount: 80000,
  synopsis: "A clockmaker follows a broken bell into a buried season.", theme: "Memory and repair", notes: "Keep the conflict intimate.",
};
const plan = [{ id: "b1000000-0000-4000-8000-000000000011", title: "The bell", purpose: "Open the mystery", summary: "A bell rings from the orchard.", targetWords: 1800 }];
const candidate = {
  suggestionKind: "story_blueprint_candidate", status: "pending", story: { ...story, workingTitle: "The Clockmaker's Orchard" },
  chapterPlan: [{ ...plan[0], id: "b1000000-0000-4000-8000-000000000012", title: "The bell wakes" }],
  rationale: "The opening turning point is clearer while preserving the author's intention.", confidence: 0.83,
};
const catalogRaw = JSON.stringify({
  version: "blueprint-test-catalog", approved: true, approvalReference: "synthetic-test-only",
  effectiveAt: "2020-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", quoteLifetimeSeconds: 600,
  entries: [{ id: "story", label: "Story test", maxInputTokens: 1000, maxOutputTokens: 2000,
    price: { version: "blueprint-price-v1", provider: "openai", model: "test-model-2026-09-01", rates: [
      { dimension: "text_input", microUsdPerMillionTokens: "1000000" },
      { dimension: "text_cached_input", microUsdPerMillionTokens: "100000" },
      { dimension: "text_output", microUsdPerMillionTokens: "2000000" },
    ] },
    policy: { version: "blueprint-policy-v1", approved: true, microUsdPerCredit: "1000", markupBasisPoints: 15000, platformMicroUsd: "100", minimumCredits: "1" },
  }],
});

function createFake(role = "writer") {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const request = {
    id: REQUEST, user_id: USER, workspace_id: WORKSPACE, book_id: BOOK, blueprint_id: BLUEPRINT, source_revision: 3,
    source_snapshot_json: { details: story, chapterPlan: plan }, book_snapshot_json: { title: "The Clockmaker's Orchard", author: "Author", language: "en" },
    source_sha256: "a".repeat(64), catalog_json: {}, generation_job_id: JOB, status: "queued", idempotency_key: "blueprint-quote-one",
  };
  const state: { request: Record<string, unknown>; proposal: Record<string, unknown> | null; history: Record<string, unknown>[]; funded: string; jobStatus: string; saved: Record<string, unknown> | null; materialized: Record<string, unknown>[]; closeError: string | null; resolveState: string } = {
    request, proposal: null, history: [], funded: "held", jobStatus: "running", saved: null, materialized: [], closeError: null, resolveState: "open",
  };
  const user = {
    auth: { getUser: async (token: string) => ({ data: { user: token === "good" ? { id: USER } : null }, error: null }) },
    from(table: string) {
      const query: { select: () => typeof query; eq: () => typeof query; maybeSingle: () => Promise<unknown>; then: (resolve: (value: unknown) => unknown) => Promise<unknown> } = {
        select: () => query, eq: () => query,
        maybeSingle: async () => {
          if (table === "books") return { data: { id: BOOK, workspace_id: WORKSPACE, title: "The Clockmaker's Orchard", author_name: "Author", language: "en" }, error: null };
          if (table === "workspace_members") return { data: role ? { role } : null, error: null };
          if (table === "story_blueprint_generation_results") return { data: state.proposal ? { candidate_json: candidate } : null, error: null };
          if (table === "story_blueprint_materializations") return { data: state.materialized, error: null };
          if (table === "funded_usage_quotes") return { data: { status: state.funded }, error: null };
          if (table === "ai_jobs") return { data: { status: state.jobStatus }, error: null };
          return { data: null, error: { message: `unexpected user table ${table}` } };
        },
        then: async (resolve) => resolve(table === "story_blueprint_materializations"
          ? { data: state.materialized, error: null }
          : { data: null, error: { message: `unexpected user list table ${table}` } }),
      };
      return query;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "save_story_blueprint") {
        state.saved = { id: BLUEPRINT, revision: 4, details_json: args.p_details, chapter_plan_json: args.p_chapters };
        return { data: state.saved, error: null };
      }
      throw new Error(name);
    },
  };
  const service = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      let limit = 51, before: { createdAt: string; id: string } | null = null;
      const query: { select: () => typeof query; eq: (key: string, value: unknown) => typeof query; order: () => typeof query; limit: (value: number) => typeof query; or: (value: string) => typeof query; maybeSingle: () => Promise<unknown>; then: (resolve: (value: unknown) => unknown) => Promise<unknown> } = {
        select: () => query, eq: (key, value) => { filters[key] = value; return query; }, order: () => query,
        limit: (value) => { limit = value; return query; },
        or: (value) => { const match = /^created_at\.lt\.([^,]+),and\(created_at\.eq\.[^,]+,id\.lt\.([^)]+)\)$/.exec(value); if (match) before = { createdAt: match[1], id: match[2] }; return query; },
        maybeSingle: async () => {
          if (table === "story_blueprint_quote_proposals" || table === "story_blueprint_quote_requests") {
            const row = table === "story_blueprint_quote_proposals" ? state.proposal : state.request;
            return { data: row && Object.entries(filters).every(([key, value]) => row[key] === value) ? row : null, error: null };
          }
          if (table === "story_blueprint_generation_results") return { data: state.proposal ? { candidate_json: candidate } : null, error: null };
          if (table === "funded_usage_quotes") return { data: { status: state.funded }, error: null };
          if (table === "ai_jobs") return { data: { status: state.jobStatus }, error: null };
          return { data: null, error: { message: `unexpected service table ${table}` } };
        },
        then: async (resolve) => {
          if (table !== "story_blueprint_quote_proposals") return resolve({ data: null, error: { message: "unexpected list" } });
          const rows = state.history.filter(row => Object.entries(filters).every(([key, value]) => row[key] === value))
            .filter(row => !before || String(row.created_at) < before.createdAt || (row.created_at === before.createdAt && String(row.id) < before.id))
            .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)) || String(b.id).localeCompare(String(a.id))).slice(0, limit);
          return resolve({ data: rows, error: null });
        },
      };
      return query;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === "close_story_blueprint_quote_request" && state.closeError) return { data: null, error: { code: state.closeError } };
      if (name === "close_story_blueprint_quote_request") return { data: args.p_idempotency_key === state.request.idempotency_key
        ? { state: "exists", requestId: state.request.id } : { state: "closed" }, error: null };
      if (name === "resolve_story_blueprint_quote") return { data: { state: state.resolveState }, error: null };
      if (name === "request_story_blueprint_quote") return { data: { ...state.request, catalog_json: args.p_catalog_json }, error: null };
      if (name === "create_story_blueprint_quote_proposal") {
        const usage = args.p_usage_quote as Record<string, unknown>;
        state.proposal = {
          id: PROPOSAL, request_id: REQUEST, user_id: USER, workspace_id: WORKSPACE, book_id: BOOK, blueprint_id: BLUEPRINT,
          source_revision: 3, source_sha256: request.source_sha256, generation_request_sha256: (usage.scope as { inputSha256: string }).inputSha256,
          generation_job_id: JOB, usage_quote_json: usage, reserved_credits: Number(usage.reservedCredits),
          expires_at: usage.expiresAt, accepted_at: null, accepted_job_id: null,
        };
        return { data: state.proposal, error: null };
      }
      if (name === "accept_story_blueprint_quote") {
        state.proposal = { ...state.proposal!, accepted_at: new Date().toISOString(), accepted_job_id: JOB };
        return { data: { id: JOB, status: "queued" }, error: null };
      }
      throw new Error(name);
    },
  };
  return { factory: (token?: string) => token ? user : service, state, calls };
}

async function appWith(role?: string) {
  const fake = createFake(role);
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(makeAuthPlugin(fake.factory as never));
  await app.register(async (v1) => storyBlueprintProposalRoutes(v1), { prefix: "/v1" });
  return { app, ...fake };
}

const quoteUrl = `/v1/books/${BOOK}/story-blueprint/quotes`;
const auth = { authorization: "Bearer good" };

test("proposal quote is explicitly consented, queued, and does not return source snapshot", async (t) => {
  const old = process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON;
  process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON = catalogRaw;
  t.after(() => { if (old === undefined) delete process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON; else process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON = old; });
  const { app, calls } = await appWith();
  t.after(() => app.close());

  const missingConsent = await app.inject({ method: "POST", url: quoteUrl, headers: auth, payload: { modelId: "story", idempotencyKey: "blueprint-quote-one" } });
  assert.equal(missingConsent.statusCode, 422);
  assert.equal(calls.length, 0);

  const response = await app.inject({ method: "POST", url: quoteUrl, headers: auth, payload: {
    modelId: "story", idempotencyKey: "blueprint-quote-one", allowProviderTokenCounting: true,
  } });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json(), { request: { id: REQUEST, status: "queued" }, proposal: null });
  assert.equal(response.body.includes("source_snapshot_json"), false);
  assert.equal(response.body.includes("Keep the conflict intimate"), false);
  assert.equal(calls[0].name, "request_story_blueprint_quote");
  assert.equal(calls.length, 1);
});

test("queued Story Blueprint quote recovery returns only a safe request projection", async (t) => {
  const { app, state } = await appWith();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/story-blueprint/quote-requests/${REQUEST}`, headers: auth });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json(), { request: { id: REQUEST, status: "queued" }, proposal: null });
  assert.equal(response.body.includes("source_snapshot_json"), false);
  state.proposal = { request_id: REQUEST, user_id: "b1000000-0000-4000-8000-000000000099" };
  const invalid = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/story-blueprint/quote-requests/${REQUEST}`, headers: auth });
  assert.equal(invalid.statusCode, 503, "a malformed or foreign proposal must not be projected to this author");
});

test("original quote identity recovers only this author's request without starting work", async (t) => {
  const { app, state, calls } = await appWith();
  t.after(() => app.close());
  const url = `/v1/books/${BOOK}/story-blueprint/quote-requests/recover`;
  const recover = (idempotencyKey: string, headers: Record<string, string> = auth) => app.inject({ method: "POST", url, headers, payload: { idempotencyKey } });
  const found = await recover("blueprint-quote-one");
  assert.equal(found.statusCode, 200, found.body);
  assert.equal(found.headers["cache-control"], "private, no-store");
  assert.deepEqual(found.json(), { request: { id: REQUEST, status: "queued" }, proposal: null });
  assert.doesNotMatch(found.body, /Keep the conflict intimate|source_snapshot_json|idempotency_key/);
  assert.deepEqual((await recover("a-different-key")).json(), { request: null, proposal: null });
  state.request.user_id = "b1000000-0000-4000-8000-000000000099";
  assert.deepEqual((await recover("blueprint-quote-one")).json(), { request: null, proposal: null });
  const changed = await recover("blueprint-quote-one", { ...auth, "x-bookworm-actor": "b1000000-0000-4000-8000-000000000099" });
  assert.equal(changed.statusCode, 409);
  assert.equal(calls.length, 0, "recovery must never queue a count, place a hold, or generate output");
});

test("closing an absent original identity fences it, while an existing request remains recoverable", async (t) => {
  const { app, calls, state } = await appWith();
  t.after(() => app.close());
  const url = `/v1/books/${BOOK}/story-blueprint/quote-requests/close`;
  const close = (idempotencyKey: string) => app.inject({ method: "POST", url, headers: auth, payload: { idempotencyKey } });
  const absent = await close("never-queued-key");
  assert.equal(absent.statusCode, 200, absent.body);
  assert.equal(absent.headers["cache-control"], "private, no-store");
  assert.deepEqual(absent.json(), { state: "closed", request: null, proposal: null });
  const existing = await close("blueprint-quote-one");
  assert.equal(existing.statusCode, 200, existing.body);
  assert.deepEqual(existing.json(), { state: "exists", request: { id: REQUEST, status: "queued" }, proposal: null });
  state.closeError = "40001";
  assert.equal((await close("unconfirmed-race-key")).statusCode, 409);
  state.closeError = "PGRST202";
  const unavailable = await close("not-migrated-yet");
  assert.equal(unavailable.statusCode, 503);
  assert.match(unavailable.body, /Could not confirm whether this quote request was closed/);
  assert.ok(calls.every(call => call.name === "close_story_blueprint_quote_request"));
});

test("quote resolution reports only the original owner's locked status and rejects malformed outcomes", async (t) => {
  const { app, state, calls } = await appWith();
  t.after(() => app.close());
  state.proposal = { id: PROPOSAL, request_id: REQUEST, user_id: USER, workspace_id: WORKSPACE, book_id: BOOK,
    blueprint_id: BLUEPRINT, source_revision: 3, source_sha256: "a".repeat(64), generation_request_sha256: INPUT_HASH,
    generation_job_id: JOB, usage_quote_json: {}, reserved_credits: 5,
    expires_at: "2099-01-01T00:00:00.000Z", accepted_at: null, accepted_job_id: null };
  const url = `/v1/books/${BOOK}/story-blueprint/quotes/${PROPOSAL}/resolve`;
  assert.equal((await app.inject({ method: "POST", url, headers: auth, payload: { source: "must not be accepted" } })).statusCode, 422);
  for (const expected of ["open", "unusable", "accepted"]) {
    state.resolveState = expected;
    const response = await app.inject({ method: "POST", url, headers: auth, payload: {} });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.deepEqual(response.json(), { state: expected });
  }
  state.resolveState = "unknown";
  assert.equal((await app.inject({ method: "POST", url, headers: auth, payload: {} })).statusCode, 503);
  state.proposal.user_id = "b1000000-0000-4000-8000-000000000099";
  assert.equal((await app.inject({ method: "POST", url, headers: auth, payload: {} })).statusCode, 404);
  assert.ok(calls.every(call => call.name === "resolve_story_blueprint_quote"));
});

test("proposal history is author-scoped, private, and paginates without source snapshots", async (t) => {
  const { app, state } = await appWith();
  t.after(() => app.close());
  const snapshot = storyBlueprintCatalogSnapshot(catalogRaw, { modelId: "story", now: new Date().toISOString() });
  const usage = quoteStoryBlueprintUsage(snapshot, { scope: { jobId: JOB, workspaceId: WORKSPACE, userId: USER, inputSha256: INPUT_HASH }, countedInputTokens: 120, now: new Date().toISOString() });
  const base = { request_id: REQUEST, user_id: USER, workspace_id: WORKSPACE, book_id: BOOK, blueprint_id: BLUEPRINT,
    source_revision: 3, source_snapshot_json: { details: story, chapterPlan: plan }, source_sha256: "a".repeat(64),
    generation_request_sha256: INPUT_HASH, generation_job_id: JOB, usage_quote_json: usage,
    reserved_credits: Number(usage.reservedCredits), expires_at: usage.expiresAt, accepted_at: null, accepted_job_id: null };
  const olderId = "b1000000-0000-4000-8000-000000000008";
  const tiedId = "b1000000-0000-4000-8000-000000000006";
  state.history = [
    { ...base, id: PROPOSAL, created_at: "2026-10-01T00:00:00.000Z" },
    { ...base, id: tiedId, created_at: "2026-10-01T00:00:00.000Z" },
    { ...base, id: olderId, created_at: "2026-09-01T00:00:00.000Z" },
    { ...base, id: "b1000000-0000-4000-8000-000000000009", user_id: "b1000000-0000-4000-8000-000000000099", created_at: "2026-11-01T00:00:00.000Z" },
  ];
  const url = `/v1/books/${BOOK}/story-blueprint/proposals`;
  const first = await app.inject({ method: "GET", url: `${url}?limit=1`, headers: auth });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(first.headers["cache-control"], "private, no-store");
  assert.equal(first.json().proposals[0].id, PROPOSAL);
  assert.deepEqual(first.json().nextCursor, { createdAt: "2026-10-01T00:00:00.000Z", id: PROPOSAL });
  assert.doesNotMatch(first.body, /source_snapshot_json|Keep the conflict intimate|usage_quote_json/);
  const second = await app.inject({ method: "GET", url: `${url}?limit=1&beforeCreatedAt=${encodeURIComponent(first.json().nextCursor.createdAt)}&beforeId=${PROPOSAL}`, headers: auth });
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(second.json().proposals[0].id, tiedId);
  const third = await app.inject({ method: "GET", url: `${url}?limit=1&beforeCreatedAt=${encodeURIComponent(second.json().nextCursor.createdAt)}&beforeId=${tiedId}`, headers: auth });
  assert.equal(third.statusCode, 200, third.body);
  assert.equal(third.json().proposals[0].id, olderId);
  assert.equal(third.json().nextCursor, null);
  assert.equal((await app.inject({ method: "GET", url: `${url}?beforeId=${PROPOSAL}`, headers: auth })).statusCode, 422);
});

test("proposal output is hidden until settled and apply uses original source revision only", async (t) => {
  const old = process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON;
  process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON = catalogRaw;
  t.after(() => { if (old === undefined) delete process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON; else process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON = old; });
  const { app, state, calls } = await appWith();
  t.after(() => app.close());
  const snapshot = storyBlueprintCatalogSnapshot(catalogRaw, { modelId: "story", now: new Date().toISOString() });
  const usage = quoteStoryBlueprintUsage(snapshot, { scope: { jobId: JOB, workspaceId: WORKSPACE, userId: USER, inputSha256: INPUT_HASH }, countedInputTokens: 120, now: new Date().toISOString() });
  state.proposal = {
    id: PROPOSAL, request_id: REQUEST, user_id: USER, workspace_id: WORKSPACE, book_id: BOOK, blueprint_id: BLUEPRINT,
    source_revision: 3, source_snapshot_json: { details: story, chapterPlan: plan }, source_sha256: "a".repeat(64), generation_request_sha256: INPUT_HASH, generation_job_id: JOB,
    usage_quote_json: usage, reserved_credits: Number(usage.reservedCredits), expires_at: usage.expiresAt, accepted_at: new Date().toISOString(), accepted_job_id: JOB,
  };
  const resultUrl = `/v1/books/${BOOK}/story-blueprint/proposals/${PROPOSAL}`;
  const pending = (await app.inject({ method: "GET", url: resultUrl, headers: auth })).json();
  assert.deepEqual(pending.candidate, null);
  assert.equal(pending.reviewStatus, "pending");
  state.funded = "requires_review";
  const review = (await app.inject({ method: "GET", url: resultUrl, headers: auth })).json();
  assert.deepEqual(review.candidate, null);
  assert.equal(review.reviewStatus, "requires_review");
  state.funded = "held";
  state.jobStatus = "failed";
  assert.equal((await app.inject({ method: "GET", url: resultUrl, headers: auth })).json().reviewStatus, "requires_review", "a failed job with an unresolved hold cannot be dismissed");
  state.funded = "cancelled";
  assert.equal((await app.inject({ method: "GET", url: resultUrl, headers: auth })).json().reviewStatus, "failed");
  state.funded = "settled";
  state.jobStatus = "succeeded";
  const ready = await app.inject({ method: "GET", url: resultUrl, headers: auth });
  assert.equal(ready.statusCode, 200, ready.body);
  assert.deepEqual(ready.json().candidate, candidate);

  const stale = await app.inject({ method: "POST", url: `${resultUrl}/apply`, headers: auth, payload: { expectedRevision: 4 } });
  assert.equal(stale.statusCode, 409);
  const applied = await app.inject({ method: "POST", url: `${resultUrl}/apply`, headers: auth, payload: { expectedRevision: 3 } });
  assert.equal(applied.statusCode, 200, applied.body);
  assert.deepEqual(calls.at(-1), { name: "save_story_blueprint", args: {
    p_book_id: BOOK, p_expected_revision: 3, p_details: candidate.story, p_chapters: candidate.chapterPlan,
  } });
});

test("viewer cannot queue token counting or a paid proposal", async (t) => {
  const old = process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON;
  process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON = catalogRaw;
  t.after(() => { if (old === undefined) delete process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON; else process.env.STORY_BLUEPRINT_PRICING_CATALOG_JSON = old; });
  const { app, calls } = await appWith("viewer");
  t.after(() => app.close());
  const response = await app.inject({ method: "POST", url: quoteUrl, headers: auth, payload: {
    modelId: "story", idempotencyKey: "blueprint-quote-viewer", allowProviderTokenCounting: true,
  } });
  assert.equal(response.statusCode, 403);
  assert.equal(calls.length, 0);
});

test("a proposal that changes a materialized plan item cannot apply", async (t) => {
  const { app, state, calls } = await appWith();
  t.after(() => app.close());
  const snapshot = storyBlueprintCatalogSnapshot(catalogRaw, { modelId: "story", now: new Date().toISOString() });
  const usage = quoteStoryBlueprintUsage(snapshot, { scope: { jobId: JOB, workspaceId: WORKSPACE, userId: USER, inputSha256: INPUT_HASH }, countedInputTokens: 120, now: new Date().toISOString() });
  state.proposal = {
    id: PROPOSAL, request_id: REQUEST, user_id: USER, workspace_id: WORKSPACE, book_id: BOOK, blueprint_id: BLUEPRINT,
    source_revision: 3, source_snapshot_json: { details: story, chapterPlan: plan }, source_sha256: "a".repeat(64), generation_request_sha256: INPUT_HASH, generation_job_id: JOB,
    usage_quote_json: usage, reserved_credits: Number(usage.reservedCredits), expires_at: usage.expiresAt, accepted_at: new Date().toISOString(), accepted_job_id: JOB,
  };
  state.funded = "settled";
  state.jobStatus = "succeeded";
  state.materialized = [{ blueprint_chapter_id: plan[0].id }];
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/story-blueprint/proposals/${PROPOSAL}/apply`, headers: auth, payload: { expectedRevision: 3 } });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(calls.some((call) => call.name === "save_story_blueprint"), false);
});
