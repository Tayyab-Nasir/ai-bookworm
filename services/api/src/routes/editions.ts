import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { assembleBookModel, bookModelFingerprint, loadBook } from "../lib/authoring.js";
import { logActivity } from "../lib/activity.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { requireEntitlement } from "../lib/entitlements.js";

const BUCKET = "book-assets";

const httpsUrl = z.string().trim().url().max(2_048).refine((value) => new URL(value).protocol === "https:", "QR destination must use HTTPS.");
const qrSchema = z.object({
  enabled: z.boolean().default(false),
  url: httpsUrl.nullable().default(null),
  label: z.string().trim().max(120).nullable().default(null),
  position: z.enum(["bottom-left", "bottom-right"]).default("bottom-right"),
  size_px: z.number().int().min(96).max(512).default(180),
}).strict().superRefine((value, ctx) => {
  if (value.enabled && !value.url) ctx.addIssue({ code: "custom", path: ["url"], message: "Add an HTTPS destination when QR is enabled." });
});

const coverSchema = z.object({
  asset_id: z.string().uuid().nullable().default(null),
  title_on_cover: z.boolean().default(true),
  subtitle_on_cover: z.boolean().default(true),
  author_on_cover: z.boolean().default(true),
  text_color: z.string().regex(/^#[0-9a-f]{6}$/i).default("#ffffff"),
  overlay_opacity: z.number().min(0).max(0.9).default(0.28),
  qr_code: qrSchema.default({}),
}).strict().superRefine((value, ctx) => {
  if (value.qr_code.enabled && !value.asset_id) ctx.addIssue({ code: "custom", path: ["asset_id"], message: "Choose cover art before enabling QR." });
}).default({});

const ebookSchema = z.object({
  kind: z.literal("ebook"),
  schema_version: z.enum(["1.0.0", "1.1.0"]).default("1.1.0"),
  text_direction: z.enum(["auto", "ltr", "rtl"]).default("auto"),
  flow: z.enum(["reflowable", "fixed"]).default("reflowable"),
  navigation: z.enum(["toc", "toc+landmarks", "none"]).default("toc"),
  cover: coverSchema,
  metadata_overrides: z.record(z.string().max(2_000)).default({}),
  image_policy: z.object({
    max_width_px: z.number().int().min(320).max(6_000).default(1_600),
    max_bytes: z.number().int().min(100_000).max(25 * 1024 * 1024).default(5 * 1024 * 1024),
    embed: z.boolean().default(true),
    allowed_formats: z.array(z.enum(["jpeg", "png", "gif", "webp"])).min(1).max(4).default(["jpeg", "png", "gif"]),
  }).strict().default({}),
}).strict();

const marginsSchema = z.object({
  top: z.number().min(0.25).max(2).default(0.75),
  bottom: z.number().min(0.25).max(2).default(0.75),
  inner: z.number().min(0.25).max(2).default(0.75),
  outer: z.number().min(0.25).max(2).default(0.5),
}).strict().default({});

const fontSchema = z.enum(["Times-Roman", "Times-Bold", "Helvetica", "Helvetica-Bold", "Courier", "Courier-Bold"]);
const typographySchema = z.object({
  body_font: fontSchema.default("Times-Roman"),
  body_size_pt: z.number().min(7).max(24).default(11),
  heading_font: fontSchema.default("Helvetica-Bold"),
  heading_size_pt: z.number().min(10).max(48).default(16),
  leading: z.number().min(8).max(36).default(14),
  paragraph_spacing_pt: z.number().min(0).max(36).default(6),
  first_line_indent_in: z.number().min(0).max(1).default(0.25),
  text_align: z.enum(["left", "justify"]).default("justify"),
}).strict().superRefine((value, ctx) => {
  if (value.leading < value.body_size_pt) ctx.addIssue({ code: "custom", path: ["leading"], message: "Line spacing must be at least the body font size." });
}).default({});

const printSchema = z.object({
  kind: z.literal("print"),
  schema_version: z.enum(["1.0.0", "1.1.0"]).default("1.1.0"),
  text_direction: z.enum(["auto", "ltr", "rtl"]).default("auto"),
  trim_size: z.enum(["5x8", "5.5x8.5", "6x9", "7x10", "8.5x11"]).default("6x9"),
  bleed_in: z.number().min(0).max(0.25).default(0),
  margins: marginsSchema,
  typography: typographySchema,
  page_numbering: z.object({
    style: z.enum(["arabic", "roman", "none"]).default("arabic"),
    start_at: z.number().int().min(1).max(10_000).default(1),
    position: z.enum(["bottom-center", "bottom-outer", "top-center"]).default("bottom-center"),
  }).strict().default({}),
  cover: coverSchema,
}).strict();

export const editionConfigSchema = z.discriminatedUnion("kind", [ebookSchema, printSchema]);

export function withEditionLanguage<T extends { metadata: { language: string } }>(model: T, language: unknown): T {
  const editionLanguage = typeof language === "string" ? language.trim() : "";
  if (editionLanguage.length < 2 || editionLanguage.length > 35) return model;
  return { ...model, metadata: { ...model.metadata, language: editionLanguage } };
}

const createSchema = z.object({
  config: editionConfigSchema,
  language: z.string().trim().min(2).max(35).default("en"),
}).strict();

const updateSchema = z.object({
  config: editionConfigSchema.optional(),
  language: z.string().trim().min(2).max(35).optional(),
  status: z.enum(["draft", "in_review", "approved", "archived"]).optional(),
  expectedUpdatedAt: z.string().datetime(),
}).strict().refine((value) => value.config || value.language || value.status, "nothing to update");

const renderSchema = z.object({ idempotencyKey: z.string().trim().min(8).max(200) }).strict();
export const renderResponseSchema = z.object({
  format: z.enum(["epub", "pdf"]),
  artifactBase64: z.string().min(4).max(210_000_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/i),
  rendererVersion: z.string().min(1).max(200),
  coverArtifactBase64: z.string().min(4).max(40_000_000).nullable().optional(),
  coverSha256: z.string().regex(/^[a-f0-9]{64}$/i).nullable().optional(),
  coverRendererVersion: z.string().min(1).max(200).nullable().optional(),
}).strict();

export function decodeArtifact(encoded: string, checksum: string, maxBytes: number, signature: Buffer, label: string) {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new AppError(503, `The renderer returned invalid ${label} data.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > maxBytes || !bytes.subarray(0, signature.length).equals(signature)) {
    throw new AppError(503, `The renderer returned an invalid ${label}.`);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== checksum.toLowerCase()) {
    throw new AppError(503, `The renderer returned a ${label} with the wrong checksum.`);
  }
  return bytes;
}

async function failRenderJob(sb: SupabaseClient, jobId: string, message: string) {
  await sb.from("publishing_jobs").update({
    status: "failed", response_json: { error: message.slice(0, 500) }, completed_at: new Date().toISOString(),
  }).eq("id", jobId).in("status", ["queued", "running"]);
}

async function hydrateRenderResult(sb: SupabaseClient, job: Record<string, unknown>) {
  const response = job.response_json as { artifacts?: { assetId?: unknown; role?: unknown }[] } | null;
  const descriptors = Array.isArray(response?.artifacts) ? response.artifacts : [];
  const artifacts = [];
  for (const descriptor of descriptors) {
    if (typeof descriptor.assetId !== "string") continue;
    const { data: asset } = await sb.from("assets").select("*").eq("id", descriptor.assetId).maybeSingle();
    if (!asset) continue;
    const { data: signed, error } = await sb.storage.from(BUCKET).createSignedUrl(asset.storage_path, 300);
    if (error || !signed?.signedUrl) throw new AppError(503, "A rendered artifact link could not be created.");
    artifacts.push({ asset, role: descriptor.role, download: { url: signed.signedUrl, expiresIn: 300 } });
  }
  if (!artifacts.length) throw new AppError(500, "The render job has no stored artifacts.");
  return { jobId: job.id, status: job.status, artifacts };
}

export async function loadRenderImages(
  sb: SupabaseClient,
  workspaceId: string,
  illustrationIds: string[],
  coverId: string | null,
) {
  const ids = [...new Set([...illustrationIds, ...(coverId ? [coverId] : [])])];
  if (ids.length > 100) throw new AppError(422, "A render can include at most 100 images.");
  if (!ids.length) return { coverBase64: null, assetImagesBase64: {} as Record<string, string> };

  const { data, error } = await sb.from("assets")
    .select("id,workspace_id,storage_path,mime_type,size_bytes,checksum,status,deleted_at")
    .eq("workspace_id", workspaceId).is("deleted_at", null).in("id", ids);
  if (error || !data || data.length !== ids.length) {
    throw new AppError(422, "A book image is missing or belongs to another workspace.");
  }

  let totalBytes = 0;
  const encoded = new Map<string, string>();
  for (const asset of data) {
    if (!String(asset.mime_type).startsWith("image/") || asset.checksum === "pending") {
      throw new AppError(422, "All render images must be confirmed image assets.");
    }
    const expectedSize = Number(asset.size_bytes);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 25 * 1024 * 1024) {
      throw new AppError(422, "A render image exceeds the 25 MB limit.");
    }
    totalBytes += expectedSize;
    if (totalBytes > 100 * 1024 * 1024) throw new AppError(422, "Render images exceed the 100 MB total limit.");
    const { data: stored, error: downloadError } = await sb.storage.from(BUCKET).download(asset.storage_path);
    if (downloadError || !stored) throw new AppError(503, "A render image could not be loaded from private storage.");
    const bytes = Buffer.from(await stored.arrayBuffer());
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (bytes.length !== expectedSize || checksum !== String(asset.checksum).toLowerCase()) {
      throw new AppError(422, "A render image no longer matches its confirmed version.");
    }
    encoded.set(asset.id, bytes.toString("base64"));
  }

  return {
    coverBase64: coverId ? encoded.get(coverId) ?? null : null,
    assetImagesBase64: Object.fromEntries(illustrationIds.map((id) => [id, encoded.get(id)!])),
  };
}

async function loadEdition(sb: SupabaseClient, editionId: string) {
  const { data, error } = await sb.from("editions").select("*").eq("id", editionId).maybeSingle();
  if (error) throw new AppError(500, "Could not load edition.");
  if (!data) throw new AppError(404, "Edition not found.");
  return data;
}

async function validateCover(sb: SupabaseClient, workspaceId: string, config: z.infer<typeof editionConfigSchema>) {
  const assetId = config.cover.asset_id;
  if (!assetId) return;
  const { data, error } = await sb.from("assets").select("id,mime_type,checksum,status,deleted_at")
    .eq("id", assetId).eq("workspace_id", workspaceId).maybeSingle();
  if (error || !data || data.deleted_at || data.checksum === "pending" || !String(data.mime_type).startsWith("image/")) {
    throw new AppError(422, "Choose a confirmed image from this workspace for the cover.");
  }
}

export function editionRoutes(app: FastifyInstance, options: { fetcher?: typeof fetch } = {}) {
  const fetcher = options.fetcher ?? fetch;
  app.get("/books/:bookId/editions", async (req) => {
    const { bookId } = req.params as { bookId: string };
    const sb = app.supabaseFactory(req.userToken);
    await loadBook(sb, bookId, req.userId);
    const { data, error } = await sb.from("editions").select("*").eq("book_id", bookId).order("created_at", { ascending: false });
    if (error) throw new AppError(500, "Could not load editions.");
    return { editions: data ?? [] };
  });

  app.post("/books/:bookId/editions", async (req, reply) => {
    const { bookId } = req.params as { bookId: string };
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Check the edition settings.", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(sb, bookId, req.userId, true);
    await validateCover(sb, book.workspace_id, parsed.data.config);
    const { data, error } = await sb.from("editions").insert({
      book_id: bookId,
      type: parsed.data.config.kind,
      trim_size: parsed.data.config.kind === "print" ? parsed.data.config.trim_size : null,
      language: parsed.data.language,
      edition_metadata_json: parsed.data.config,
      status: "draft",
    }).select("*").single();
    if (error || !data) throw new AppError(500, "Could not create edition.");
    await logActivity(sb, { workspaceId: book.workspace_id, actorId: req.userId, eventType: "edition_created", entityType: "edition", entityId: data.id, payload: { type: data.type } });
    return reply.status(201).send(data);
  });

  app.get("/editions/:editionId", async (req) => {
    const { editionId } = req.params as { editionId: string };
    const sb = app.supabaseFactory(req.userToken);
    const edition = await loadEdition(sb, editionId);
    await loadBook(sb, edition.book_id, req.userId);
    return edition;
  });

  app.patch("/editions/:editionId", async (req) => {
    const { editionId } = req.params as { editionId: string };
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Check the edition settings.", { issues: parsed.error.issues });
    const sb = app.supabaseFactory(req.userToken);
    const edition = await loadEdition(sb, editionId);
    const { book } = await loadBook(sb, edition.book_id, req.userId, true);
    if (parsed.data.config) await validateCover(sb, book.workspace_id, parsed.data.config);
    const update: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (parsed.data.config) {
      update.type = parsed.data.config.kind;
      update.trim_size = parsed.data.config.kind === "print" ? parsed.data.config.trim_size : null;
      update.edition_metadata_json = parsed.data.config;
    }
    if (parsed.data.language) update.language = parsed.data.language;
    if (parsed.data.status) update.status = parsed.data.status;
    const { data, error } = await sb.from("editions").update(update).eq("id", editionId)
      .eq("updated_at", parsed.data.expectedUpdatedAt).select("*").maybeSingle();
    if (error) throw new AppError(500, "Could not update edition.");
    if (!data) throw new AppError(409, "This edition changed. Reload before saving.");
    await logActivity(sb, { workspaceId: book.workspace_id, actorId: req.userId, eventType: "edition_updated", entityType: "edition", entityId: editionId, payload: { status: data.status, type: data.type } });
    return data;
  });

  app.post("/editions/:editionId/render", async (req, reply) => {
    const { editionId } = req.params as { editionId: string };
    const parsed = renderSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Add a valid render request key.", { issues: parsed.error.issues });

    const user = app.supabaseFactory(req.userToken);
    const edition = await loadEdition(user, editionId);
    const { book } = await loadBook(user, edition.book_id, req.userId, true);
    const configResult = editionConfigSchema.safeParse(edition.edition_metadata_json);
    if (!configResult.success || configResult.data.kind !== edition.type) {
      throw new AppError(422, "This edition has invalid settings. Save the edition before rendering.");
    }
    const config = configResult.data;
    const service = app.supabaseFactory();
    const { data: workspace, error: workspaceError } = await service.from("workspaces")
      .select("organization_id").eq("id", book.workspace_id).maybeSingle();
    if (workspaceError || !workspace) throw new AppError(404, "workspace not found");
    const entitlement = await requireEntitlement(service, workspace.organization_id, "rendering");
    if (entitlement.entitlements.rendering !== true) {
      throw new AppError(422, "Your current plan does not include book rendering.", undefined, "rendering_not_in_plan");
    }

    const model = withEditionLanguage(await assembleBookModel(user, book), edition.language);
    const modelSha256 = bookModelFingerprint(model);
    const images = await loadRenderImages(
      service,
      book.workspace_id,
      model.assets.map((asset) => asset.id),
      config.cover.asset_id,
    );
    const jobId = randomUUID();
    const { data: inserted, error: insertError } = await service.from("publishing_jobs").insert({
      id: jobId,
      book_id: book.id,
      edition_id: editionId,
      channel: "render",
      status: "running",
      request_json: { action: "render", editionUpdatedAt: edition.updated_at, bookModelSha256: modelSha256 },
      idempotency_key: parsed.data.idempotencyKey,
      created_by: req.userId,
      started_at: new Date().toISOString(),
    }).select("*").single();

    if (insertError?.code === "23505") {
      const { data: existing } = await service.from("publishing_jobs").select("*")
        .eq("idempotency_key", parsed.data.idempotencyKey).eq("book_id", book.id)
        .eq("created_by", req.userId).maybeSingle();
      if (!existing) throw new AppError(409, "That render request key is already in use.");
      const request = existing.request_json && typeof existing.request_json === "object" && !Array.isArray(existing.request_json)
        ? existing.request_json as Record<string, unknown> : {};
      if (request.action !== "render" || existing.edition_id !== editionId
        || request.editionUpdatedAt !== edition.updated_at || request.bookModelSha256 !== modelSha256) {
        throw new AppError(409, "That render request key belongs to different saved book content or edition settings.");
      }
      if (existing.status !== "succeeded") throw new AppError(409, `That render request is already ${existing.status}.`);
      reply.header("cache-control", "private, no-store");
      return reply.status(200).send(await hydrateRenderResult(service, existing));
    }
    if (insertError || !inserted) throw new AppError(500, "Could not create the render job.");

    const uploadedPaths: string[] = [];
    let completionPersisted = false;
    try {
      const baseUrl = (process.env.RENDERING_SERVICE_URL
        ?? `http://127.0.0.1:${process.env.RENDERING_SERVICE_PORT ?? "8002"}`).replace(/\/$/u, "");
      const response = await fetcher(`${baseUrl}/render`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.RENDERING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN
            ? { "x-service-token": process.env.RENDERING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN! }
            : {}),
        },
        body: JSON.stringify({ editionConfig: config, bookModel: model, ...images }),
        redirect: "error",
        signal: AbortSignal.timeout(150_000),
      });
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > 220_000_000) {
        throw new AppError(503, "The renderer response exceeded the supported size.");
      }
      const responseText = await response.text();
      if (response.status === 422) {
        throw new AppError(422, "This saved edition needs a supported typography configuration. Run preflight to review the required changes.");
      }
      if (!response.ok) throw new AppError(503, "The renderer could not complete this edition.");
      if (responseText.length > 220_000_000) throw new AppError(503, "The renderer response exceeded the supported size.");
      let raw: unknown;
      try { raw = JSON.parse(responseText); } catch { throw new AppError(503, "The renderer returned an invalid response."); }
      const renderedResult = renderResponseSchema.safeParse(raw);
      if (!renderedResult.success) throw new AppError(503, "The renderer returned an invalid response.");
      const rendered = renderedResult.data;
      const expectedFormat = config.kind === "ebook" ? "epub" : "pdf";
      if (rendered.format !== expectedFormat) throw new AppError(503, "The renderer returned the wrong edition format.");

      const primary = decodeArtifact(
        rendered.artifactBase64,
        rendered.sha256,
        150 * 1024 * 1024,
        expectedFormat === "epub" ? Buffer.from("PK") : Buffer.from("%PDF-"),
        expectedFormat.toUpperCase(),
      );
      const artifacts: Record<string, unknown>[] = [];
      const primaryId = randomUUID();
      const primaryFilename = `book.${expectedFormat}`;
      const primaryPath = `workspaces/${book.workspace_id}/assets/${primaryId}/v1/${primaryFilename}`;
      artifacts.push({
        assetId: primaryId,
        storagePath: primaryPath,
        filename: primaryFilename,
        type: "rendered_book",
        role: config.kind === "ebook" ? "rendered_ebook" : "rendered_print",
        name: `${String(book.title).slice(0, 240)}.${expectedFormat}`,
        mimeType: expectedFormat === "epub" ? "application/epub+zip" : "application/pdf",
        sizeBytes: primary.length,
        checksum: rendered.sha256.toLowerCase(),
      });
      if (Boolean(rendered.coverArtifactBase64) !== Boolean(rendered.coverSha256)) {
        throw new AppError(503, "The renderer returned incomplete cover output.");
      }
      if (rendered.coverArtifactBase64 && rendered.coverSha256) {
        const cover = decodeArtifact(rendered.coverArtifactBase64, rendered.coverSha256, 25 * 1024 * 1024, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "cover PNG");
        const coverId = randomUUID();
        const coverPath = `workspaces/${book.workspace_id}/assets/${coverId}/v1/cover.png`;
        artifacts.push({
          assetId: coverId, storagePath: coverPath, filename: "cover.png", type: "rendered_cover",
          role: "rendered_cover", name: `${String(book.title).slice(0, 238)} cover`, mimeType: "image/png",
          sizeBytes: cover.length, checksum: rendered.coverSha256.toLowerCase(),
        });
        (artifacts[1] as Record<string, unknown>).bytes = cover;
      }
      artifacts[0].bytes = primary;

      for (const artifact of artifacts) {
        const bytes = artifact.bytes as Buffer;
        const { error: uploadError } = await service.storage.from(BUCKET).upload(String(artifact.storagePath), bytes, {
          contentType: String(artifact.mimeType), upsert: false,
        });
        if (uploadError) throw new AppError(503, "A rendered artifact could not be stored.");
        uploadedPaths.push(String(artifact.storagePath));
        delete artifact.bytes;
      }

      const usage = {
        renderedBytes: artifacts.reduce((sum, artifact) => sum + Number(artifact.sizeBytes), 0),
        illustrationCount: model.assets.length,
      };
      const { data: completed, error: completeError } = await service.rpc("complete_render_job", {
        p_job_id: jobId,
        p_artifacts: artifacts,
        p_renderer_version: rendered.rendererVersion,
        p_usage: usage,
      });
      let completedJob = Array.isArray(completed) ? completed[0] : completed;
      if (completeError || !completedJob) {
        const { data: recovered } = await service.from("publishing_jobs").select("*").eq("id", jobId).maybeSingle();
        if (recovered?.status === "succeeded") completedJob = recovered;
        else {
          await service.storage.from(BUCKET).remove(uploadedPaths);
          await failRenderJob(service, jobId, "render_persistence_failed");
          if (completeError?.code === "PGRST202" || completeError?.code === "42883") {
            throw new AppError(503, "The render workflow migration is not installed. Nothing was charged.");
          }
          throw new AppError(500, "Could not persist the rendered edition. Nothing was charged.");
        }
      }

      completionPersisted = true;
      reply.header("cache-control", "private, no-store");
      return reply.status(201).send(await hydrateRenderResult(service, completedJob));
    } catch (error) {
      if (!completionPersisted) {
        if (uploadedPaths.length) await service.storage.from(BUCKET).remove(uploadedPaths);
        await failRenderJob(service, jobId, "render_failed");
      }
      if (error instanceof AppError) throw error;
      throw new AppError(503, "The renderer could not complete this edition. Nothing was saved or charged.");
    }
  });
}
