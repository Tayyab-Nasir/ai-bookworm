import assert from "node:assert/strict";
import { test } from "node:test";
import type { SupabaseClient } from "./lib/supabase.js";
import { runOneStoryBlueprintQuoteStep } from "./lib/story-blueprint-quote-worker.js";

const ids = Array.from({ length: 6 }, (_, index) => `e1000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`);
const [requestId, userId, workspaceId, bookId, blueprintId, jobId] = ids;
const lease = "e1000000-0000-4000-8000-000000000007";
const catalog = {
  version: "test-price-v1", catalogVersion: "test-catalog", model: "test-model", provider: "openai", approved: true,
  expiresAt: "2099-01-01T00:00:00.000Z", quoteLifetimeSeconds: 600, maxInputTokens: 1000, maxOutputTokens: 2000,
  price: { version: "test-price-v1", provider: "openai", model: "test-model", rates: [
    { dimension: "text_input", microUsdPerMillionTokens: "1000000" },
    { dimension: "text_cached_input", microUsdPerMillionTokens: "100000" },
    { dimension: "text_output", microUsdPerMillionTokens: "2000000" },
  ] },
  policy: { version: "test-policy-v1", approved: true, microUsdPerCredit: "1000", markupBasisPoints: 15000, platformMicroUsd: "0", minimumCredits: "1" },
};
const story = {
  workingTitle: "The Paper Moon", premise: "A printer finds a moon in her press.", readerPromise: "A luminous mystery.",
  genre: "Fantasy", tone: "Lyrical", pointOfView: "Close third", tense: "Past", targetWordCount: 65000,
  synopsis: "A printer follows impossible pages.", theme: "Truth", notes: "Quiet ending.",
};

function fixture() {
  const request = {
    id: requestId, user_id: userId, workspace_id: workspaceId, book_id: bookId, blueprint_id: blueprintId,
    source_revision: 3, source_snapshot_json: { details: story, chapterPlan: [] },
    book_snapshot_json: { title: story.workingTitle, author: "Author", language: "en" },
    catalog_json: catalog, generation_job_id: jobId, lease_token: lease, status: "counting",
  };
  const state = { calls: [] as { name: string; args: Record<string, unknown> }[], providerBodies: [] as Record<string, unknown>[] };
  const sb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push({ name, args });
      if (name === "claim_story_blueprint_quote_request") return { data: [request], error: null };
      if (name === "create_story_blueprint_quote_proposal") return { data: { id: requestId }, error: null };
      if (name === "fail_story_blueprint_quote_request") return { data: true, error: null };
      throw new Error(name);
    },
  } as unknown as SupabaseClient;
  const fetcher: typeof fetch = async (_url, init) => {
    state.providerBodies.push(JSON.parse(String(init?.body)));
    return Response.json({ inputTokens: 120, inputSha256: "a".repeat(64), model: "test-model" });
  };
  return { sb, state, fetcher };
}

test("Story Blueprint quote worker counts one frozen snapshot then stores one lease-bound offer", async () => {
  const f = fixture();
  const outcome = await runOneStoryBlueprintQuoteStep(f.sb, { fetcher: f.fetcher, clock: () => "2026-09-20T00:00:00.000Z" });
  assert.deepEqual(outcome, { status: "ready", requestId });
  assert.deepEqual(f.state.providerBodies[0], {
    jobId, workspaceId, bookId, model: "test-model", maxOutputTokens: 2000,
    contextPolicy: { includeBookBible: false, includeStyleGuide: false, includeRelatedContext: false, semanticTopK: 5, maxTokens: 16000 },
    input: { storyBlueprint: { details: story, chapterPlan: [] }, book: { title: story.workingTitle, author: "Author", language: "en" } },
  });
  const created = f.state.calls.find((call) => call.name === "create_story_blueprint_quote_proposal");
  assert.ok(created);
  assert.equal(created.args.p_request_id, requestId);
  assert.equal(created.args.p_lease_token, lease);
  assert.equal((created.args.p_usage_quote as { scope: { inputSha256: string } }).scope.inputSha256, "a".repeat(64));
  assert.equal(f.state.calls.some((call) => call.name === "fail_story_blueprint_quote_request"), false);
});

test("Story Blueprint quote worker marks a failed count instead of creating an unpaid offer", async () => {
  const f = fixture();
  const fetcher: typeof fetch = async () => new Response("unavailable", { status: 503 });
  const outcome = await runOneStoryBlueprintQuoteStep(f.sb, { fetcher });
  assert.deepEqual(outcome, { status: "completion_unknown", requestId });
  assert.equal(f.state.calls.some((call) => call.name === "create_story_blueprint_quote_proposal"), false);
  assert.deepEqual(f.state.calls.at(-1), {
    name: "fail_story_blueprint_quote_request", args: { p_request_id: requestId, p_lease_token: lease },
  });
});
