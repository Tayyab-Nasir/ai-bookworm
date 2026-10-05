import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import { loadFundedUsage, claimPricedDispatch } from "./funded-usage.js";
import { imageRequestHash, reconcileImageUsage, type ImageQuoteRequest } from "./image-pricing.js";
import { openAiImageGenerator, type ImageGenerator } from "./image-generation.js";

const id = z.string().uuid();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const jobSchema = z.object({ id, workspace_id: id, created_by: id, book_id: id.nullable(),
  model: z.string(), billing_mode: z.literal("quoted"), agent_type: z.enum(["illustrator", "cover_designer"]),
  lease_token: id, input_ref: z.object({ imageQuoteId: id, requestSha256: digest, generationRequest: z.unknown() }) });
const receiptSchema = z.object({ assetId: id, name: z.string().min(1).max(256), provider: z.literal("openai"),
  model: z.string(), requestId: z.string().trim().min(1).max(256), mimeType: z.literal("image/png"),
  checksum: digest, sizeBytes: z.number().int().positive().max(25 * 1024 * 1024), storagePath: z.string(),
  usage: z.object({ reconciliationStatus: z.enum(["supported", "requires_review"]), providerTokenUsage: z.unknown() }).passthrough() }).strict();
type Job = z.infer<typeof jobSchema>;
type Receipt = z.infer<typeof receiptSchema>;
const first = (value: unknown) => Array.isArray(value) ? value[0] : value;
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export type QuotedImageOutcome = { status: "idle" | "succeeded" | "released" | "requires_review" | "completion_unknown"; jobId?: string };

async function verifiedBytes(sb: SupabaseClient, path: string, size: number, checksum: string, checkLease: () => Promise<void>) {
  await checkLease();
  const file = await sb.storage.from("book-assets").download(path);
  await checkLease();
  if (file.error || !file.data || file.data.size !== size) throw new Error("image storage unavailable");
  const bytes = Buffer.from(await file.data.arrayBuffer());
  if (sha(bytes) !== checksum || !bytes.subarray(0, 8).equals(png)) throw new Error("image integrity mismatch");
  return bytes;
}

async function references(sb: SupabaseClient, request: ImageQuoteRequest, checkLease: () => Promise<void>) {
  const result: { bytes: Buffer; mimeType: "image/png" }[] = [];
  for (const ref of request.references) {
    await checkLease();
    const asset = await sb.from("assets").select("storage_path,checksum,size_bytes,mime_type,deleted_at")
      .eq("id", ref.assetId).eq("workspace_id", request.workspaceId).maybeSingle();
    const a = asset.data;
    if (asset.error || !a || a.deleted_at || a.checksum !== ref.sha256 || a.mime_type !== "image/png"
      || !Number.isInteger(a.size_bytes) || a.size_bytes <= 0 || a.size_bytes > 5 * 1024 * 1024
      || !String(a.storage_path).startsWith(`workspaces/${request.workspaceId}/assets/${ref.assetId}/`)
      || String(a.storage_path).includes("..")) throw new Error("reference changed");
    await checkLease();
    const version = await sb.from("asset_versions").select("checksum,storage_path,scan_status")
      .eq("asset_id", ref.assetId).eq("version_number", ref.version).maybeSingle();
    if (version.error || !version.data || version.data.checksum !== ref.sha256 || version.data.storage_path !== a.storage_path
      || !["clean", "trusted_generated"].includes(version.data.scan_status)) throw new Error("reference changed");
    result.push({ bytes: await verifiedBytes(sb, a.storage_path, a.size_bytes, ref.sha256, checkLease), mimeType: "image/png" });
  }
  return result;
}

