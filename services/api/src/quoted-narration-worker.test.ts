import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { runOneQuotedNarrationJob } from "./lib/quoted-narration-worker.js";
import { narrationRequestHash, narrationPromptHash, reconcileNarrationUsage, type NarrationQuoteRequest } from "./lib/narration-pricing.js";
import { quoteUsage } from "./lib/usage-pricing.js";
import type { SupabaseClient } from "./lib/supabase.js";
import type { RealtimeNarrationResult } from "./lib/realtime-narration.js";
import { AppError } from "./errors.js";

const id = (n: number) => `ac000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const rawUsage = { input_tokens: 37, output_tokens: 10, total_tokens: 47,
  input_token_details: { text_tokens: 37, audio_tokens: 0, cached_tokens: 11,
    cached_tokens_details: { text_tokens: 11, audio_tokens: 0 } }, output_token_details: { text_tokens: 2, audio_tokens: 8 } };
type Fault = "dispatch" | "dispatch_false" | "provider" | "pcm_reply" | "encoding_reply" | "completion_reply" | "completion_throw" | "encoder";
function fixture(mode: "fresh" | "pcm" | "encoded" | "missing" = "fresh", fault?: Fault) {
  const source = "A naïve 🐛 reads a saved story.";
  const request: NarrationQuoteRequest = { jobId: id(1), workspaceId: id(2), userId: id(3), bookId: id(4),
    editionId: id(5), chapterId: id(6), documentVersionId: id(7), segmentIndex: 0, textStart: 0,
    textEnd: Array.from(source).length, textSha256: sha(source), model: "gpt-realtime-2.1-mini", voice: "marin",
    speed: 1, instructions: null, maxOutputTokens: 4096, promptVersion: "bookworm-realtime-narration-v1", promptSha256: narrationPromptHash(null) };
  const requestSha256 = narrationRequestHash(request);
  const quote = quoteUsage({ scope: { jobId: request.jobId, userId: request.userId, workspaceId: request.workspaceId, inputSha256: requestSha256 },
    price: { version: "fixture-only", provider: "openai", model: request.model,
      rates: (["audio_output", "text_cached_input", "text_input", "text_output"] as const).map(dimension => ({ dimension, microUsdPerMillionTokens: "1000000" })) },
    policy: { approved: true, version: "fixture-only", microUsdPerCredit: "10", markupBasisPoints: 15000, platformMicroUsd: "0", minimumCredits: "1" },
    maximumTokens: [{ dimension: "text_input", tokens: "128000" }, { dimension: "text_cached_input", tokens: "128000" },
      { dimension: "text_output", tokens: "4096" }, { dimension: "audio_output", tokens: "4096" }],
    createdAt: "2026-10-05T00:00:00.000Z", expiresAt: "2026-10-05T00:05:00.000Z" });
  const pcm = Buffer.alloc(48_000), mp3 = Buffer.from([0xff, 0xfb, 0xb0, 0xc0, 1, 2, 3, 4]);
  const pcmPath = `private/narration/${id(2)}/${id(1)}/${id(9)}.pcm`;
  const mp3Path = `workspaces/${id(2)}/audiobooks/${id(8)}/0.mp3`;
  const original = { version: "bookworm-narration-pcm-v1", provider: "openai", model: request.model, requestId: "fixture-response",
    sourceSha256: sha(source), storagePath: pcmPath, mimeType: "audio/pcm", sizeBytes: pcm.length, checksum: sha(pcm),
    sampleRateHz: 24000, channels: 1, bitDepth: 16, durationSeconds: 1, transcript: source, rawUsage, latencyMs: 10 };
  const encoded = { version: "bookworm-narration-mp3-v1", pcmReceiptSha256: "a".repeat(64), assetId: id(1), storagePath: mp3Path,
    mimeType: "audio/mpeg", sizeBytes: mp3.length, checksum: sha(mp3), durationSeconds: 1,
    encodingVersion: "narration-mp3-1.0.0", sampleRateHz: 44100, channels: 1, bitRateKbps: 192, bitRateMode: "cbr" };
  const job = { id: id(1), workspace_id: id(2), created_by: id(3), book_id: id(4), model: request.model,
    agent_type: "narrator", billing_mode: "quoted", status: "running", lease_token: mode === "fresh" ? id(9) : id(10),
    input_ref: { narrationQuoteId: id(11), audiobookProjectId: id(8), requestSha256, generationRequest: request } };
  const fund = { job_id: id(1), user_id: id(3), workspace_id: id(2), quote_json: quote, reserved_credits: Number(quote.reservedCredits),
    status: "held", settlement_json: null as unknown, dispatched_at: mode === "fresh" ? null as string | null : "saved", dispatched_lease: id(9) };
  const snapshot = { id: id(11), generation_job_id: id(1), workspace_id: id(2), user_id: id(3), book_id: id(4),
    edition_id: id(5), chapter_id: id(6), document_version_id: id(7), request_json: request, request_sha256: requestSha256, quote_json: quote };
  const state = { pcm: mode === "pcm" || mode === "encoded" ? { job_id: id(1), request_sha256: requestSha256,
    receipt_sha256: "a".repeat(64), receipt_json: original } : null as null | Record<string, any>,
    encoded: mode === "encoded" ? { job_id: id(1), pcm_receipt_sha256: "a".repeat(64), receipt_sha256: "b".repeat(64), receipt_json: encoded }
      : null as null | Record<string, any>, completed: null as null | Record<string, any>, leaseLost: false, uploadReplyLost: false,
    generatedUsage: rawUsage as unknown, transcript: source, fault, claimEmpty: false,
    boundary: async (_stage: string) => {}, completionMutation: (_saved: Record<string, any>) => {} };
  const files = new Map<string, Buffer>();
  if (state.pcm) files.set(pcmPath, pcm); if (state.encoded) files.set(mp3Path, mp3);
  const calls: { name: string; args?: Record<string, unknown> }[] = [], reads: { table: string; filters: Record<string, unknown> }[] = [];
  let generated = 0, conversions = 0;
  const sb = { from(table: string) {
    const filters: Record<string, unknown> = {};
    const chain = { select() { return chain; }, eq(key: string, value: unknown) { filters[key] = value; return chain; },
      async maybeSingle() { reads.push({ table, filters }); await state.boundary(`read:${table}`);
        const data = table === "narration_quote_snapshots" ? snapshot : table === "funded_usage_quotes" ? fund
          : table === "document_versions" ? { id: id(7), chapter_id: id(6), plain_text: source }
          : table === "quoted_narration_receipts" ? state.pcm : table === "quoted_narration_encodings" ? state.encoded
          : table === "ai_jobs" ? state.completed : null;
        return { data: data && structuredClone(data), error: null };
      } }; return chain;
  }, async rpc(name: string, args: Record<string, unknown>) {
    calls.push({ name, args }); await state.boundary(`rpc:${name}`);
    if (name === "claim_quoted_narration_job") return { data: state.claimEmpty ? [] : [structuredClone(job)], error: null };
    if (name === "renew_quoted_narration_lease") return { data: !state.leaseLost, error: null };
    if (name === "claim_funded_dispatch") {
      if (state.fault === "dispatch") return { data: null, error: { code: "503" } };
      fund.dispatched_at = "saved";
      return { data: state.fault !== "dispatch_false", error: null };
    }
    if (name === "save_quoted_narration_receipt") {
      state.pcm = { job_id: id(1), request_sha256: requestSha256, receipt_sha256: "a".repeat(64), receipt_json: args.p_receipt };
      return { data: state.fault === "pcm_reply" ? null : structuredClone(state.pcm), error: state.fault === "pcm_reply" ? { code: "503" } : null };
    }
    if (name === "save_quoted_narration_encoding") {
      state.encoded = { job_id: id(1), pcm_receipt_sha256: "a".repeat(64), receipt_sha256: "b".repeat(64), receipt_json: args.p_receipt };
      return { data: state.fault === "encoding_reply" ? null : structuredClone(state.encoded), error: state.fault === "encoding_reply" ? { code: "503" } : null };
    }
    if (name === "complete_quoted_narration_job") {
      assert.deepEqual(Object.keys(args).sort(), ["p_job_id", "p_lease_token"]);
      fund.status = "settled";
      fund.settlement_json = reconcileNarrationUsage(quote, { request, sourceText: source,
        receipt: { jobId: id(1), userId: id(3), workspaceId: id(2), requestSha256, sourceSha256: sha(source), provider: "openai",
          model: request.model, responseId: state.pcm!.receipt_json.requestId, transcript: state.pcm!.receipt_json.transcript,
          rawUsage: state.pcm!.receipt_json.rawUsage } });
      state.completed = { ...job, status: "succeeded", output_ref: { assetId: id(1), audiobookProjectId: id(8), provider: "openai" } };
      state.completionMutation(state.completed);
      if (state.fault === "completion_throw") throw new Error("private lost committed response");
      return { data: state.fault === "completion_reply" ? null : structuredClone(state.completed),
        error: state.fault === "completion_reply" ? { code: "503" } : null };
    }
    if (name === "release_quoted_narration_before_dispatch") fund.status = "cancelled";
    if (name === "hold_quoted_narration_for_review") fund.status = "requires_review";
    return { data: true, error: null };
  }, storage: { from() { return { async upload(path: string, bytes: Buffer, options: { upsert: boolean }) {
    calls.push({ name: "upload", args: { path } }); await state.boundary("upload"); assert.equal(options.upsert, false);
    if (files.has(path)) return { data: null, error: { statusCode: "409" } };
    files.set(path, Buffer.from(bytes)); return { data: {}, error: state.uploadReplyLost ? { statusCode: "503" } : null };
  }, async download(path: string) { calls.push({ name: "download", args: { path } }); await state.boundary("download");
    const bytes = files.get(path); return { data: bytes ? new Blob([Uint8Array.from(bytes)]) : null, error: bytes ? null : { statusCode: "404" } }; }
  }; } } } as unknown as SupabaseClient;
  const generator = async (_input: unknown, options?: { signal?: AbortSignal }): Promise<RealtimeNarrationResult> => {
    generated++; await state.boundary("provider");
    if (state.fault === "provider") throw new Error("private provider response lost");
    return { bytes: pcm, mimeType: "audio/pcm", sampleRateHz: 24000, channels: 1, bitDepth: 16, provider: "openai", model: request.model,
      responseId: "fixture-response", sourceSha256: sha(source), audioSha256: sha(pcm), transcript: state.transcript,
      durationSeconds: 1, latencyMs: 10, rawUsage: state.generatedUsage, measuredTokens: null, reviewRequired: false, reviewReasons: [] };
  };
  const encoder = async (_pcm: Buffer, _options?: { signal?: AbortSignal }) => {
    conversions++; await state.boundary("encoder"); if (state.fault === "encoder") throw new Error("private encoder unavailable");
    return { bytes: mp3, checksum: sha(mp3), profile: { encodingVersion: "narration-mp3-1.0.0" as const, pcmSha256: sha(pcm),
      sampleRateHz: 44100 as const, channels: 1 as const, bitRateKbps: 192 as const, bitRateMode: "cbr" as const, durationSeconds: 1 } };
  };
  return { sb, state, calls, reads, generator, encoder, job, snapshot, request, fund, files, pcmPath, mp3Path,
    counts: () => ({ generated, conversions }), options: { generator, encoder } };
}
test("funded narrator dispatches once, saves original evidence and completes with no caller bill", async () => {
  const f = fixture(); assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "succeeded");
  assert.deepEqual(f.counts(), { generated: 1, conversions: 1 }); assert.equal(f.fund.status, "settled");
  assert.equal(f.calls.filter(x => x.name === "claim_funded_dispatch").length, 1);
  assert.equal(f.calls.filter(x => x.name === "complete_quoted_narration_job").length, 1);
  assert(!f.calls.some(x => x.name === "settle_funded_usage_quote" || x.name === "release_quoted_narration_before_dispatch"));
});
test("PCM and encoded recovery use original dispatch path and never regenerate", async () => {
  for (const mode of ["pcm", "encoded"] as const) {
    const f = fixture(mode); assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "succeeded");
    assert.deepEqual(f.counts(), { generated: 0, conversions: mode === "pcm" ? 1 : 0 });
    assert(!f.calls.some(x => x.name === "claim_funded_dispatch" || x.name === "save_quoted_narration_receipt"));
    assert(f.calls.some(x => x.name === "download" && x.args!.path === f.pcmPath));
  }
});
test("missing original capture retains review hold without generation or refund", async () => {
  const f = fixture("missing"); assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "requires_review");
  assert.deepEqual(f.counts(), { generated: 0, conversions: 0 }); assert.equal(f.fund.status, "requires_review");
  assert(!f.calls.some(x => /release|complete|save_quoted/.test(x.name)));
});
test("unsupported original usage and changed transcript are saved evidence, never a bill", async () => {
  for (const mismatch of ["usage", "transcript"]) {
    const f = fixture(); if (mismatch === "usage") f.state.generatedUsage = { unsupported: 1 }; else f.state.transcript = "Changed story.";
    assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "requires_review");
    assert(f.state.pcm); assert.deepEqual(f.counts(), { generated: 1, conversions: 0 });
    assert(!f.calls.some(x => /release|complete/.test(x.name)));
  }
});
test("idle and unsupported job identities cannot touch provider, storage or receipts", async () => {
  const idle = fixture(); idle.state.claimEmpty = true;
  assert.equal((await runOneQuotedNarrationJob(idle.sb, idle.options)).status, "idle");
  assert.deepEqual(idle.calls.map(x => x.name), ["claim_quoted_narration_job"]);
  for (const mismatch of ["user", "request", "price", "source"]) {
    const f = fixture();
    if (mismatch === "user") f.snapshot.user_id = id(99);
    if (mismatch === "request") f.job.input_ref.requestSha256 = "c".repeat(64);
    if (mismatch === "price") f.snapshot.quote_json = { ...f.snapshot.quote_json, reservedCredits: "1" };
    if (mismatch === "source") f.snapshot.document_version_id = id(99);
    assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "completion_unknown");
    assert.deepEqual(f.counts(), { generated: 0, conversions: 0 });
    assert(!f.calls.some(x => /upload|dispatch|save_quoted|complete|review|release/.test(x.name)));
  }
});
test("unknown/false dispatch replies never generate or refund", async () => {
  for (const fault of ["dispatch", "dispatch_false"] as const) {
    const f = fixture("fresh", fault);
    assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "completion_unknown");
    assert.deepEqual(f.counts(), { generated: 0, conversions: 0 }); assert.equal(f.fund.status, "held");
    assert(!f.calls.some(x => /save_quoted|complete|review|release|upload/.test(x.name)));
  }
});
test("provider failure retains review hold; transient encoding failure keeps recoverable original", async () => {
  const provider = fixture("fresh", "provider");
  assert.equal((await runOneQuotedNarrationJob(provider.sb, provider.options)).status, "requires_review");
  assert(!provider.calls.some(x => /release|complete/.test(x.name)));
  const f = fixture("fresh", "encoder");
  assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "completion_unknown");
  assert(f.state.pcm); assert.equal(f.fund.status, "held"); f.state.fault = undefined; f.job.lease_token = id(10);
  assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "succeeded");
  assert.deepEqual(f.counts(), { generated: 1, conversions: 2 });
});
test("lost immutable-receipt replies recover through saved originals without redispatch", async () => {
  for (const fault of ["pcm_reply", "encoding_reply"] as const) {
    const f = fixture("fresh", fault);
    assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "completion_unknown");
    assert(f.state.pcm); assert.equal(f.fund.status, "held"); f.state.fault = undefined; f.job.lease_token = id(10);
    assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "succeeded");
    assert.deepEqual(f.counts(), { generated: 1, conversions: 1 });
    assert.equal(f.calls.filter(x => x.name === "claim_funded_dispatch").length, 1);
  }
});
test("lost upload replies verify exact private bytes and do not overwrite", async () => {
  const f = fixture(); f.state.uploadReplyLost = true;
  assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "succeeded");
  assert.deepEqual(f.counts(), { generated: 1, conversions: 1 });
});
test("corrupt saved PCM or MP3 requires review without billing or provider work", async () => {
  for (const kind of ["pcm", "mp3"]) {
    const f = fixture("encoded");
    const path = kind === "pcm" ? f.pcmPath : f.mp3Path; f.files.set(path, Buffer.alloc(f.files.get(path)!.length, 7));
    assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "requires_review");
    assert.deepEqual(f.counts(), { generated: 0, conversions: 0 }); assert.equal(f.fund.status, "requires_review");
    assert(!f.calls.some(x => /complete|release/.test(x.name)));
  }
});
test("malformed or foreign immutable evidence cannot be published or billed", async () => {
  for (const kind of ["original_job", "original_path", "original_request", "encoded_job", "encoded_pcm", "encoded_path", "encoded_duration", "encoded_profile"]) {
    const f = fixture("encoded");
    if (kind === "original_job") f.state.pcm!.job_id = id(99);
    if (kind === "original_path") f.state.pcm!.receipt_json.storagePath = "foreign/evidence.pcm";
    if (kind === "original_request") f.state.pcm!.request_sha256 = "c".repeat(64);
    if (kind === "encoded_job") f.state.encoded!.job_id = id(99);
    if (kind === "encoded_pcm") f.state.encoded!.receipt_json.pcmReceiptSha256 = "c".repeat(64);
    if (kind === "encoded_path") f.state.encoded!.receipt_json.storagePath = "foreign/audio.mp3";
    if (kind === "encoded_duration") f.state.encoded!.receipt_json.durationSeconds = 2;
    if (kind === "encoded_profile") f.state.encoded!.receipt_json.bitRateKbps = 96;
    assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "requires_review", kind);
    assert.deepEqual(f.counts(), { generated: 0, conversions: 0 });
    assert(!f.calls.some(x => /complete|release|upload/.test(x.name)), kind);
  }
});
test("lost completion replies require matching authoritative job, scope and measured settlement", async () => {
  for (const fault of ["completion_reply", "completion_throw"] as const) {
    const f = fixture("encoded", fault); assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "succeeded");
    const read = f.reads.find(x => x.table === "ai_jobs");
    assert.deepEqual(read?.filters, { id: id(1), workspace_id: id(2), created_by: id(3) });
    assert(!f.calls.some(x => /review|release/.test(x.name)));
  }
  for (const mismatch of ["user", "asset", "project", "model", "settlement"]) {
    const f = fixture("encoded", "completion_reply"); f.state.completionMutation = row => {
      if (mismatch === "user") row.created_by = id(99);
      if (mismatch === "asset") row.output_ref.assetId = id(99);
      if (mismatch === "project") row.output_ref.audiobookProjectId = id(99);
      if (mismatch === "model") row.model = "foreign-model";
      if (mismatch === "settlement") f.fund.settlement_json = { status: "settle", debitCredits: "1" };
    };
    assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "completion_unknown", mismatch);
    assert(!f.calls.some(x => /review|release/.test(x.name)));
  }
});
test("lease loss at each async stage fences all later writes, encoding and completion", async () => {
  for (const stage of ["read:narration_quote_snapshots", "read:document_versions", "rpc:claim_funded_dispatch", "provider", "upload", "download", "encoder",
    "rpc:save_quoted_narration_receipt", "rpc:save_quoted_narration_encoding"]) {
    const f = fixture(); let writesAtLoss = 0;
    f.state.boundary = async current => {
      if (current === stage && !f.state.leaseLost) { f.state.leaseLost = true; writesAtLoss = f.calls.length; }
    };
    assert.equal((await runOneQuotedNarrationJob(f.sb, f.options)).status, "completion_unknown", stage);
    assert(!f.calls.slice(writesAtLoss).some(x => /upload|dispatch|save_quoted|complete|review|release/.test(x.name)), stage);
  }
});
test("heartbeat lease loss aborts an in-flight provider and prevents persistence", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture(); let signal: AbortSignal | undefined;
  const generator: typeof f.generator = async (input, options) => {
    signal = options?.signal; f.state.leaseLost = true; context.mock.timers.tick(60_000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    return f.generator(input, options);
  };
  assert.equal((await runOneQuotedNarrationJob(f.sb, { ...f.options, generator })).status, "completion_unknown");
  assert.equal(signal?.aborted, true); assert.deepEqual(f.counts(), { generated: 1, conversions: 0 });
  assert(!f.calls.some(x => /upload|save_quoted|complete|review|release/.test(x.name)));
});
test("unsupported encoder results and permanent failure never reach settlement", async () => {
  for (const mismatch of ["pcm", "duration", "bytes", "permanent"]) {
    const f = fixture("pcm"); const encoder: typeof f.encoder = async () => {
      if (mismatch === "permanent") throw new AppError(422, "Private native rejection");
      const value = await f.encoder(f.files.get(f.pcmPath)!);
      if (mismatch === "pcm") value.profile.pcmSha256 = "c".repeat(64);
      if (mismatch === "duration") value.profile.durationSeconds = 2;
      if (mismatch === "bytes") value.bytes = Buffer.alloc(8);
      return value;
    };
    assert.equal((await runOneQuotedNarrationJob(f.sb, { ...f.options, encoder })).status, "requires_review", mismatch);
    assert(!f.calls.some(x => /complete|release|upload/.test(x.name)));
  }
});
test("operator-disabled new narration releases only before dispatch; aborted work claims nothing", async () => {
  const previous = process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED;
  process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = "false";
  try {
    const f = fixture();
    assert.equal((await runOneQuotedNarrationJob(f.sb, { encoder: f.encoder })).status, "released");
    assert.equal(f.fund.status, "cancelled"); assert.deepEqual(f.counts(), { generated: 0, conversions: 0 });
    const release = f.calls.find(x => x.name === "release_quoted_narration_before_dispatch");
    assert.equal(release?.args?.p_reason, "provider_not_configured");
    assert(!f.calls.some(x => /dispatch|upload|save_quoted|complete/.test(x.name) && x.name !== "release_quoted_narration_before_dispatch"));
    const stopped = fixture(); assert.equal((await runOneQuotedNarrationJob(stopped.sb, { ...stopped.options, signal: AbortSignal.abort() })).status, "idle");
    assert.deepEqual(stopped.calls, []);
  } finally {
    if (previous === undefined) delete process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED;
    else process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = previous;
  }
});
test("foreground work waits for a pending heartbeat renewal and observes its lease loss", async context => {
  context.mock.timers.enable({ apis: ["setInterval"] });
  const f = fixture(); let pending = false, provider = false;
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  f.state.boundary = async stage => {
    if (stage === "rpc:renew_quoted_narration_lease" && provider && !pending) { pending = true; await wait; }
  };
  const generator: typeof f.generator = async (input, options) => {
    provider = true; context.mock.timers.tick(60_000); return f.generator(input, options);
  };
  const running = runOneQuotedNarrationJob(f.sb, { ...f.options, generator });
  for (let turn = 0; turn < 100 && !pending; turn++) await Promise.resolve();
  assert.equal(pending, true); assert(!f.calls.some(x => x.name === "upload"));
  f.state.leaseLost = true; finish();
  assert.equal((await running).status, "completion_unknown");
  assert(!f.calls.some(x => /upload|save_quoted|complete|review|release/.test(x.name)));
});
