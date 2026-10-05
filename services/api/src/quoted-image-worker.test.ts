import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { runOneQuotedImageJob } from "./lib/quoted-image-worker.js";
import { imageRequestHash, type ImageQuoteRequest } from "./lib/image-pricing.js";
import { quoteUsage } from "./lib/usage-pricing.js";
import type { SupabaseClient } from "./lib/supabase.js";

const id = (n: number) => `ab000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const dimensions = ["text_input", "image_input", "text_output", "image_output"] as const;
function fixture(mode: "recover" | "missing" | "corrupt" | "generate", failure?: "dispatch" | "provider" | "upload" | "receipt" | "completion" | "completion_reply" | "completion_throw" | "usage" | "renewal" | "pending_renewal",
  reference?: "clean" | "quarantined" | "changed" | "foreign_path" | "corrupt", options: {
    boundary?: (stage: string) => Promise<void>; completedRow?: Record<string, unknown>; completionReadError?: boolean; uploadFailure?: boolean;
  } = {}) {
  const request: ImageQuoteRequest = { jobId: id(1), workspaceId: id(2), userId: id(3), bookId: null,
    kind: "illustration", model: "fixture", prompt: "forest", size: "1024x1024", quality: "low", references: [] };
  const referenceBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const referenceHash = createHash("sha256").update(referenceBytes).digest("hex");
  if (reference) request.references.push({ assetId: id(7), version: 1, sha256: referenceHash, mimeType: "image/png" });
  const hash = imageRequestHash(request);
  const quote = quoteUsage({ scope: { jobId: id(1), workspaceId: id(2), userId: id(3), inputSha256: hash },
    price: { version: "p1", provider: "openai", model: "fixture", rates: dimensions.map(dimension => ({ dimension, microUsdPerMillionTokens: "1000000" })) },
    policy: { approved: true, version: "v1", microUsdPerCredit: "10", markupBasisPoints: 15000, platformMicroUsd: "0", minimumCredits: "1" },
    maximumTokens: dimensions.map(dimension => ({ dimension, tokens: "100" })),
    createdAt: "2026-09-28T00:00:00.000Z", expiresAt: "2026-09-28T00:05:00.000Z" });
  const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const usage = { inputTokens: 30, outputTokens: 20, estimatedCostUsd: 0, latencyMs: 10, reconciliationStatus: "supported" as const,
    providerTokenUsage: { input_tokens: 30, output_tokens: 20, total_tokens: 50,
      input_tokens_details: { text_tokens: 10, image_tokens: 20 }, output_tokens_details: { text_tokens: 0, image_tokens: 20 } } };
  const receipt = { assetId: id(6), name: "Image", provider: "openai", model: "fixture", requestId: "provider-1", mimeType: "image/png",
    checksum: createHash("sha256").update(bytes).digest("hex"), sizeBytes: bytes.length,
    storagePath: `workspaces/${id(2)}/assets/${id(6)}/v1/generated.png`, usage };
  const calls: string[] = [];
  const boundaries: string[] = [];
  const boundary = async (stage: string) => { boundaries.push(stage); await options.boundary?.(stage); };
  let generated = 0;
  let finishRenewal!: (value: { data: boolean; error: null }) => void;
  const pendingRenewal = new Promise<{ data: boolean; error: null }>(resolve => { finishRenewal = resolve; });
  const sb = {
    from(table: string) {
      const chain = { select() { return chain; }, eq() { return chain; }, async maybeSingle() {
        await boundary(`read:${table}`);
        const data = table === "image_quote_snapshots" ? { id: id(4), user_id: id(3), workspace_id: id(2), book_id: null,
          generation_job_id: id(1), request_json: request, request_sha256: hash, quote_json: quote }
          : table === "funded_usage_quotes" ? { job_id: id(1), user_id: id(3), workspace_id: id(2), quote_json: quote,
            reserved_credits: Number(quote.reservedCredits), status: "held", settlement_json: null, dispatched_at: mode === "generate" ? null : "saved" }
          : table === "assets" ? { storage_path: reference === "foreign_path" ? "foreign/image.png" : `workspaces/${id(2)}/assets/${id(7)}/v1/image.png`,
            checksum: reference === "changed" ? "a".repeat(64) : referenceHash, size_bytes: 8, mime_type: "image/png", deleted_at: null }
          : table === "asset_versions" ? { checksum: referenceHash, storage_path: `workspaces/${id(2)}/assets/${id(7)}/v1/image.png`,
            scan_status: reference === "quarantined" ? "quarantined" : "clean" }
          : table === "ai_jobs" ? options.completedRow ?? null
          : mode === "missing" ? null : { request_sha256: hash, receipt_json: receipt };
        return { data, error: table === "ai_jobs" && options.completionReadError ? { code: "503" } : null };
      } }; return chain;
    },
    async rpc(name: string, args: Record<string, unknown>) {
      calls.push(name);
      await boundary(`rpc:${name}`);
      if (name === "renew_quoted_image_lease" && failure === "renewal") return { data: false, error: null };
      if (name === "renew_quoted_image_lease" && failure === "pending_renewal") return pendingRenewal;
      if ((failure === "dispatch" && name === "claim_funded_dispatch")
        || (failure === "receipt" && name === "save_quoted_image_receipt")
        || (failure === "completion" && name === "complete_quoted_image_job")) return { data: null, error: { code: "503" } };
      if (name === "claim_quoted_image_job") return { data: { id: id(1), workspace_id: id(2), created_by: id(3), book_id: null,
        model: "fixture", billing_mode: "quoted", agent_type: "illustrator", lease_token: id(5),
        input_ref: { imageQuoteId: id(4), requestSha256: hash, generationRequest: request } }, error: null };
      if (name === "complete_quoted_image_job") {
        if (failure === "completion_throw") throw new Error("Committed completion response lost");
        assert.equal((args.p_settlement as { debitCredits: string }).debitCredits, "8");
        return { data: { id: failure === "completion_reply" ? id(99) : id(1), status: "succeeded" }, error: null };
      }
      return { data: true, error: null };
    },
    storage: { from() { return { async download(path: string) { await boundary("download"); return { data: new Blob([mode === "corrupt" || reference === "corrupt" && path.includes(id(7)) ? Buffer.alloc(8) : bytes]), error: null }; },
      async upload() { calls.push("upload"); await boundary("upload"); return { error: failure === "upload" || options.uploadFailure ? { message: "unavailable" } : null }; } }; } },
  } as unknown as SupabaseClient;
  const generator = async () => {
    generated++;
    await boundary("provider");
    if (failure === "provider") throw new Error("lost provider response");
    return { bytes, provider: "openai" as const, model: "fixture", requestId: "provider-1", mimeType: "image/png" as const,
      usage: { ...usage, reconciliationStatus: failure === "usage" ? "requires_review" as const : "supported" as const } };
  };
  return { sb, calls, boundaries, generator, count: () => generated, finishRenewal };
}
test("quoted image recovery settles verified saved bytes without generation", async () => {
  const f = fixture("recover");
  assert.equal((await runOneQuotedImageJob(f.sb, { generator: f.generator })).status, "succeeded");
  assert.equal(f.count(), 0);
  assert.deepEqual(f.calls, ["claim_quoted_image_job", "complete_quoted_image_job"]);
});

test("reference integrity and quarantine checks precede paid dispatch", async () => {
  for (const reference of ["clean", "quarantined", "changed", "foreign_path", "corrupt"] as const) {
    const f = fixture("generate", undefined, reference);
    assert.equal((await runOneQuotedImageJob(f.sb, { generator: f.generator })).status, reference === "clean" ? "succeeded" : "released", reference);
    assert.equal(f.count(), reference === "clean" ? 1 : 0, reference);
    if (reference !== "clean") assert.deepEqual(f.calls, ["claim_quoted_image_job", "release_quoted_image_before_dispatch"]);
  }
});

test("lost lease during generation prevents upload and completion without refund", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture("generate", "renewal");
  const generator = async () => {
    context.mock.timers.tick(60000);
    // Allow the heartbeat RPC and its promise chain to observe lease loss.
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    return f.generator();
  };
  assert.equal((await runOneQuotedImageJob(f.sb, { generator })).status, "completion_unknown");
  assert.equal(f.count(), 1);
  assert.deepEqual(f.calls, ["claim_quoted_image_job", "claim_funded_dispatch", "renew_quoted_image_lease"]);
});

test("pending lease renewal must finish before generated image upload", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture("generate", "pending_renewal");
  const outcome = runOneQuotedImageJob(f.sb, { generator: async () => {
    context.mock.timers.tick(60000);
    return f.generator();
  } });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.includes("renew_quoted_image_lease"), true);
    assert.equal(f.calls.includes("upload"), false);
  } finally { f.finishRenewal({ data: false, error: null }); }
  assert.equal((await outcome).status, "completion_unknown");
  assert.deepEqual(f.calls, ["claim_quoted_image_job", "claim_funded_dispatch", "renew_quoted_image_lease"]);
});

test("foreign completion reply stays unconfirmed", async () => {
  const f = fixture("recover", "completion_reply");
  assert.equal((await runOneQuotedImageJob(f.sb, { generator: f.generator })).status, "completion_unknown");
  assert.equal(f.count(), 0);
});
test("missing receipts and corrupt stored bytes hold for review without regeneration", async () => {
  for (const mode of ["missing", "corrupt"] as const) {
    const f = fixture(mode);
    assert.equal((await runOneQuotedImageJob(f.sb, { generator: f.generator })).status, "requires_review");
    assert.equal(f.count(), 0);
    assert.deepEqual(f.calls, ["claim_quoted_image_job", "hold_quoted_image_for_review"]);
  }
});
test("new quoted image dispatch persists receipt before measured atomic completion", async () => {
  const f = fixture("generate");
  assert.equal((await runOneQuotedImageJob(f.sb, { generator: f.generator })).status, "succeeded");
  assert.equal(f.count(), 1);
  assert.deepEqual(f.calls, ["claim_quoted_image_job", "claim_funded_dispatch", "upload", "save_quoted_image_receipt", "complete_quoted_image_job"]);
});

test("ambiguous dispatch never reaches provider; post-dispatch failures never refund or retry", async () => {
  for (const failure of ["dispatch", "provider", "upload", "receipt", "completion", "usage"] as const) {
    const f = fixture("generate", failure);
    const outcome = await runOneQuotedImageJob(f.sb, { generator: f.generator });
    assert.equal(outcome.status, ["provider", "upload", "usage"].includes(failure) ? "requires_review" : "completion_unknown", failure);
    assert.equal(f.count(), failure === "dispatch" ? 0 : 1, failure);
    assert(!f.calls.includes("release_quoted_image_before_dispatch"), failure);
    if (failure !== "completion") assert(!f.calls.includes("complete_quoted_image_job"), failure);
    assert.equal(f.calls.filter(name => name === "claim_funded_dispatch").length, 1, failure);
  }
});

test("lease loss at boundary entry blocks review/release writes and subsequent media operations", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  for (const scenario of [
    { mode: "generate" as const, stage: "read:funded_usage_quotes", noProvider: true, expectedProviders: 0 },
    { mode: "generate" as const, stage: "read:assets", reference: "quarantined" as const, expectedProviders: 0 },
    { mode: "missing" as const, stage: "read:quoted_image_receipts", expectedProviders: 0 },
    { mode: "recover" as const, stage: "read:quoted_image_receipts", expectedProviders: 0 },
    { mode: "generate" as const, stage: "rpc:claim_funded_dispatch", expectedProviders: 0 },
    { mode: "generate" as const, stage: "provider", invalid: true, expectedProviders: 1 },
    { mode: "generate" as const, stage: "provider", throws: true, expectedProviders: 1 },
    { mode: "generate" as const, stage: "upload", uploadFailure: true, expectedProviders: 1 },
    { mode: "corrupt" as const, stage: "download", expectedProviders: 0 },
    { mode: "generate" as const, stage: "rpc:save_quoted_image_receipt", expectedProviders: 1 },
  ]) {
    let lostAtBoundary = false;
    const f = fixture(scenario.mode, "renewal", scenario.reference, { uploadFailure: scenario.uploadFailure, boundary: async stage => {
      if (!lostAtBoundary && stage === scenario.stage) {
        lostAtBoundary = true; context.mock.timers.tick(60000);
        await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      }
    } });
    // Expired-lease renewals are real fixture replies, not a direct mutation of worker state.
    const generator = scenario.noProvider ? undefined : async () => {
      const result = await f.generator();
      if (scenario.throws) throw new Error("Provider response lost");
      return scenario.invalid ? { ...result, bytes: Buffer.alloc(8) } : result;
    };
    const originalKey = process.env.OPENAI_API_KEY;
    if (scenario.noProvider) delete process.env.OPENAI_API_KEY;
    try {
      assert.equal((await runOneQuotedImageJob(f.sb, { generator })).status, "completion_unknown", `${scenario.mode}:${scenario.stage}`);
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey;
    }
    assert.equal(lostAtBoundary, true, scenario.stage);
    assert.equal(f.count(), scenario.expectedProviders, scenario.stage);
    assert(!f.calls.includes("hold_quoted_image_for_review"), scenario.stage);
    assert(!f.calls.includes("release_quoted_image_before_dispatch"), scenario.stage);
    assert(!f.calls.includes("complete_quoted_image_job"), scenario.stage);
    if (["read:quoted_image_receipts", "rpc:save_quoted_image_receipt"].includes(scenario.stage)) {
      assert(!f.boundaries.includes("download"), `${scenario.stage}: no later Storage download`);
    }
  }
});

test("pending renewal finishes before missing-receipt review can mutate its held quote", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture("missing", "pending_renewal", undefined, { boundary: async stage => {
    if (stage === "read:quoted_image_receipts") context.mock.timers.tick(60000);
  } });
  const outcome = runOneQuotedImageJob(f.sb, { generator: f.generator });
  try {
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(f.calls.includes("renew_quoted_image_lease"), true);
    assert.equal(f.calls.includes("hold_quoted_image_for_review"), false);
  } finally { f.finishRenewal({ data: false, error: null }); }
  assert.equal((await outcome).status, "completion_unknown");
});

const completedRow = () => ({ id: id(1), workspace_id: id(2), created_by: id(3), book_id: null,
  model: "fixture", billing_mode: "quoted", agent_type: "illustrator", status: "succeeded" });
test("lost completion error or thrown reply recovers only an authoritative completed quoted image job", async () => {
  for (const failure of ["completion", "completion_throw"] as const) {
    const f = fixture("recover", failure, undefined, { completedRow: completedRow() });
    assert.equal((await runOneQuotedImageJob(f.sb, { generator: f.generator })).status, "succeeded", failure);
    assert.equal(f.count(), 0);
    assert.equal(f.calls.filter(name => name === "complete_quoted_image_job").length, 1);
    assert(f.boundaries.includes("read:ai_jobs"));
    assert(!f.calls.includes("hold_quoted_image_for_review"));
    assert(!f.calls.includes("release_quoted_image_before_dispatch"));
  }
});

test("foreign/malformed/unfinished completion readback never proves image success", async () => {
  for (const change of [{ id: id(99) }, { workspace_id: id(99) }, { created_by: id(99) }, { book_id: id(99) },
    { model: "other" }, { billing_mode: "operational" }, { agent_type: "cover_designer" }, { status: "running" }, { status: null },
    { workspace_id: undefined }]) {
    const f = fixture("recover", "completion_throw", undefined, { completedRow: { ...completedRow(), ...change } });
    assert.equal((await runOneQuotedImageJob(f.sb, { generator: f.generator })).status, "completion_unknown", JSON.stringify(change));
    assert.equal(f.count(), 0);
    assert(f.boundaries.includes("read:ai_jobs"));
  }
  const unavailable = fixture("recover", "completion", undefined, { completedRow: completedRow(), completionReadError: true });
  assert.equal((await runOneQuotedImageJob(unavailable.sb, { generator: unavailable.generator })).status, "completion_unknown");
});
