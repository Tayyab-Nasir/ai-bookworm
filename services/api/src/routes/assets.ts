import type { FastifyInstance } from "fastify";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import { requireWorkspaceEditor, requireWorkspaceMember, canEditWorkspace } from "../lib/authorize.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { logActivity } from "../lib/activity.js";
import { requireEntitlement } from "../lib/entitlements.js";
import { openAiImageGenerator, type ImageGenerator } from "../lib/image-generation.js";
import { imageBookContext } from "../lib/image-book-context.js";
import { imageCompletionError } from "../lib/image-completion-error.js";
import {
  AssetInspectionError,
  MAX_USER_ASSET_BYTES,
  USER_ASSET_MIME_TYPES,
  sniffAssetContent,
  createHttpAssetScanner,
  validateAssetUploadDeclaration,
  type AssetMalwareScanner,
  type DetectedAssetMimeType,
} from "../lib/asset-scanner.js";

const BUCKET = "book-assets";
const MAX_UPLOAD_BYTES = MAX_USER_ASSET_BYTES;
const MAX_GENERATED_IMAGE_BYTES = 25 * 1024 * 1024;

const uploadUrlSchema = z.object({
  workspaceId: z.string().uuid(),
  filename: z.string().trim().min(1).max(256),
  mimeType: z.enum(USER_ASSET_MIME_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  folderId: z.string().uuid().nullish(),
  type: z.enum(["source_document", "manuscript", "illustration", "cover"]).optional(),
}).strict();

const confirmSchema = z.object({
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
}).strict();

const newVersionSchema = z.object({
  filename: z.string().trim().min(1).max(256),
  mimeType: z.enum(USER_ASSET_MIME_TYPES),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
}).strict();

const confirmVersionSchema = z.object({
  checksumSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  sizeBytes: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
}).strict();

const patchSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    folderId: z.string().uuid().nullable().optional(),
    status: z.enum(["draft", "in_review", "approved", "rejected", "archived"]).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: "nothing to update" });

const generateSchema = z.object({
  workspaceId: z.string().uuid(),
  bookId: z.string().uuid().nullable().optional(),
  folderId: z.string().uuid().nullable().optional(),
  kind: z.enum(["illustration", "front_cover"]),
  name: z.string().trim().min(1).max(256),
  prompt: z.string().trim().min(10).max(4_000),
  size: z.enum(["1024x1024", "1024x1536", "1536x1024"]).default("1024x1024"),
  quality: z.enum(["low", "medium", "high"]).default("medium"),
  idempotencyKey: z.string().trim().min(8).max(200),
  referenceAssetIds: z.array(z.string().uuid()).max(4).default([]).refine(ids => new Set(ids).size === ids.length, "Do not repeat reference images."),
}).strict();

// Storage path per spec section 6: workspaces/{workspace_id}/assets/{asset_id}/v{version}/{safe_filename}
function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "file";
  const safe = base.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "_");
  return safe.slice(0, 128) || "file";
}

interface AssetRow {
  id: string;
  workspace_id: string;
  deleted_at: string | null;
}

interface PendingVersionRow {
  version_number: number;
  storage_path: string;
  checksum: string;
  mime_type: string;
  size_bytes: number;
  scan_status?: string;
}

async function loadAsset(sb: SupabaseClient, assetId: string): Promise<AssetRow> {
  const { data } = await sb.from("assets").select("id,workspace_id,deleted_at").eq("id", assetId).maybeSingle();
  if (!data) throw new AppError(404, "asset not found");
  return data as AssetRow;
}

