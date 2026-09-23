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
    source_sha256: "a".repeat(64), catalog_json: {}, generation_job_id: JOB, status: "queued",
  };
  const state: { request: Record<string, unknown>; proposal: Record<string, unknown> | null; funded: string; jobStatus: string; saved: Record<string, unknown> | null; materialized: Record<string, unknown>[] } = {
    request, proposal: null, funded: "held", jobStatus: "running", saved: null, materialized: [],
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
      const query: { select: () => typeof query; eq: () => typeof query; maybeSingle: () => Promise<unknown> } = {
        select: () => query, eq: () => query,
        maybeSingle: async () => {
          if (table === "story_blueprint_quote_proposals") return { data: state.proposal, error: null };
          if (table === "story_blueprint_quote_requests") return { data: state.request, error: null };
          if (table === "story_blueprint_generation_results") return { data: state.proposal ? { candidate_json: candidate } : null, error: null };
          if (table === "funded_usage_quotes") return { data: { status: state.funded }, error: null };
          if (table === "ai_jobs") return { data: { status: state.jobStatus }, error: null };
          return { data: null, error: { message: `unexpected service table ${table}` } };
        },
      };
      return query;
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
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
  const { app } = await appWith();
  t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/story-blueprint/quote-requests/${REQUEST}`, headers: auth });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(response.json(), { request: { id: REQUEST, status: "queued" }, proposal: null });
  assert.equal(response.body.includes("source_snapshot_json"), false);
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
