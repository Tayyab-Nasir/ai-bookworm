/** Funded server-only narration. Dispatch once; recover original evidence only. */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";
import { loadFundedUsage, claimPricedDispatch } from "./funded-usage.js";
import { narrationQuoteRequestSchema, narrationRequestHash, validatedNarrationQuote, reconcileNarrationUsage } from "./narration-pricing.js";
import { generateRealtimeNarration, REALTIME_NARRATION_MODELS, MAX_NARRATION_PCM_BYTES } from "./realtime-narration.js";
import { encodeNarrationPcm, narrationEncodingProfileSchema, isNarrationMp3, MAX_NARRATION_MP3_BYTES } from "./narration-encoding.js";
import { MAX_TTS_INPUT_BYTES } from "./speech-generation.js";

const id = z.string().uuid(), digest = z.string().regex(/^[a-f0-9]{64}$/);
const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const first = (value: unknown) => { if (Array.isArray(value)) { if (value.length > 1) throw new Error("unexpected claim count"); return value[0]; } return value; };
const jobSchema = z.object({ id, workspace_id: id, created_by: id, book_id: id, model: z.enum(REALTIME_NARRATION_MODELS),
  billing_mode: z.literal("quoted"), agent_type: z.literal("narrator"), status: z.literal("running"), lease_token: id,
  input_ref: z.object({ narrationQuoteId: id, audiobookProjectId: id, requestSha256: digest, generationRequest: z.unknown() }).strict() });
const rawEvidence = z.unknown().refine(value => { try { const json = JSON.stringify(value); return Boolean(json) && Buffer.byteLength(json!, "utf8") <= 65_536; } catch { return false; } });
const pcmSchema = z.object({ version: z.literal("bookworm-narration-pcm-v1"), provider: z.literal("openai"),
  model: z.enum(REALTIME_NARRATION_MODELS), requestId: z.string().min(1).max(256).refine(value => value === value.trim()),
  sourceSha256: digest, storagePath: z.string(), mimeType: z.literal("audio/pcm"),
  sizeBytes: z.number().int().min(2).max(MAX_NARRATION_PCM_BYTES).refine(value => value % 2 === 0), checksum: digest,
  sampleRateHz: z.literal(24000), channels: z.literal(1), bitDepth: z.literal(16), durationSeconds: z.number().finite().positive(),
  transcript: z.string().max(8192), rawUsage: rawEvidence, latencyMs: z.number().int().min(0).max(200_000),
}).strict().refine(value => Math.abs(value.durationSeconds - value.sizeBytes / 48_000) <= 0.000001);
const originalSchema = z.object({ job_id: id, request_sha256: digest, receipt_sha256: digest, receipt_json: pcmSchema });
const encodedSchema = z.object({ version: z.literal("bookworm-narration-mp3-v1"), pcmReceiptSha256: digest, assetId: id,
  storagePath: z.string(), mimeType: z.literal("audio/mpeg"), sizeBytes: z.number().int().positive().max(MAX_NARRATION_MP3_BYTES),
  checksum: digest, durationSeconds: narrationEncodingProfileSchema.shape.durationSeconds,
  encodingVersion: z.literal("narration-mp3-1.0.0"), sampleRateHz: z.literal(44100), channels: z.literal(1),
  bitRateKbps: z.literal(192), bitRateMode: z.literal("cbr"), }).strict();
const encodingRowSchema = z.object({ job_id: id, pcm_receipt_sha256: digest, receipt_sha256: digest, receipt_json: encodedSchema });
export type QuotedNarrationOutcome = { status: "idle" | "succeeded" | "released" | "requires_review" | "completion_unknown"; jobId?: string };