export function assetRoutes(app: FastifyInstance, options: { imageGenerator?: ImageGenerator; assetScanner?: AssetMalwareScanner } = {}) {
  const imageGenerator = options.imageGenerator ?? openAiImageGenerator;
  const assetScanner = options.assetScanner ?? createHttpAssetScanner();

  async function persistScanVerdict(service: SupabaseClient, input: {
    assetId: string;
    version: number;
    verdict: "clean" | "infected" | "error";
    checksumSha256: string;
    detectedMimeType: DetectedAssetMimeType | null;
    sizeBytes: number;
    scanner: string;
    signature?: string | null;
    errorCode?: string | null;
  }) {
    const result = await service.rpc("record_asset_scan_verdict", {
      p_asset_id: input.assetId,
      p_version_number: input.version,
      p_verdict: input.verdict,
      p_checksum: input.checksumSha256,
      p_detected_mime_type: input.detectedMimeType,
      p_size_bytes: input.sizeBytes,
      p_scanner: input.scanner,
      p_signature: input.signature ?? null,
      p_error_code: input.errorCode ?? null,
    });
    if (result.error) throw new AppError(503, "The scan verdict could not be recorded; the upload remains quarantined.");
  }

  async function inspectAndScan(input: {
    user: SupabaseClient;
    service: SupabaseClient;
    assetId: string;
    workspaceId: string;
    filename: string;
    version: PendingVersionRow;
    claimedChecksum: string;
    claimedSize: number;
  }) {
    // Pending objects are intentionally invisible to authenticated users at the
    // Storage RLS boundary. Authorization is completed before this helper, then
    // the private API service reads the quarantined bytes for inspection.
    const stored = await input.service.storage.from(BUCKET).download(input.version.storage_path);
    if (stored.error || !stored.data) throw new AppError(409, "Uploaded file is not available.");
    if (stored.data.size > MAX_USER_ASSET_BYTES) {
      throw new AppError(413, "Stored upload exceeds the scan size limit and remains quarantined.");
    }
    const bytes = Buffer.from(await stored.data.arrayBuffer());
    const checksum = createHash("sha256").update(bytes).digest("hex");
    const baseVerdict = {
      assetId: input.assetId,
      version: input.version.version_number,
      checksumSha256: checksum,
      detectedMimeType: null as DetectedAssetMimeType | null,
      sizeBytes: bytes.length,
    };
    if (bytes.length !== Number(input.version.size_bytes) || bytes.length !== input.claimedSize) {
      await persistScanVerdict(input.service, { ...baseVerdict, verdict: "error", scanner: "integrity-check", errorCode: "size_mismatch" });
      throw new AppError(422, "Size does not match the declared upload.");
    }
    if (checksum !== input.claimedChecksum.toLowerCase()) {
      await persistScanVerdict(input.service, { ...baseVerdict, verdict: "error", scanner: "integrity-check", errorCode: "checksum_mismatch" });
      throw new AppError(422, "Checksum does not match the stored upload.");
    }

    let detectedMimeType: DetectedAssetMimeType;
    try {
      detectedMimeType = sniffAssetContent(bytes, input.filename, input.version.mime_type);
    } catch (error) {
      if (!(error instanceof AssetInspectionError)) throw error;
      await persistScanVerdict(input.service, {
        ...baseVerdict,
        verdict: "error",
        scanner: "bookworm-content-sniffer",
        signature: "v1",
        errorCode: error.code,
      });
      throw new AppError(422, error.message);
    }

    let verdict: Awaited<ReturnType<AssetMalwareScanner["scan"]>>;
    try {
      verdict = await assetScanner.scan({
        assetId: input.assetId,
        workspaceId: input.workspaceId,
        version: input.version.version_number,
        filename: input.filename,
        bytes,
        checksumSha256: checksum,
        detectedMimeType,
      });
      if (!verdict || !["clean", "infected"].includes(verdict.verdict)
        || typeof verdict.signature !== "string" || !verdict.signature.trim() || verdict.signature.length > 200) {
        throw new Error("invalid scanner response");
      }
    } catch {
      await persistScanVerdict(input.service, {
        ...baseVerdict,
        detectedMimeType,
        verdict: "error",
        scanner: assetScanner.name.slice(0, 100) || "unavailable",
        errorCode: "scanner_unavailable",
      });
      throw new AppError(503, "Malware screening is unavailable; the upload remains quarantined.");
    }

    await persistScanVerdict(input.service, {
      ...baseVerdict,
      detectedMimeType,
      verdict: verdict.verdict,
      scanner: assetScanner.name.slice(0, 100),
      signature: verdict.signature.trim(),
      errorCode: verdict.verdict === "infected" ? "malware_detected" : null,
    });
    if (verdict.verdict === "infected") {
      throw new AppError(422, "The upload was rejected by malware screening.");
    }
    return { checksum, detectedMimeType, sizeBytes: bytes.length };
  }

  app.get("/assets/access", async (req, reply) => {
    const parsed = z.object({ workspaceId: z.string().uuid() }).strict().safeParse(req.query);
    if (!parsed.success) throw new AppError(422, "Check the workspace access request.");
    const role = await requireWorkspaceMember(app.supabaseFactory(req.userToken), parsed.data.workspaceId, req.userId);
    reply.header("cache-control", "private, no-store");
    return { canEdit: canEditWorkspace(role) };
  });

  app.get("/assets/generation-jobs", async (req, reply) => {
    const parsed = z.object({ workspaceId: z.string().uuid(), limit: z.coerce.number().int().min(1).max(50).default(20) }).strict().safeParse(req.query);
    if (!parsed.success) throw new AppError(422, "Check the image history request.");
    const user = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(user, parsed.data.workspaceId, req.userId);
    const { data, error } = await user.from("ai_jobs")
      .select("id,book_id,agent_type,status,created_at,completed_at")
      .eq("workspace_id", parsed.data.workspaceId).eq("created_by", req.userId)
      .in("agent_type", ["illustrator", "cover_designer"]).order("created_at", { ascending: false }).limit(parsed.data.limit);
    if (error) throw new AppError(503, "Image request history is temporarily unavailable.");
    reply.header("cache-control", "private, no-store");
    return { jobs: (data ?? []).map(job => ({ id: job.id, bookId: job.book_id ?? null,
      kind: job.agent_type === "cover_designer" ? "front_cover" : "illustration", status: job.status,
      createdAt: job.created_at, completedAt: job.completed_at ?? null })) };
  });

  app.post("/assets/generation-jobs/:jobId/finalize", async (req, reply) => {
    const jobId = z.string().uuid().safeParse((req.params as { jobId: string }).jobId);
    if (!jobId.success) throw new AppError(422, "Invalid image request.");
    const user = app.supabaseFactory(req.userToken);
    const { data: job, error } = await user.from("ai_jobs").select("id,workspace_id,created_by,agent_type,status")
      .eq("id", jobId.data).eq("created_by", req.userId).maybeSingle();
    if (error || !job || !["illustrator", "cover_designer"].includes(job.agent_type)) throw new AppError(404, "Image request not found.");
    await requireWorkspaceEditor(user, job.workspace_id, req.userId);
    if (job.status === "succeeded") return { jobId: job.id, status: "succeeded" };
    if (job.status !== "running") throw new AppError(409, "This image request cannot be finalized.");
    const service = app.supabaseFactory();
    const { data: receipt, error: receiptError } = await service.from("image_completion_receipts").select("completion_json").eq("job_id", job.id).maybeSingle();
    if (receiptError) throw new AppError(503, "Image recovery information is temporarily unavailable.");
    if (!receipt) throw new AppError(409, "No saved completion record is available yet. The provider may still be processing; do not start a duplicate request.");
    const parsed = z.object({ p_job_id: z.literal(job.id), p_asset_id: z.string().uuid(), p_storage_path: z.string(),
      p_checksum: z.string().regex(/^[a-f0-9]{64}$/), p_size_bytes: z.number().int().min(1).max(MAX_GENERATED_IMAGE_BYTES),
      p_mime_type: z.literal("image/png") }).passthrough().safeParse(receipt.completion_json);
    if (!parsed.success || parsed.data.p_storage_path !== `workspaces/${job.workspace_id}/assets/${parsed.data.p_asset_id}/v1/generated.png`) {
      throw new AppError(409, "The saved completion record failed validation.");
    }
    const { data: file, error: fileError } = await service.storage.from(BUCKET).download(parsed.data.p_storage_path);
    if (fileError || !file) throw new AppError(503, "The saved image is temporarily unavailable.");
    if (file.size !== parsed.data.p_size_bytes) throw new AppError(409, "The saved image size changed. Recovery stopped.");
    const bytes = Buffer.from(await file.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== parsed.data.p_checksum) throw new AppError(409, "The saved image checksum changed. Recovery stopped.");
    let completionRefusal: unknown;
    try {
      const completed = await service.rpc("complete_image_job", parsed.data);
      completionRefusal = completed.error;
      if (!completed.error) { reply.header("cache-control", "private, no-store"); return { jobId: job.id, status: "succeeded" }; }
    } catch { /* Confirm authoritative state before reporting uncertainty. */ }
    const { data: confirmed, error: confirmError } = await service.from("ai_jobs").select("status").eq("id", job.id).maybeSingle();
    if (!confirmError && confirmed?.status === "succeeded") return { jobId: job.id, status: "succeeded" };
    const refusal = imageCompletionError(completionRefusal);
    if (refusal) throw refusal;
    throw new AppError(503, "Image finalization is unconfirmed. Refresh history before retrying. No new image generation was started.");
  });

  app.post("/assets/generate", async (req, reply) => {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Check the image request.", { issues: parsed.error.issues });
    const input = parsed.data;
    const user = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(user, input.workspaceId, req.userId);
    const service = app.supabaseFactory();
    const requestHash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const { data: previous, error: previousError } = await service.from("ai_jobs").select("*")
      .eq("workspace_id", input.workspaceId).eq("created_by", req.userId).eq("idempotency_key", input.idempotencyKey).maybeSingle();
    if (previousError) throw new AppError(503, "Could not check the original image request.");
    if (previous) {
      if (previous.input_ref?.requestHash !== requestHash) throw new AppError(409, "This request key belongs to different image settings.");
      if (previous.status !== "succeeded") throw new AppError(409, "The original image request is not complete. Check your asset library before submitting another request.");
      const { data: asset, error: assetError } = await user.from("assets").select("*")
        .eq("id", previous.output_ref?.assetId).eq("workspace_id", input.workspaceId).maybeSingle();
      if (assetError || !asset || asset.deleted_at) throw new AppError(409, "The original generated asset is unavailable.");
      const { data: version, error: versionError } = await user.from("asset_versions").select("scan_status,checksum")
        .eq("asset_id", asset.id).eq("storage_path", asset.storage_path).maybeSingle();
      if (versionError || !version || version.checksum !== asset.checksum || !["clean", "trusted_generated"].includes(String(version.scan_status))) {
        throw new AppError(409, "The original generated asset is not available for download.");
      }
      const { data: signed, error: signError } = await user.storage.from(BUCKET).createSignedUrl(asset.storage_path, 300);
      if (signError || !signed?.signedUrl) throw new AppError(503, "The original image is saved, but its preview is temporarily unavailable.");
      reply.header("cache-control", "private, no-store");
      return reply.status(200).send({ jobId: previous.id, asset, preview: { url: signed.signedUrl, expiresIn: 300 },
        provider: previous.output_ref?.provider ?? "openai", model: previous.model, requestId: null, replayed: true });
    }
    const { data: workspace, error: workspaceError } = await service.from("workspaces")
      .select("organization_id").eq("id", input.workspaceId).maybeSingle();
    if (workspaceError || !workspace) throw new AppError(404, "Workspace not found.");
    await requireEntitlement(service, workspace.organization_id, "image_credits", 1);

    let book: Record<string, unknown> | null = null;
    let bible: Record<string, unknown>[] = [];
    if (input.bookId) {
      const bookResult = await user.from("books").select("id,workspace_id,title,subtitle,author_name,genre,language")
        .eq("id", input.bookId).eq("workspace_id", input.workspaceId).maybeSingle();
      if (bookResult.error || !bookResult.data) throw new AppError(404, "Book not found in this workspace.");
      book = bookResult.data;
      const bibleResult = await user.from("book_bible_items").select("type,name,description,attributes_json")
        .eq("book_id", input.bookId).order("id", { ascending: true }).limit(100);
      if (bibleResult.error) throw new AppError(500, "Could not load saved book context.");
      bible = bibleResult.data ?? [];
    }
    if (input.folderId) {
      const { data: folder, error } = await user.from("folders").select("id").eq("id", input.folderId)
        .eq("workspace_id", input.workspaceId).maybeSingle();
      if (error || !folder) throw new AppError(422, "Folder must belong to this workspace.");
    }

    const referenceImages: { bytes: Buffer; mimeType: "image/png" }[] = [];
    const referenceSources: { assetId: string; checksum: string }[] = [];
    for (const referenceId of input.referenceAssetIds) {
      const { data: asset, error } = await user.from("assets").select("id,workspace_id,storage_path,checksum,mime_type,size_bytes,deleted_at")
        .eq("id", referenceId).eq("workspace_id", input.workspaceId).maybeSingle();
      if (error || !asset || asset.deleted_at) throw new AppError(404, "Reference image not found in this workspace.");
      const prefix = `workspaces/${input.workspaceId}/assets/${referenceId}/`;
      if (asset.mime_type !== "image/png" || !Number.isInteger(asset.size_bytes) || asset.size_bytes <= 0 || asset.size_bytes > 5 * 1024 * 1024
        || !String(asset.storage_path).startsWith(prefix) || String(asset.storage_path).includes("..") || !/^[a-f0-9]{64}$/.test(String(asset.checksum))) {
        throw new AppError(422, "Reference images must be confirmed PNG files up to 5 MiB.");
      }
      const { data: version, error: versionError } = await user.from("asset_versions").select("scan_status,checksum")
        .eq("asset_id", referenceId).eq("storage_path", asset.storage_path).maybeSingle();
      if (versionError || !version || version.checksum !== asset.checksum || !["clean", "trusted_generated"].includes(String(version.scan_status))) {
        throw new AppError(409, "Reference image remains quarantined or has changed.");
      }
      const { data: file, error: downloadError } = await user.storage.from(BUCKET).download(asset.storage_path);
      if (downloadError || !file) throw new AppError(503, "Reference image could not be read.");
      if (file.size !== asset.size_bytes) throw new AppError(409, "Reference image size changed.");
      const bytes = Buffer.from(await file.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== asset.checksum || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        throw new AppError(409, "Reference image integrity verification failed.");
      }
      referenceImages.push({ bytes, mimeType: "image/png" });
      referenceSources.push({ assetId: referenceId, checksum: String(asset.checksum) });
    }
    const context = imageBookContext(book, bible);
    const instruction = input.kind === "front_cover"
      ? "Create cover artwork only. Do not render any title, author name, lettering, logo, barcode, or QR code; Bookworm adds typography during layout."
      : "Create a book illustration without captions, lettering, logos, watermarks, barcodes, or QR codes.";
    const providerPrompt = `${instruction}\n${context}\nAuthor direction: ${input.prompt}`;
    const providerPromptHash = createHash("sha256").update(providerPrompt).digest("hex");
    const jobId = randomUUID();
    const promptHash = createHash("sha256").update(input.prompt).digest("hex");
    const { error: jobError } = await service.from("ai_jobs").insert({
      id: jobId, workspace_id: input.workspaceId, book_id: input.bookId ?? null,
      agent_type: input.kind === "front_cover" ? "cover_designer" : "illustrator", status: "running",
      input_ref: { promptHash, requestHash, providerPromptHash, referenceSources,
        contextVersion: "image-book-context-1", size: input.size, quality: input.quality, kind: input.kind },
      idempotency_key: input.idempotencyKey, created_by: req.userId, started_at: new Date().toISOString(),
    });
    if (jobError?.code === "23505") throw new AppError(409, "This image request was already submitted.");
    if (jobError?.code === "23514" && jobError.message === "image credit capacity exhausted") {
      throw new AppError(422, "Your image credits are used or reserved by pending requests. Check image history before generating again. No new image generation was started.", undefined, "image_credit_capacity_exhausted");
    }
    if (jobError?.code === "42501" && jobError.message === "image reservation requires editing access") {
      throw new AppError(403, "Your editing permission changed. No image generation was started.", undefined, "image_reservation_access_changed");
    }
    if (jobError) throw new AppError(500, "Could not start image generation.");

    let generated: Awaited<ReturnType<ImageGenerator>>;
    try {
      generated = await imageGenerator({ prompt: providerPrompt, size: input.size, quality: input.quality, ...(referenceImages.length ? { referenceImages } : {}) });
    } catch {
      await service.from("ai_jobs").update({ status: "failed", error_code: "image_provider_failed", error_message: "Image generation failed.", completed_at: new Date().toISOString() }).eq("id", jobId);
      throw new AppError(503, "Image generation failed. No credits were used.", undefined, "image_provider_failed");
    }
    if (!generated.bytes.length || generated.bytes.length > MAX_GENERATED_IMAGE_BYTES || generated.mimeType !== "image/png") {
      await service.from("ai_jobs").update({ status: "failed", error_code: "invalid_image_output", error_message: "Invalid image output.", completed_at: new Date().toISOString() }).eq("id", jobId);
      throw new AppError(503, "The image provider returned an invalid image. No credits were used.");
    }

    const assetId = randomUUID();
    const storagePath = `workspaces/${input.workspaceId}/assets/${assetId}/v1/generated.png`;
    const checksum = createHash("sha256").update(generated.bytes).digest("hex");
    const storage = service.storage.from(BUCKET);
    const uploaded = await storage.upload(storagePath, generated.bytes, { contentType: generated.mimeType, upsert: false });
    if (uploaded.error) {
      await service.from("ai_jobs").update({ status: "failed", error_code: "image_storage_failed", error_message: "Image storage failed.", completed_at: new Date().toISOString() }).eq("id", jobId);
      throw new AppError(503, "The generated image could not be stored. No credits were used.");
    }

    const completionArgs = {
      p_job_id: jobId, p_asset_id: assetId, p_asset_name: input.name,
      p_asset_type: input.kind === "front_cover" ? "cover" : "illustration",
      p_folder_id: input.folderId ?? null, p_storage_path: storagePath,
      p_mime_type: generated.mimeType, p_size_bytes: generated.bytes.length, p_checksum: checksum,
      p_link_role: input.kind, p_provider: generated.provider, p_model: generated.model, p_usage: generated.usage,
      };
    const receipt = await service.from("image_completion_receipts").insert({ job_id: jobId, completion_json: completionArgs });
    if (receipt.error) throw new AppError(503, "The generated file is stored, but recovery information could not be confirmed. Check image history before starting again.");
    let completionConfirmed = false;
    let completionRefusal: unknown;
    try {
      const completion = await service.rpc("complete_image_job", completionArgs);
      completionRefusal = completion.error;
      completionConfirmed = !completion.error;
    } catch {
      // Transport failure can occur after the atomic transaction commits.
    }
    if (!completionConfirmed) {
      try {
        const { data: savedJob, error: readError } = await service.from("ai_jobs").select("status,output_ref")
          .eq("id", jobId).maybeSingle();
        completionConfirmed = !readError && savedJob?.status === "succeeded" && savedJob.output_ref?.assetId === assetId;
      } catch {
        // Unknown state is not evidence that the transaction rolled back.
      }
      if (!completionConfirmed) {
        const refusal = imageCompletionError(completionRefusal);
        if (refusal) throw refusal;
        throw new AppError(503, "Image save confirmation is unavailable. Retry this same request or check your asset library before submitting a new generation.", undefined, "image_completion_unconfirmed");
      }
    }
    const { data: asset, error: assetError } = await service.from("assets").select("*").eq("id", assetId).single();
    const { data: signed, error: signError } = await storage.createSignedUrl(storagePath, 300);
    if (assetError || !asset || signError || !signed?.signedUrl) throw new AppError(503, "The generated image was saved, but its preview is temporarily unavailable.");
    reply.header("cache-control", "private, no-store");
    return reply.status(201).send({
      jobId, asset, preview: { url: signed.signedUrl, expiresIn: 300 }, provider: generated.provider,
      model: generated.model, requestId: generated.requestId,
    });
  });
  app.post("/assets/upload-url", async (req) => {
    const parsed = uploadUrlSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid upload request", { issues: parsed.error.issues });
    const { workspaceId, filename, mimeType, sizeBytes, folderId, type } = parsed.data;
    try {
      validateAssetUploadDeclaration(filename, mimeType);
    } catch (error) {
      if (error instanceof AssetInspectionError) throw new AppError(422, error.message);
      throw error;
    }
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceEditor(sb, workspaceId, req.userId);
    const assetId = randomUUID();
    const path = `workspaces/${workspaceId}/assets/${assetId}/v1/${safeFilename(filename)}`;

    const { data: asset, error } = await sb
      .from("assets")
      .insert({
        id: assetId,
        workspace_id: workspaceId,
        folder_id: folderId ?? null,
        type: type ?? "source_document",
        name: filename,
        storage_path: path,
        mime_type: mimeType,
        size_bytes: sizeBytes,
        checksum: "pending", // set by /confirm
        status: "draft",
        created_by: req.userId,
      })
      .select("id")
      .single();
    if (error || !asset) throw new AppError(500, error?.message ?? "asset insert failed");

    const { error: versionError } = await sb.from("asset_versions").insert({
      asset_id: asset.id,
      version_number: 1,
      storage_path: path,
      checksum: "pending",
      mime_type: mimeType,
      size_bytes: sizeBytes,
      scan_status: "pending",
      created_by: req.userId,
    });
    if (versionError) {
      await sb.from("assets").delete().eq("id", asset.id);
      throw new AppError(500, "asset version insert failed");
    }
    await logActivity(sb, { workspaceId, actorId: req.userId, eventType: "asset_created", entityType: "asset", entityId: asset.id, payload: { name: filename } });

    const { data: signed, error: signErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (signErr || !signed) throw new AppError(500, signErr?.message ?? "signed url failed");

    return { assetId: asset.id, uploadUrl: signed.signedUrl, path };
  });

  app.post("/assets/:assetId/confirm", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const parsed = confirmSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid confirm request", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const service = app.supabaseFactory();

    const { data: asset } = await sb.from("assets").select("workspace_id,name,size_bytes,checksum,storage_path").eq("id", assetId).maybeSingle();
    if (!asset) throw new AppError(404, "asset not found");
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);
    if (asset.checksum !== "pending") throw new AppError(409, "asset already confirmed");
    const { data: version, error: versionError } = await sb.from("asset_versions")
      .select("version_number,storage_path,checksum,mime_type,size_bytes,scan_status")
      .eq("asset_id", assetId).eq("version_number", 1).maybeSingle();
    if (versionError || !version) throw new AppError(409, "The pending upload version is unavailable.");
    if (!["pending", "error"].includes(String(version.scan_status ?? "pending")) || version.checksum !== "pending") {
      throw new AppError(409, "This upload already has a terminal scan verdict.");
    }
    const result = await inspectAndScan({
      user: sb, service, assetId, workspaceId: asset.workspace_id, filename: asset.name,
      version: version as PendingVersionRow, claimedChecksum: parsed.data.checksumSha256,
      claimedSize: parsed.data.sizeBytes,
    });
    return { assetId, status: "draft", scanStatus: "clean", detectedMimeType: result.detectedMimeType, confirmed: true };
  });

  // List live assets; filter by workspaceId (required), folderId/type/status.
  app.get("/assets", async (req) => {
    const q = req.query as { workspaceId?: string; folderId?: string; type?: string; status?: string };
    if (!q.workspaceId) throw new AppError(422, "workspaceId is required");
    const sb = app.supabaseFactory(req.userToken);
    await requireWorkspaceMember(sb, q.workspaceId, req.userId);
    let query = sb.from("assets").select("*").eq("workspace_id", q.workspaceId).is("deleted_at", null);
    if (q.folderId) query = query.eq("folder_id", q.folderId);
    if (q.type) query = query.eq("type", q.type);
    if (q.status) query = query.eq("status", q.status);
    const { data, error } = await query;
    if (error) throw new AppError(500, error.message);
    return { assets: data };
  });

  // New immutable version: returns a signed upload URL for v{n+1}; the row
  // keeps checksum "pending" until /confirm-version. Versions are never
  // updated after confirm (PRD 13: immutable versions w/ checksum).
  app.post("/assets/:assetId/versions", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const parsed = newVersionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid version request", { issues: parsed.error.issues });
    try {
      validateAssetUploadDeclaration(parsed.data.filename, parsed.data.mimeType);
    } catch (error) {
      if (error instanceof AssetInspectionError) throw new AppError(422, error.message);
      throw error;
    }
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);
    if (asset.deleted_at) throw new AppError(409, "asset is deleted");

    const { data: latest } = await sb
      .from("asset_versions")
      .select("version_number")
      .eq("asset_id", assetId)
      .order("version_number", { ascending: false })
      .limit(1)
      .maybeSingle();
    const next = (latest?.version_number ?? 0) + 1;
    const path = `workspaces/${asset.workspace_id}/assets/${assetId}/v${next}/${safeFilename(parsed.data.filename)}`;

    const { error } = await sb.from("asset_versions").insert({
      asset_id: assetId,
      version_number: next,
      storage_path: path,
      checksum: "pending",
      mime_type: parsed.data.mimeType,
      size_bytes: parsed.data.sizeBytes,
      scan_status: "pending",
      created_by: req.userId,
    });
    if (error) throw new AppError(422, error.message);
    const { data: signed, error: signErr } = await sb.storage.from(BUCKET).createSignedUploadUrl(path);
    if (signErr || !signed) throw new AppError(500, signErr?.message ?? "signed url failed");
    return { assetId, version: next, uploadUrl: signed.signedUrl, path };
  });

  // Confirm a pending version: sets its checksum and points the asset row at
  // it. Conditional update on checksum='pending' prevents double-confirm.
  app.post("/assets/:assetId/versions/:version/confirm", async (req) => {
    const { assetId, version } = req.params as { assetId: string; version: string };
    const parsed = confirmVersionSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid confirm request", { issues: parsed.error.issues });
    const versionNumber = Number(version);
    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) throw new AppError(422, "invalid asset version");
    const sb = app.supabaseFactory(req.userToken);
    const service = app.supabaseFactory();
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);

    const { data: v } = await sb
      .from("asset_versions")
      .select("version_number,storage_path,checksum,mime_type,size_bytes,scan_status")
      .eq("asset_id", assetId)
      .eq("version_number", versionNumber)
      .maybeSingle();
    if (!v) throw new AppError(404, "version not found");
    if (v.checksum !== "pending" || !["pending", "error"].includes(String(v.scan_status ?? "pending"))) {
      throw new AppError(409, "version already has a terminal scan verdict");
    }
    const filename = String(v.storage_path).split("/").pop() ?? "file";
    const result = await inspectAndScan({
      user: sb, service, assetId, workspaceId: asset.workspace_id, filename,
      version: v as PendingVersionRow, claimedChecksum: parsed.data.checksumSha256,
      claimedSize: parsed.data.sizeBytes,
    });
    await logActivity(sb, { workspaceId: asset.workspace_id, actorId: req.userId, eventType: "asset_replaced", entityType: "asset", entityId: assetId, payload: { version: v.version_number } });
    return { assetId, version: v.version_number, scanStatus: "clean", detectedMimeType: result.detectedMimeType, confirmed: true };
  });

  app.get("/assets/:assetId/versions", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceMember(sb, asset.workspace_id, req.userId);
    const { data, error } = await sb.from("asset_versions").select("*").eq("asset_id", assetId).order("version_number", { ascending: false });
    if (error) throw new AppError(500, error.message);
    return { versions: data };
  });

  app.get("/assets/:assetId/download-url", async (req, reply) => {
    const { assetId } = req.params as { assetId: string };
    const sb = app.supabaseFactory(req.userToken);
    const { data: asset, error } = await sb.from("assets").select("id,workspace_id,storage_path,checksum,deleted_at")
      .eq("id", assetId).maybeSingle();
    if (error) throw new AppError(500, "Could not load the asset.");
    if (!asset || asset.deleted_at) throw new AppError(404, "Asset not found.");
    await requireWorkspaceMember(sb, asset.workspace_id, req.userId);
    if (!asset.checksum || asset.checksum === "pending") throw new AppError(409, "Asset upload is not complete.");
    const { data: version, error: versionError } = await sb.from("asset_versions")
      .select("scan_status").eq("asset_id", asset.id).eq("storage_path", asset.storage_path).maybeSingle();
    if (versionError) throw new AppError(500, "Could not verify the asset scan status.");
    if (!version || !["clean", "trusted_generated"].includes(String(version.scan_status))) {
      throw new AppError(409, "Asset remains quarantined and cannot be downloaded.");
    }
    const { data: signed, error: signError } = await sb.storage.from(BUCKET).createSignedUrl(asset.storage_path, 300);
    if (signError || !signed?.signedUrl) throw new AppError(503, "A private download link could not be created.");
    reply.header("cache-control", "private, no-store");
    return { url: signed.signedUrl, expiresIn: 300 };
  });

  // Rename/move/status change on the asset row.
  app.patch("/assets/:assetId", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid asset update", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);
    if (asset.deleted_at) throw new AppError(409, "asset is deleted");

    const update: Record<string, unknown> = {};
    if (parsed.data.name !== undefined) update.name = parsed.data.name;
    if (parsed.data.folderId !== undefined) update.folder_id = parsed.data.folderId;
    if (parsed.data.status !== undefined) update.status = parsed.data.status;
    const { data, error } = await sb.from("assets").update(update).eq("id", assetId).select().single();
    if (error) throw new AppError(422, error.message);
    await logActivity(sb, {
      workspaceId: asset.workspace_id,
      actorId: req.userId,
      eventType: parsed.data.status ? "asset_status_changed" : parsed.data.folderId !== undefined ? "asset_moved" : "asset_renamed",
      entityType: "asset",
      entityId: assetId,
      payload: update,
    });
    return data;
  });

  // Soft delete: status archived + deleted_at marker; row stays for audit.
  app.delete("/assets/:assetId", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);
    if (asset.deleted_at) throw new AppError(409, "asset already deleted");
    const { error } = await sb.from("assets").update({ deleted_at: new Date().toISOString(), status: "archived" }).eq("id", assetId);
    if (error) throw new AppError(500, error.message);
    await logActivity(sb, { workspaceId: asset.workspace_id, actorId: req.userId, eventType: "asset_deleted", entityType: "asset", entityId: assetId });
    return { assetId, deleted: true };
  });

  app.post("/assets/:assetId/restore", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceEditor(sb, asset.workspace_id, req.userId);
    if (!asset.deleted_at) throw new AppError(409, "asset is not deleted");
    const { error } = await sb.from("assets").update({ deleted_at: null, status: "draft" }).eq("id", assetId);
    if (error) throw new AppError(500, error.message);
    await logActivity(sb, { workspaceId: asset.workspace_id, actorId: req.userId, eventType: "asset_restored", entityType: "asset", entityId: assetId });
    return { assetId, restored: true };
  });

  // Usage: where this asset is referenced (chapters, nodes, covers...).
  app.get("/assets/:assetId/usage", async (req) => {
    const { assetId } = req.params as { assetId: string };
    const sb = app.supabaseFactory(req.userToken);
    const asset = await loadAsset(sb, assetId);
    await requireWorkspaceMember(sb, asset.workspace_id, req.userId);
    const { data, error } = await sb.from("asset_links").select("*").eq("asset_id", assetId);
    if (error) throw new AppError(500, error.message);
    return { links: data };
  });
}
