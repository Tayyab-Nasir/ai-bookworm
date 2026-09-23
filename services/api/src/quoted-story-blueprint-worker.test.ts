import assert from "node:assert/strict";
import { test } from "node:test";
import { runOneQuotedStoryBlueprintJob } from "./lib/quoted-story-blueprint-worker.js";
import { quoteUsage } from "./lib/usage-pricing.js";
import type { SupabaseClient } from "./lib/supabase.js";

const ids = Array.from({ length: 6 }, (_, index) => `f1000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const [job, workspace, user, lease, proposalId, requestId] = ids;
const blueprintId = "f1000000-0000-4000-8000-000000000007";
const bookId = "f1000000-0000-4000-8000-000000000008";
const hash = "e".repeat(64);
const sourceHash = "a".repeat(64);
const story = {
  workingTitle: "The Paper Moon", premise: "A printer finds a moon in her press.", readerPromise: "A luminous mystery.",
  genre: "Fantasy", tone: "Lyrical", pointOfView: "Close third", tense: "Past", targetWordCount: 65000,
  synopsis: "A printer follows impossible pages through a sleeping city.", theme: "Truth survives revision.", notes: "Protect the quiet ending.",
};
const plan = [{ id: "f1000000-0000-4000-8000-000000000009", title: "Ink at midnight", purpose: "Set the mystery", summary: "A fresh page prints a moon.", targetWords: 1800 }];
const candidate = {
  suggestionKind: "story_blueprint_candidate" as const, status: "pending" as const,
  story, chapterPlan: [{ ...plan[0], id: "f1000000-0000-4000-8000-000000000010", title: "The moon prints" }],
  rationale: "The revised opening foregrounds the central image while retaining the author's premise.", confidence: 0.91,
};

function fixture() {
  const quote = quoteUsage({
    scope: { jobId: job, workspaceId: workspace, userId: user, inputSha256: hash },
    price: { version: "test", provider: "openai", model: "test-model", rates: [
      { dimension: "text_input" as const, microUsdPerMillionTokens: "1000000" },
      { dimension: "text_cached_input" as const, microUsdPerMillionTokens: "100000" },
      { dimension: "text_output" as const, microUsdPerMillionTokens: "2000000" },
    ] },
    policy: { version: "test", approved: true, microUsdPerCredit: "1000", minimumCredits: "1", platformMicroUsd: "0", markupBasisPoints: 10000 },
    maximumTokens: [
      { dimension: "text_input" as const, tokens: "1000" },
      { dimension: "text_cached_input" as const, tokens: "1000" },
      { dimension: "text_output" as const, tokens: "1000" },
    ],
    createdAt: "2026-09-20T00:00:00.000Z", expiresAt: "2026-09-20T00:15:00.000Z",
  });
  const funded = { job_id: job, user_id: user, workspace_id: workspace, quote_json: quote,
    reserved_credits: Number(quote.reservedCredits), status: "held", settlement_json: null as unknown };
  const proposal = {
    id: proposalId, request_id: requestId, user_id: user, workspace_id: workspace, book_id: bookId,
    blueprint_id: blueprintId, source_revision: 3, source_snapshot_json: { details: story, chapterPlan: plan },
    book_snapshot_json: { title: story.workingTitle, author: "Author", language: "en" },
    source_sha256: sourceHash, generation_request_sha256: hash, generation_job_id: job, accepted_job_id: job,
  };
  const state = {
    dispatched: false, completeFails: false, completion: null as { receipt: unknown; candidate: unknown } | null,
    calls: [] as string[], requests: [] as Record<string, unknown>[], preflightRequests: [] as Record<string, unknown>[], events: [] as string[],
  };
  const sb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push(name);
      if (name === "claim_quoted_story_blueprint_job") return { data: [{
        id: job, workspace_id: workspace, book_id: bookId, created_by: user, billing_mode: "quoted", lease_token: lease,
        input_ref: { proposalId, requestId, blueprintId, sourceRevision: 3, sourceSha256: sourceHash, generationRequestSha256: hash },
      }], error: null };
      if (name === "claim_funded_dispatch") {
        state.events.push("dispatch"); const allowed = !state.dispatched; state.dispatched = true; return { data: allowed, error: null };
      }
      if (name === "renew_story_blueprint_generation_lease") return { data: true, error: null };
      if (name === "record_story_blueprint_generation_result") {
        state.completion = { receipt: structuredClone(args.p_provider_receipt_json), candidate: structuredClone(args.p_candidate_json) };
        return { data: { ai_job_id: job }, error: null };
      }
      if (name === "settle_funded_usage_quote") {
        funded.status = (args.p_settlement as { status: string }).status === "settle" ? "settled" : "requires_review";
        funded.settlement_json = structuredClone(args.p_settlement);
        return { data: funded, error: null };
      }
      if (name === "mark_story_blueprint_generation_requires_review") return { data: true, error: null };
      if (name === "complete_quoted_story_blueprint_generation") {
        return state.completeFails ? { data: null, error: { message: "offline" } } : { data: { id: job, status: "succeeded" }, error: null };
      }
      throw new Error(name);
    },
    from: (table: string) => {
      const query: Record<string, unknown> = {};
      query.select = () => query;
      query.eq = () => query;
      query.maybeSingle = async () => {
        if (table === "funded_usage_quotes") return { data: funded, error: null };
        if (table === "story_blueprint_quote_proposals") return { data: proposal, error: null };
        if (table === "story_blueprint_generation_results") return {
          data: state.completion ? { provider_receipt_json: state.completion.receipt, candidate_json: state.completion.candidate } : null,
          error: null,
        };
        return { data: null, error: { message: `unexpected table ${table}` } };
      };
      return query;
    },
  } as unknown as SupabaseClient;
  const fetcher: typeof fetch = async (url, init) => {
    const request = JSON.parse(String(init?.body));
    if (String(url).endsWith("/v1/ai/story-blueprint/request-hash")) {
      state.events.push("preflight");
      state.preflightRequests.push(request);
      return Response.json({ inputSha256: hash, model: "test-model" });
    }
    state.events.push("generate");
    state.requests.push(request);
    return Response.json({
      status: "succeeded", provider: "openai", model: "test-model", requestId: "req-blueprint-test",
      suggestions: [candidate], usage: {
        inputTokens: 120, outputTokens: 600, estimatedCostUsd: 0.001,
        measuredTokens: [
          { dimension: "text_input", tokens: "100" },
          { dimension: "text_cached_input", tokens: "20" },
          { dimension: "text_output", tokens: "600" },
        ],
      },
    });
  };
  return { sb, state, fetcher };
}

test("quoted Story Blueprint persists a private receipt and recovers completion without another generation", async () => {
  const f = fixture();
  f.state.completeFails = true;
  assert.equal((await runOneQuotedStoryBlueprintJob(f.sb, { fetcher: f.fetcher })).status, "completion_unknown");
  assert.equal(f.state.preflightRequests.length, 1);
  assert.equal(f.state.requests.length, 1);
  assert.ok(f.state.completion);
  const request = f.state.requests[0];
  assert.equal(request.expectedInputSha256, hash);
  assert.equal(request.maxOutputTokens, 1000);
  assert.deepEqual(request.contextPolicy, {
    includeBookBible: false, includeStyleGuide: false, includeRelatedContext: false, semanticTopK: 5, maxTokens: 16000,
  });
  assert.equal((request.input as { storyBlueprint: { details: { workingTitle: string } } }).storyBlueprint.details.workingTitle, story.workingTitle);
  assert.equal("candidate" in request, false);
  assert.ok(f.state.events.indexOf("preflight") < f.state.events.indexOf("dispatch"));

  f.state.completeFails = false;
  assert.equal((await runOneQuotedStoryBlueprintJob(f.sb, { fetcher: f.fetcher })).status, "succeeded");
  assert.equal(f.state.requests.length, 1);
  assert.equal(f.state.preflightRequests.length, 1);
  assert.equal(f.state.calls.filter((name) => name === "claim_funded_dispatch").length, 1);
  assert.equal(f.state.calls.filter((name) => name === "complete_quoted_story_blueprint_generation").length, 2);
});

test("over-bound Story Blueprint usage retains its hold for review and never completes", async () => {
  const f = fixture();
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/v1/ai/story-blueprint/request-hash")) return f.fetcher(url, init);
    const response = await f.fetcher(url, init);
    const value = await response.json() as Record<string, unknown>;
    value.usage = { inputTokens: 100, outputTokens: 1001, estimatedCostUsd: 0.001, measuredTokens: [
      { dimension: "text_input", tokens: "100" }, { dimension: "text_cached_input", tokens: "0" }, { dimension: "text_output", tokens: "1001" },
    ] };
    return Response.json(value);
  };
  const outcome = await runOneQuotedStoryBlueprintJob(f.sb, { fetcher });
  assert.equal(outcome.status, "requires_review");
  assert.ok(f.state.completion);
  assert.ok(!f.state.calls.includes("complete_quoted_story_blueprint_generation"));
});

test("a provider model mismatch becomes a financial-review hold without redispatch or completion", async () => {
  const f = fixture();
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/v1/ai/story-blueprint/request-hash")) return f.fetcher(url, init);
    const response = await f.fetcher(url, init);
    const value = await response.json() as Record<string, unknown>;
    value.model = "unexpected-provider-model";
    return Response.json(value);
  };
  const outcome = await runOneQuotedStoryBlueprintJob(f.sb, { fetcher });
  assert.equal(outcome.status, "requires_review");
  assert.ok(f.state.completion);
  assert.equal(f.state.calls.filter((name) => name === "claim_funded_dispatch").length, 1);
  assert.ok(!f.state.calls.includes("complete_quoted_story_blueprint_generation"));
});

test("a mismatched preflight never commits funded dispatch or calls the provider", async () => {
  const f = fixture();
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/v1/ai/story-blueprint/request-hash")) {
      f.state.preflightRequests.push(JSON.parse(String(init?.body)));
      return Response.json({ inputSha256: "b".repeat(64), model: "test-model" });
    }
    return f.fetcher(url, init);
  };
  assert.equal((await runOneQuotedStoryBlueprintJob(f.sb, { fetcher })).status, "completion_unknown");
  assert.equal(f.state.preflightRequests.length, 1);
  assert.equal(f.state.calls.includes("claim_funded_dispatch"), false);
  assert.equal(f.state.requests.length, 0);
});

test("a post-dispatch provider failure enters explicit financial review", async () => {
  const f = fixture();
  const fetcher: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/v1/ai/story-blueprint/request-hash")) return f.fetcher(url, init);
    return new Response("unavailable", { status: 503 });
  };
  assert.equal((await runOneQuotedStoryBlueprintJob(f.sb, { fetcher })).status, "requires_review");
  assert.equal(f.state.calls.filter((name) => name === "claim_funded_dispatch").length, 1);
  assert.ok(f.state.calls.includes("mark_story_blueprint_generation_requires_review"));
  assert.equal(f.state.calls.includes("record_story_blueprint_generation_result"), false);
});
