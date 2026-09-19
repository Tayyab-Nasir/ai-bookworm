import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { runOneQuotedTranslationJob } from "./lib/quoted-translation-worker.js";
import { quoteUsage } from "./lib/usage-pricing.js";
import { translationRequestHash, measuredTranslationTokens, translationProviderRequest } from "./lib/translation-generation.js";
import type { SupabaseClient } from "./lib/supabase.js";
const ids = Array.from({ length: 8 }, (_, i) => `c8000000-0000-4000-8000-${String(i + 1).padStart(12,"0")}`);
const [job, workspace, user, lease, project, chapter, document, translatedChapter] = ids;
const text = "A saved source.";
function fixture() {
  const request = { text, sourceLanguage: "en", targetLanguage: "es", model: "synthetic", maxOutputTokens: 1000 };
  const q = quoteUsage({ scope: { jobId: job, workspaceId: workspace, userId: user, inputSha256: translationRequestHash(request) },
    price: { version: "test", model: "synthetic", provider: "openai", rates: ["text_input", "text_cached_input", "text_output"].map((dimension) => ({ dimension: dimension as "text_input", microUsdPerMillionTokens: "1000000" })) },
    policy: { version: "test", approved: true, microUsdPerCredit: "1000", minimumCredits: "1", platformMicroUsd: "0", markupBasisPoints: 10000 },
    maximumTokens: ["text_input", "text_cached_input", "text_output"].map((dimension) => ({ dimension: dimension as "text_input", tokens: "1000" })),
    createdAt: "2026-09-19T00:00:00Z", expiresAt: "2026-09-19T00:15:00Z" });
  const state = { dispatched: false, receipt: null as unknown, receiptFail: false, completionFail: false, source: text, calls: [] as string[], inputs: [] as unknown[] };
  const row = { job_id: job, workspace_id: workspace, user_id: user, quote_json: q, reserved_credits: Number(q.reservedCredits), status: "held", settlement_json: null as unknown };
  const sb = {
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push(name);
      if (name === "claim_quoted_translation_job") return { data: [{ id: job, workspace_id: workspace, created_by: user, billing_mode: "quoted", lease_token: lease,
        input_ref: { translationProjectId: project, translationChapterId: translatedChapter, chapterId: chapter, documentVersionId: document,
          sourceSha256: createHash("sha256").update(text).digest("hex"), sourceLanguage: "en", targetLanguage: "es", creditUnits: 1 } }], error: null };
      if (name === "claim_funded_dispatch") { const allowed = !state.dispatched; state.dispatched = true; return { data: allowed, error: null }; }
      if (name === "renew_translation_lease") return { data: true, error: null };
      if (name === "complete_quoted_translation") return state.completionFail ? { error: { message: "offline" }, data: null } : { data: { id: job, status: "succeeded" }, error: null };
      if (name === "settle_funded_usage_quote") { row.status = "requires_review"; row.settlement_json = args.p_settlement; return { data: row, error: null }; }
      throw new Error(name);
    },
    from: (table: string) => {
      const b: Record<string, unknown> = {}; b.select = () => b; b.eq = () => b;
      b.maybeSingle = async () => ({ error: null, data: table === "funded_usage_quotes" ? row : table === "document_versions" ? { plain_text: state.source } : state.receipt ? { completion_json: state.receipt } : null });
      b.insert = (value: { completion_json: unknown }) => { if (!state.receiptFail) state.receipt = structuredClone(value.completion_json); return Promise.resolve({ error: state.receiptFail ? { message: "offline" } : null }); };
      return b;
    },
  } as unknown as SupabaseClient;
  const generator = async (input: unknown) => { state.inputs.push(input); return { text: "Un texto guardado.", provider: "openai" as const, model: "synthetic", requestId: "req-test",
    usage: { inputTokens: 100, outputTokens: 100, estimatedCostUsd: 0.0002, latencyMs: 10,
      measuredTokens: measuredTranslationTokens({ input_tokens: 100, output_tokens: 100, input_tokens_details: { cached_tokens: 20 } }) } }; };
  return { state, sb, generator, request };
}
test("quoted translation pins full request, persists receipt and retries completion without generating twice", async () => {
  const f = fixture(); f.state.completionFail = true;
  assert.equal((await runOneQuotedTranslationJob(f.sb, { generator: f.generator })).status, "completion_unknown");
  assert.deepEqual(f.state.inputs, [f.request]); assert.ok(f.state.receipt);
  f.state.completionFail = false;
  assert.equal((await runOneQuotedTranslationJob(f.sb, { generator: f.generator })).status, "succeeded");
  assert.equal(f.state.inputs.length, 1); assert.equal(f.state.calls.filter((x) => x === "claim_funded_dispatch").length, 1);
  assert.ok(!f.state.calls.includes("complete_translation_chapter"));
});
test("unknown receipt persistence cannot cause a second paid call", async () => {
  const f = fixture(); f.state.receiptFail = true;
  await runOneQuotedTranslationJob(f.sb, { generator: f.generator });
  f.state.receiptFail = false;
  assert.equal((await runOneQuotedTranslationJob(f.sb, { generator: f.generator })).status, "completion_unknown");
  assert.equal(f.state.inputs.length, 1); assert.equal(f.state.receipt, null);
});
test("changed source stops before dispatch; missing measured usage saves result without charging", async () => {
  const f = fixture(); f.state.source = "Changed";
  await runOneQuotedTranslationJob(f.sb, { generator: f.generator });
  assert.equal(f.state.inputs.length, 0); assert.equal(f.state.dispatched, false);
  f.state.source = text;
  await runOneQuotedTranslationJob(f.sb, { generator: async (input) => { const result = await f.generator(input); result.usage.measuredTokens = undefined; return result; } });
  assert.ok(f.state.receipt); assert.ok(!f.state.calls.includes("complete_quoted_translation"));
});
test("token normalization splits cached usage and never treats missing counters as zero", () => {
  assert.deepEqual(measuredTranslationTokens({ input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 20 } }),
    [{ dimension: "text_input", tokens: "80" }, { dimension: "text_cached_input", tokens: "20" }, { dimension: "text_output", tokens: "5" }]);
  for (const usage of [null, {}, { input_tokens: 1, output_tokens: 1 }, { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 2 } },
    { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 2, cache_write_tokens: 1 } }]) assert.equal(measuredTranslationTokens(usage), undefined);
  const f = fixture(); assert.equal(translationProviderRequest(f.request).max_output_tokens, 1000);
  assert.notEqual(translationRequestHash(f.request), translationRequestHash({ ...f.request, targetLanguage: "fr" }));
  assert.notEqual(translationRequestHash(f.request), translationRequestHash({ ...f.request, maxOutputTokens: 999 }));
});

test("over-bound measured usage keeps its hold for review without completing translation", async () => {
  const f = fixture();
  const result = await runOneQuotedTranslationJob(f.sb, { generator: async (input) => {
    const generated = await f.generator(input); generated.usage.inputTokens = 2000;
    generated.usage.measuredTokens = measuredTranslationTokens({ input_tokens: 2000, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } });
    return generated;
  } });
  assert.equal(result.status, "requires_review"); assert.ok(f.state.receipt);
  assert.ok(!f.state.calls.includes("complete_quoted_translation"));
});