export async function runOneQuotedNarrationJob(sb: SupabaseClient, options: {
  generator?: typeof generateRealtimeNarration; encoder?: typeof encodeNarrationPcm; leaseSeconds?: number; signal?: AbortSignal;
} = {}): Promise<QuotedNarrationOutcome> {
  const leaseSeconds = z.number().int().min(30).max(600).parse(options.leaseSeconds ?? 180);
  if (options.signal?.aborted) return { status: "idle" };
  const claim = await sb.rpc("claim_quoted_narration_job", { p_lease_seconds: leaseSeconds });
  if (claim.error) throw new Error("Narration claim unavailable.");
  const claimed = first(claim.data); if (!claimed) return { status: "idle" };
  const job = jobSchema.parse(claimed);
  const unknown: QuotedNarrationOutcome = { status: "completion_unknown", jobId: job.id };
  const abort = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, abort.signal]) : abort.signal;
  let lost = false, finishing = false, renewal: Promise<void> | undefined;
  // Foreground checks renew authoritatively as well as the heartbeat. A timer
  // alone would permit stale uploads before its next tick. An in-flight private
  // upload can leave an orphan after lease loss; it cannot publish or bill.
  const renew = () => {
    if (!renewal && !lost && !signal.aborted) renewal = Promise.resolve()
      .then(() => sb.rpc("renew_quoted_narration_lease", { p_job_id: job.id, p_lease_token: job.lease_token, p_lease_seconds: leaseSeconds }))
      .then(result => { if (result.error || result.data !== true) { lost = true; abort.abort(); } })
      .catch(() => { lost = true; abort.abort(); }).finally(() => { renewal = undefined; });
    return renewal;
  };
  const heartbeat = setInterval(() => { void renew(); }, Math.floor(leaseSeconds * 1000 / 3)); heartbeat.unref();
  const checkLease = async () => { await renew(); if (lost || signal.aborted) throw new Error("Narration lease lost."); };
  const release = async (reason: string): Promise<QuotedNarrationOutcome> => {
    await checkLease();
    const result = await sb.rpc("release_quoted_narration_before_dispatch", { p_job_id: job.id, p_lease_token: job.lease_token, p_reason: reason });
    return result.error || result.data !== true ? unknown : { status: "released", jobId: job.id };
  };
  const review = async (reason: string, requestId = `narration-unknown:${job.id}`): Promise<QuotedNarrationOutcome> => {
    await checkLease();
    const result = await sb.rpc("hold_quoted_narration_for_review", { p_job_id: job.id, p_lease_token: job.lease_token,
      p_reason: reason, p_request_id: requestId });
    return result.error || result.data !== true ? unknown : { status: "requires_review", jobId: job.id };
  };
  const bytesAt = async (path: string, size: number, checksum: string, mp3 = false) => {
    await checkLease(); const result = await sb.storage.from("book-assets").download(path); await checkLease();
    if (result.error || !result.data) throw new AppError(503, "Private narration evidence is unavailable.");
    if (result.data.size !== size) throw new AppError(422, "Narration evidence size changed.");
    const bytes = Buffer.from(await result.data.arrayBuffer()); await checkLease();
    if (bytes.length !== size || sha(bytes) !== checksum || (mp3 && !isNarrationMp3(bytes))) throw new AppError(422, "Narration evidence integrity changed.");
    return bytes;
  };
  const persistBytes = async (path: string, bytes: Buffer, mimeType: string) => {
    await checkLease();
    // Never overwrite a late worker's output. A lost upload reply or deterministic
    // replay can continue only if the existing bytes are exactly the same.
    await sb.storage.from("book-assets").upload(path, bytes, { contentType: mimeType, upsert: false }).catch(() => {});
    await checkLease();
    return bytesAt(path, bytes.length, sha(bytes), mimeType === "audio/mpeg");
  };
  let expected: ReturnType<typeof reconcileNarrationUsage> | undefined;
  const savedCompletion = async () => {
    const result = await sb.from("ai_jobs").select("id,workspace_id,created_by,book_id,model,billing_mode,agent_type,status,output_ref")
      .eq("id", job.id).eq("workspace_id", job.workspace_id).eq("created_by", job.created_by).maybeSingle();
    const saved = result.data;
    if (result.error || !saved || !expected || expected.status !== "settle" || saved.id !== job.id
      || saved.workspace_id !== job.workspace_id || saved.created_by !== job.created_by || saved.book_id !== job.book_id
      || saved.model !== job.model || saved.billing_mode !== "quoted" || saved.agent_type !== "narrator" || saved.status !== "succeeded"
      || !isDeepStrictEqual(saved.output_ref, { assetId: job.id, audiobookProjectId: job.input_ref.audiobookProjectId, provider: "openai" })) return false;
    const fund = await loadFundedUsage(sb, job.id);
    return fund?.status === "settled" && isDeepStrictEqual(fund.settlement_json, expected);
  };
  try {
    await checkLease();
    const saved = await sb.from("narration_quote_snapshots").select("*").eq("id", job.input_ref.narrationQuoteId).maybeSingle(); await checkLease();
    const row = saved.data;
    const request = narrationQuoteRequestSchema.parse(row?.request_json);
    const fund = await loadFundedUsage(sb, job.id); await checkLease();
    if (saved.error || !row || row.id !== job.input_ref.narrationQuoteId || row.generation_job_id !== job.id
      || row.user_id !== job.created_by || row.workspace_id !== job.workspace_id || row.book_id !== job.book_id
      || row.edition_id !== request.editionId || row.chapter_id !== request.chapterId || row.document_version_id !== request.documentVersionId
      || request.jobId !== job.id || request.userId !== job.created_by || request.workspaceId !== job.workspace_id
      || request.bookId !== job.book_id || request.model !== job.model || narrationRequestHash(request) !== job.input_ref.requestSha256
      || row.request_sha256 !== job.input_ref.requestSha256 || !isDeepStrictEqual(request, job.input_ref.generationRequest)
      || !fund || fund.status !== "held" || !isDeepStrictEqual(row.quote_json, fund.quote_json)) throw new Error("Narration funded snapshot mismatch.");
    const quote = validatedNarrationQuote(fund.quote_json, request);
    const dispatch = await sb.from("funded_usage_quotes").select("dispatched_at,dispatched_lease").eq("job_id", job.id).maybeSingle(); await checkLease();
    if (dispatch.error || !dispatch.data || (dispatch.data.dispatched_at && !id.safeParse(dispatch.data.dispatched_lease).success)) throw new Error("Narration dispatch evidence unavailable.");
    const document = await sb.from("document_versions").select("id,chapter_id,plain_text")
      .eq("id", request.documentVersionId).eq("chapter_id", request.chapterId).maybeSingle(); await checkLease();
    const text = document.data?.plain_text;
    if (document.error || document.data?.id !== request.documentVersionId || document.data?.chapter_id !== request.chapterId
      || typeof text !== "string" || text.length > 2_000_000) return await (dispatch.data.dispatched_at ? review("invalid_result") : release("source_changed"));
    const points = Array.from(text), source = points.slice(request.textStart, request.textEnd).join("");
    if (request.textEnd > points.length || sha(source) !== request.textSha256 || !source.trim()
      || Buffer.byteLength(source, "utf8") + Buffer.byteLength(request.instructions ?? "", "utf8") > MAX_TTS_INPUT_BYTES) {
      return await (dispatch.data.dispatched_at ? review("invalid_result") : release("source_changed"));
    }
    let original: z.infer<typeof originalSchema>;
    if (dispatch.data.dispatched_at) {
      const result = await sb.from("quoted_narration_receipts").select("*").eq("job_id", job.id).maybeSingle(); await checkLease();
      if (result.error) return unknown;
      if (!result.data) return await review("provider_outcome_unknown");
      try { original = originalSchema.parse(result.data); } catch { return await review("invalid_result"); }
    } else {
      if (!options.generator && (process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED !== "true" || !process.env.OPENAI_API_KEY?.trim())) return await release("provider_not_configured");
      if (!options.encoder && !(process.env.RENDERING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN)) return await release("provider_not_configured");
      await checkLease();
      try { await claimPricedDispatch(sb, { jobId: job.id, leaseToken: job.lease_token, inputSha256: job.input_ref.requestSha256, model: job.model }); }
      catch (error) {
        if (error instanceof AppError && (error.status === 403 || error.status === 422)) return await release(error.status === 403 ? "access_changed" : "source_changed");
        return unknown; // A lost/false dispatch reply is never permission or a refund.
      }
      await checkLease();
      let generated;
      try { generated = await (options.generator ?? generateRealtimeNarration)({ model: request.model, userId: request.userId,
        text: source, voice: request.voice, speed: request.speed, instructions: request.instructions, maxOutputTokens: request.maxOutputTokens }, { signal }); }
      catch { return await review("provider_outcome_unknown"); }
      await checkLease();
      let receipt: z.infer<typeof pcmSchema>;
      try {
        if (!Buffer.isBuffer(generated.bytes) || generated.sourceSha256 !== request.textSha256 || generated.model !== request.model
          || generated.audioSha256 !== sha(generated.bytes)) throw new Error("Invalid original narration.");
        receipt = pcmSchema.parse({ version: "bookworm-narration-pcm-v1", provider: generated.provider, model: generated.model,
          requestId: generated.responseId, sourceSha256: generated.sourceSha256,
          storagePath: `private/narration/${job.workspace_id}/${job.id}/${job.lease_token}.pcm`, mimeType: generated.mimeType,
          sizeBytes: generated.bytes.length, checksum: generated.audioSha256, sampleRateHz: generated.sampleRateHz,
          channels: generated.channels, bitDepth: generated.bitDepth, durationSeconds: generated.durationSeconds,
          transcript: generated.transcript, rawUsage: generated.rawUsage, latencyMs: generated.latencyMs });
      } catch { return await review("invalid_result"); }
      try { await persistBytes(receipt.storagePath, generated.bytes, "audio/pcm"); }
      catch (error) { return error instanceof AppError && error.status === 422 ? await review("storage_unconfirmed", receipt.requestId) : unknown; }
      await checkLease();
      const result = await sb.rpc("save_quoted_narration_receipt", { p_job_id: job.id, p_lease_token: job.lease_token,
        p_request_sha256: job.input_ref.requestSha256, p_receipt: receipt });
      if (result.error || !first(result.data)) return unknown;
      original = originalSchema.parse(first(result.data));
      if (!isDeepStrictEqual(original.receipt_json, receipt)) throw new Error("Original capture reply mismatch.");
      dispatch.data.dispatched_lease = job.lease_token;
    }
    const pcm = original.receipt_json;
    if (original.job_id !== job.id || original.request_sha256 !== job.input_ref.requestSha256 || pcm.model !== request.model
      || pcm.sourceSha256 !== request.textSha256 || pcm.storagePath !== `private/narration/${job.workspace_id}/${job.id}/${dispatch.data.dispatched_lease}.pcm`) return await review("invalid_result");
    let sourceBytes: Buffer;
    try { sourceBytes = await bytesAt(pcm.storagePath, pcm.sizeBytes, pcm.checksum); }
    catch (error) { return error instanceof AppError && error.status === 422 ? await review("storage_unconfirmed", pcm.requestId) : unknown; }
    expected = reconcileNarrationUsage(quote, { request, sourceText: source, receipt: { jobId: job.id, userId: job.created_by,
      workspaceId: job.workspace_id, requestSha256: original.request_sha256, sourceSha256: pcm.sourceSha256,
      provider: pcm.provider, model: pcm.model, responseId: pcm.requestId, transcript: pcm.transcript, rawUsage: pcm.rawUsage } });
    if (expected.status !== "settle") return await review(expected.reason === "transcript_mismatch" ? "transcript_mismatch" : "usage_unreconciled", pcm.requestId);
    const path = `workspaces/${job.workspace_id}/audiobooks/${job.input_ref.audiobookProjectId}/${request.segmentIndex}.mp3`;
    const savedEncoding = await sb.from("quoted_narration_encodings").select("*").eq("job_id", job.id).maybeSingle(); await checkLease();
    if (savedEncoding.error) return unknown;
    let encoding: z.infer<typeof encodingRowSchema>;
    if (savedEncoding.data) { try { encoding = encodingRowSchema.parse(savedEncoding.data); } catch { return await review("encoding_failed", pcm.requestId); } }
    else {
      let converted;
      try { converted = await (options.encoder ?? encodeNarrationPcm)(sourceBytes, { signal }); }
      catch (error) { return error instanceof AppError && error.status === 422 ? await review("encoding_failed", pcm.requestId) : unknown; }
      await checkLease();
      const profile = narrationEncodingProfileSchema.parse(converted.profile);
      if (!Buffer.isBuffer(converted.bytes) || !isNarrationMp3(converted.bytes) || profile.pcmSha256 !== pcm.checksum
        || converted.checksum !== sha(converted.bytes)) return await review("encoding_failed", pcm.requestId);
      const receipt = encodedSchema.parse({ version: "bookworm-narration-mp3-v1", pcmReceiptSha256: original.receipt_sha256,
        assetId: job.id, storagePath: path, mimeType: "audio/mpeg", sizeBytes: converted.bytes.length, checksum: converted.checksum,
        durationSeconds: profile.durationSeconds, encodingVersion: profile.encodingVersion, sampleRateHz: profile.sampleRateHz,
        channels: profile.channels, bitRateKbps: profile.bitRateKbps, bitRateMode: profile.bitRateMode });
      if (Math.abs(receipt.durationSeconds - pcm.durationSeconds) > 0.25) return await review("encoding_failed", pcm.requestId);
      try { await persistBytes(path, converted.bytes, "audio/mpeg"); }
      catch (error) { return error instanceof AppError && error.status === 422 ? await review("storage_unconfirmed", pcm.requestId) : unknown; }
      await checkLease();
      const result = await sb.rpc("save_quoted_narration_encoding", { p_job_id: job.id, p_lease_token: job.lease_token,
        p_pcm_receipt_sha256: original.receipt_sha256, p_receipt: receipt });
      if (result.error || !first(result.data)) return unknown;
      encoding = encodingRowSchema.parse(first(result.data));
      if (!isDeepStrictEqual(encoding.receipt_json, receipt)) throw new Error("Encoding reply mismatch.");
    }
    const encoded = encoding.receipt_json;
    if (encoding.job_id !== job.id || encoding.pcm_receipt_sha256 !== original.receipt_sha256 || encoded.pcmReceiptSha256 !== original.receipt_sha256
      || encoded.assetId !== job.id || encoded.storagePath !== path || Math.abs(encoded.durationSeconds - pcm.durationSeconds) > 0.25) return await review("encoding_failed", pcm.requestId);
    try { await bytesAt(path, encoded.sizeBytes, encoded.checksum, true); }
    catch (error) { return error instanceof AppError && error.status === 422 ? await review("storage_unconfirmed", pcm.requestId) : unknown; }
    await checkLease(); finishing = true;
    await sb.rpc("complete_quoted_narration_job", { p_job_id: job.id, p_lease_token: job.lease_token });
    return await savedCompletion() ? { status: "succeeded", jobId: job.id } : unknown;
  } catch {
    if (finishing) { try { if (await savedCompletion()) return { status: "succeeded", jobId: job.id }; } catch { /* Read failure stays unknown. */ } }
    return unknown;
  } finally { clearInterval(heartbeat); await renewal; }
}