export async function runOneQuotedImageJob(sb: SupabaseClient, options: { generator?: ImageGenerator; leaseSeconds?: number } = {}): Promise<QuotedImageOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 180;
  const claim = await sb.rpc("claim_quoted_image_job", { p_lease_seconds: leaseSeconds });
  if (claim.error) throw new Error("image claim unavailable");
  if (!first(claim.data)) return { status: "idle" };
  const job = jobSchema.parse(first(claim.data));
  let lost = false;
  let completionAttempted = false;
  let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = Promise.resolve().then(() => sb.rpc("renew_quoted_image_lease", { p_job_id: job.id, p_lease_token: job.lease_token, p_lease_seconds: leaseSeconds }))
      .then(r => { if (r.error || r.data !== true) lost = true; }).catch(() => { lost = true; }).finally(() => { renewal = undefined; });
  }, Math.floor(leaseSeconds * 1000 / 3));
  heartbeat.unref();
  const checkLease = async () => {
    await renewal;
    if (lost) throw new Error("lease lost");
  };
  const review = async (reason: string, requestId: string): Promise<QuotedImageOutcome> => {
    await checkLease();
    const response = await sb.rpc("hold_quoted_image_for_review", { p_job_id: job.id, p_lease_token: job.lease_token,
      p_reason: reason, p_request_id: requestId });
    return { status: response.error || response.data !== true ? "completion_unknown" : "requires_review", jobId: job.id };
  };
  const savedCompletion = async () => {
    // Completion may have committed before its reply/lease was lost. This is an
    // authoritative read only; it must never release a hold or redispatch.
    const result = await sb.from("ai_jobs").select("id,workspace_id,created_by,book_id,model,billing_mode,agent_type,status")
      .eq("id", job.id).eq("workspace_id", job.workspace_id).eq("created_by", job.created_by).maybeSingle();
    const saved = result.data;
    return !result.error && saved?.id === job.id && saved.workspace_id === job.workspace_id && saved.created_by === job.created_by
      && saved.book_id === job.book_id && saved.model === job.model && saved.billing_mode === "quoted"
      && saved.agent_type === job.agent_type && saved.status === "succeeded";
  };
  try {
    await checkLease();
    const snapshot = await sb.from("image_quote_snapshots").select("*").eq("id", job.input_ref.imageQuoteId).maybeSingle();
    const row = snapshot.data;
    const request = row?.request_json as ImageQuoteRequest;
    await checkLease();
    const funded = await loadFundedUsage(sb, job.id);
    if (snapshot.error || !row || !funded || funded.status !== "held" || row.generation_job_id !== job.id
      || row.user_id !== job.created_by || row.workspace_id !== job.workspace_id || row.book_id !== job.book_id
      || request.jobId !== job.id || request.userId !== job.created_by || request.workspaceId !== job.workspace_id
      || request.bookId !== job.book_id || request.model !== job.model
      || request.kind !== (job.agent_type === "cover_designer" ? "cover" : "illustration")
      || imageRequestHash(request) !== job.input_ref.requestSha256 || row.request_sha256 !== job.input_ref.requestSha256
      || !isDeepStrictEqual(request, job.input_ref.generationRequest) || !isDeepStrictEqual(row.quote_json, funded.quote_json)) throw new Error("image quote mismatch");
    await checkLease();
    const dispatch = await sb.from("funded_usage_quotes").select("dispatched_at").eq("job_id", job.id).maybeSingle();
    if (dispatch.error || !dispatch.data) throw new Error("dispatch state unavailable");
    let receipt: Receipt;
    if (dispatch.data.dispatched_at) {
      await checkLease();
      const saved = await sb.from("quoted_image_receipts").select("request_sha256,receipt_json").eq("job_id", job.id).maybeSingle();
      if (saved.error) throw new Error("receipt read unavailable");
      if (!saved.data) return await review("provider_outcome_unknown", `image-unknown:${job.id}`);
      if (saved.data.request_sha256 !== job.input_ref.requestSha256) throw new Error("receipt scope mismatch");
      receipt = receiptSchema.parse(saved.data.receipt_json);
    } else {
      const release = async (reason: string): Promise<QuotedImageOutcome> => {
        await checkLease();
        const r = await sb.rpc("release_quoted_image_before_dispatch", { p_job_id: job.id, p_lease_token: job.lease_token, p_reason: reason });
        return { status: r.error || r.data !== true ? "completion_unknown" : "released", jobId: job.id };
      };
      if (!options.generator && !process.env.OPENAI_API_KEY?.trim()) return await release("provider_not_configured");
      let images: Awaited<ReturnType<typeof references>>;
      try { images = await references(sb, request, checkLease); } catch { return await release("source_changed"); }
      await checkLease();
      await claimPricedDispatch(sb, { jobId: job.id, leaseToken: job.lease_token, inputSha256: job.input_ref.requestSha256, model: job.model });
      await checkLease();
      let generated;
      try { generated = await (options.generator ?? openAiImageGenerator)({ model: request.model, prompt: request.prompt,
        size: request.size, quality: request.quality, referenceImages: images }); }
      catch { return await review("provider_outcome_unknown", `image-unknown:${job.id}`); }
      const assetId = randomUUID();
      const storagePath = `workspaces/${job.workspace_id}/assets/${assetId}/v1/generated.png`;
      try {
        receipt = receiptSchema.parse({ assetId, storagePath, name: request.kind === "cover" ? "Generated cover artwork" : "Generated illustration",
          provider: generated.provider, model: generated.model, requestId: generated.requestId, mimeType: generated.mimeType,
          checksum: sha(generated.bytes), sizeBytes: generated.bytes.length, usage: generated.usage });
        if (receipt.model !== job.model || !generated.bytes.subarray(0, 8).equals(png)) throw new Error("invalid image");
      } catch { return await review("invalid_result", `image-invalid:${job.id}`); }
      await checkLease();
      const upload = await sb.storage.from("book-assets").upload(storagePath, generated.bytes, { contentType: "image/png", upsert: false });
      if (upload.error) return await review("storage_unconfirmed", receipt.requestId);
      await checkLease();
      const saved = await sb.rpc("save_quoted_image_receipt", { p_job_id: job.id, p_lease_token: job.lease_token,
        p_request_sha256: job.input_ref.requestSha256, p_receipt: receipt });
      if (saved.error || !first(saved.data)) return { status: "completion_unknown", jobId: job.id };
    }
    if (receipt.model !== job.model || receipt.storagePath !== `workspaces/${job.workspace_id}/assets/${receipt.assetId}/v1/generated.png`) throw new Error("image receipt identity mismatch");
    try { await verifiedBytes(sb, receipt.storagePath, receipt.sizeBytes, receipt.checksum, checkLease); }
    catch { return await review("storage_unconfirmed", receipt.requestId); }
    let settlement;
    try {
      if (receipt.usage.reconciliationStatus !== "supported") throw new Error("unsupported raw usage");
      settlement = reconcileImageUsage(funded.quote_json, { request, requestId: receipt.requestId, model: receipt.model, providerUsage: receipt.usage.providerTokenUsage });
      if (settlement.status !== "settle") throw new Error("usage exceeds quote");
    } catch { return await review("usage_unreconciled", receipt.requestId); }
    await checkLease();
    completionAttempted = true;
    const completed = await sb.rpc("complete_quoted_image_job", { p_job_id: job.id, p_lease_token: job.lease_token, p_settlement: settlement });
    const completedJob = first(completed.data) as { id?: string; status?: string } | null;
    return { status: completed.error || completedJob?.id !== job.id || completedJob.status !== "succeeded"
      ? await savedCompletion() ? "succeeded" : "completion_unknown" : "succeeded", jobId: job.id };
  } catch {
    if (completionAttempted) {
      try { if (await savedCompletion()) return { status: "succeeded", jobId: job.id }; }
      catch { /* An unavailable authoritative read remains an unknown completion. */ }
    }
    return { status: "completion_unknown", jobId: job.id };
  }
  finally { clearInterval(heartbeat); await renewal; }
}
