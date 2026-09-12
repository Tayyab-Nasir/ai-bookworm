import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppError } from "../errors.js";
import { assembleBookModel, bookModelFingerprint, loadBook } from "../lib/authoring.js";
import { requireEntitlement } from "../lib/entitlements.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { editionConfigSchema, loadRenderImages, withEditionLanguage } from "./editions.js";

const channelSchema = z.enum(["export", "kdp", "apple", "barnesnoble", "lulu"]);
const retailerChannelSchema = z.enum(["kdp", "apple", "barnesnoble", "lulu"]);
const preflightSchema = z.object({
  bookId: z.string().uuid(),
  editionId: z.string().uuid(),
  channel: channelSchema.default("export"),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

const findingSchema = z.object({
  code: z.string().min(1).max(120),
  message: z.string().min(1).max(2_000),
  location: z.string().max(1_000),
  severity: z.enum(["error", "warning", "info"]),
  category: z.enum(["package_integrity", "epub_structure", "navigation", "metadata", "images", "fonts", "accessibility", "links", "language", "channel"]),
  rule_id: z.string().min(1).max(200),
  rule_version: z.string().min(1).max(200),
}).strict();

export const preflightResponseSchema = z.object({
  ruleVersion: z.string().min(1).max(200),
  channel: z.string().max(80).nullable(),
  errors: z.number().int().min(0).max(10_000),
  warnings: z.number().int().min(0).max(10_000),
  findings: z.array(findingSchema).max(500),
}).strict();

export const storedPreflightResponseSchema = preflightResponseSchema.extend({
  requestedChannel: channelSchema,
}).strict();

const packageRequestSchema = z.object({
  bookId: z.string().uuid(),
  editionId: z.string().uuid(),
  channel: retailerChannelSchema,
  renderJobId: z.string().uuid(),
  preflightJobId: z.string().uuid(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

const listPackageJobsSchema = z.object({
  bookId: z.string().uuid(),
  editionId: z.string().uuid().optional(),
  channel: retailerChannelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
}).strict();

const renderArtifactSchema = z.object({
  assetId: z.string().uuid(),
  storagePath: z.string().min(1).max(1_000),
  filename: z.string().min(1).max(128),
  type: z.enum(["rendered_book", "rendered_cover"]),
  role: z.enum(["rendered_ebook", "rendered_print", "rendered_cover"]),
  name: z.string().min(1).max(256),
  mimeType: z.enum(["application/epub+zip", "application/pdf", "image/png"]),
  sizeBytes: z.number().int().min(1).max(157_286_400),
  checksum: z.string().regex(/^[a-f0-9]{64}$/i),
}).strict();

const renderJobResponseSchema = z.object({
  artifacts: z.array(renderArtifactSchema).min(1).max(2),
  rendererVersion: z.string().min(1).max(200),
  usage: z.record(z.unknown()),
}).strict();

export const packageServiceResponseSchema = z.object({
  channel: retailerChannelSchema,
  ruleVersion: z.string().min(1).max(200),
  errors: z.literal(0),
  packages: z.array(z.object({
    path: z.string().regex(/^[a-z]+-export\.zip$/u).max(128),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i),
    dataBase64: z.string().min(4).max(280_000_000),
  }).strict()).length(1),
}).strict();

const CHANNEL_ENTITLEMENT: Record<z.infer<typeof retailerChannelSchema>, string> = {
  kdp: "kdp", apple: "apple_books", barnesnoble: "barnes_noble", lulu: "lulu",
};
const CHANNEL_FORMATS: Record<z.infer<typeof retailerChannelSchema>, ("ebook" | "print")[]> = {
  kdp: ["ebook", "print"], apple: ["ebook"], barnesnoble: ["ebook", "print"], lulu: ["print"],
};

const BUCKET = "book-assets";

async function failPreflightJob(sb: ReturnType<FastifyInstance["supabaseFactory"]>, jobId: string) {
  await sb.from("publishing_jobs").update({
    status: "failed", response_json: { error: "preflight_failed" }, completed_at: new Date().toISOString(),
  }).eq("id", jobId).in("status", ["queued", "running"]);
}

async function failPackageJob(sb: SupabaseClient, jobId: string, message: string) {
  await sb.from("publishing_jobs").update({
    status: "failed", response_json: { error: message.slice(0, 500) }, completed_at: new Date().toISOString(),
  }).eq("id", jobId).in("status", ["queued", "running"]);
}

function requestJson(job: Record<string, unknown>) {
  return job.request_json && typeof job.request_json === "object" && !Array.isArray(job.request_json)
    ? job.request_json as Record<string, unknown>
    : {};
}

export function assertSourceJob(
  job: Record<string, unknown> | null,
  expected: { action: "render" | "validate"; bookId: string; editionId: string; channel: string; editionUpdatedAt: string; bookModelSha256: string },
) {
  const request = job ? requestJson(job) : {};
  if (!job || job.status !== "succeeded" || job.book_id !== expected.bookId || job.edition_id !== expected.editionId
    || job.channel !== expected.channel || request.action !== expected.action
    || request.editionUpdatedAt !== expected.editionUpdatedAt || request.bookModelSha256 !== expected.bookModelSha256) {
    throw new AppError(422, `Run a fresh successful ${expected.action === "render" ? "render" : "preflight"} for these saved edition settings.`);
  }
}

export async function loadRenderedPackageInputs(
  sb: SupabaseClient,
  workspaceId: string,
  kind: "ebook" | "print",
  renderJob: Record<string, unknown>,
) {
  const response = renderJobResponseSchema.safeParse(renderJob.response_json);
  if (!response.success) throw new AppError(422, "The selected render has no valid stored artifacts. Render this edition again.");
  const primaryRole = kind === "ebook" ? "rendered_ebook" : "rendered_print";
  const primaryMime = kind === "ebook" ? "application/epub+zip" : "application/pdf";
  const primaryName = kind === "ebook" ? "book.epub" : "book.pdf";
  const primary = response.data.artifacts.filter((artifact) => artifact.role === primaryRole);
  const covers = response.data.artifacts.filter((artifact) => artifact.role === "rendered_cover");
  if (primary.length !== 1 || covers.length > 1 || response.data.artifacts.some((artifact) => ![primaryRole, "rendered_cover"].includes(artifact.role))) {
    throw new AppError(422, "The selected render artifacts do not match this edition. Render it again.");
  }
  if (primary[0].mimeType !== primaryMime || primary[0].filename !== primaryName) {
    throw new AppError(422, "The selected render format does not match this edition.");
  }

  const descriptors = [...primary, ...covers];
  const ids = descriptors.map((artifact) => artifact.assetId);
  const { data: assets, error } = await sb.from("assets")
    .select("*").eq("workspace_id", workspaceId).is("deleted_at", null).in("id", ids);
  if (error || !assets || assets.length !== ids.length) {
    throw new AppError(422, "A selected render artifact is missing from private storage.");
  }

  const encoded: Record<string, string> = {};
  let total = 0;
  for (const descriptor of descriptors) {
    const asset = assets.find((candidate) => candidate.id === descriptor.assetId);
    if (!asset || asset.storage_path !== descriptor.storagePath || asset.mime_type !== descriptor.mimeType
      || Number(asset.size_bytes) !== descriptor.sizeBytes
      || String(asset.checksum).toLowerCase() !== descriptor.checksum.toLowerCase()) {
      throw new AppError(422, "A selected render artifact no longer matches its confirmed version.");
    }
    const { data: stored, error: downloadError } = await sb.storage.from(BUCKET).download(asset.storage_path);
    if (downloadError || !stored) throw new AppError(503, "A selected render artifact could not be loaded from private storage.");
    const bytes = Buffer.from(await stored.arrayBuffer());
    total += bytes.length;
    if (total > 175 * 1024 * 1024 || bytes.length !== descriptor.sizeBytes
      || createHash("sha256").update(bytes).digest("hex") !== descriptor.checksum.toLowerCase()) {
      throw new AppError(422, "A selected render artifact failed its integrity check.");
    }
    const signature = descriptor.role === "rendered_ebook" ? Buffer.from("PK")
      : descriptor.role === "rendered_print" ? Buffer.from("%PDF-") : Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    if (!bytes.subarray(0, signature.length).equals(signature)) {
      throw new AppError(422, "A selected render artifact has the wrong file format.");
    }
    encoded[descriptor.role === "rendered_cover" ? "cover.png" : primaryName] = bytes.toString("base64");
  }
  return encoded;
}

export function decodePackage(encoded: string, checksum: string) {
  if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(encoded)) {
    throw new AppError(503, "The publishing service returned invalid package data.");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length || bytes.length > 200 * 1024 * 1024 || !bytes.subarray(0, 2).equals(Buffer.from("PK"))) {
    throw new AppError(503, "The publishing service returned an invalid ZIP package.");
  }
  if (createHash("sha256").update(bytes).digest("hex") !== checksum.toLowerCase()) {
    throw new AppError(503, "The publishing service returned a package with the wrong checksum.");
  }
  return bytes;
}

async function hydratePackageJob(sb: SupabaseClient, job: Record<string, unknown>) {
  const response = job.response_json && typeof job.response_json === "object" && !Array.isArray(job.response_json)
    ? job.response_json as Record<string, unknown>
    : {};
  let packageArtifact = null;
  const descriptor = response.artifact && typeof response.artifact === "object" && !Array.isArray(response.artifact)
    ? response.artifact as Record<string, unknown>
    : null;
  if (job.status === "succeeded" && typeof descriptor?.assetId === "string") {
    const { data: asset, error } = await sb.from("assets").select("*").eq("id", descriptor.assetId).maybeSingle();
    if (error || !asset) throw new AppError(500, "The publishing package record is incomplete.");
    const { data: signed, error: signError } = await sb.storage.from(BUCKET).createSignedUrl(asset.storage_path, 300);
    if (signError || !signed?.signedUrl) throw new AppError(503, "A private package download link could not be created.");
    packageArtifact = { asset, download: { url: signed.signedUrl, expiresIn: 300 } };
  }
  const request = requestJson(job);
  return {
    id: job.id, bookId: job.book_id, editionId: job.edition_id, channel: job.channel, status: job.status,
    createdAt: job.created_at, startedAt: job.started_at, completedAt: job.completed_at,
    sourceRenderJobId: request.sourceRenderJobId ?? response.sourceRenderJobId ?? null,
    sourcePreflightJobId: request.sourcePreflightJobId ?? response.sourcePreflightJobId ?? null,
    ruleVersion: response.ruleVersion ?? null,
    failureCode: job.status === "failed" && typeof response.error === "string" ? response.error : null,
    submissionMode: "manual", package: packageArtifact,
  };
}

export function publishingRoutes(app: FastifyInstance, options: { renderFetcher?: typeof fetch; publishingFetcher?: typeof fetch } = {}) {
  const renderFetcher = options.renderFetcher ?? fetch;
  const publishingFetcher = options.publishingFetcher ?? fetch;

  app.post("/publishing/validate", async (req, reply) => {
    const parsed = preflightSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Check the preflight request.", { issues: parsed.error.issues });
    const body = parsed.data;
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, body.bookId, req.userId, true);
    const { data: edition, error: editionError } = await user.from("editions").select("*")
      .eq("id", body.editionId).eq("book_id", body.bookId).maybeSingle();
    if (editionError) throw new AppError(500, "Could not load the edition for validation.");
    if (!edition) throw new AppError(404, "Edition not found for this book.");
    const configResult = editionConfigSchema.safeParse(edition.edition_metadata_json);
    if (!configResult.success || configResult.data.kind !== edition.type) {
      throw new AppError(422, "This edition has invalid settings. Save the edition before validation.");
    }
    const config = configResult.data;
    if (config.kind === "audiobook") {
      throw new AppError(422, "Audiobook editions use the narration workflow, not EPUB/PDF preflight.");
    }
    if (body.channel !== "export" && !CHANNEL_FORMATS[body.channel].includes(config.kind)) {
      throw new AppError(422, `${body.channel} does not accept ${config.kind} export packages.`);
    }
    const service = app.supabaseFactory();
    const { data: workspace, error: workspaceError } = await service.from("workspaces")
      .select("organization_id").eq("id", book.workspace_id).maybeSingle();
    if (workspaceError || !workspace) throw new AppError(404, "workspace not found");
    const entitlement = await requireEntitlement(service, workspace.organization_id, "rendering");
    if (entitlement.entitlements.rendering !== true) {
      throw new AppError(422, "Your current plan does not include book validation.", undefined, "rendering_not_in_plan");
    }

    const model = withEditionLanguage(await assembleBookModel(user, book), edition.language);
    const modelSha256 = bookModelFingerprint(model);
    const images = await loadRenderImages(service, book.workspace_id, model.assets.map((asset) => asset.id), config.cover.asset_id);
    const jobId = randomUUID();
    const { data: inserted, error: insertError } = await service.from("publishing_jobs").insert({
      id: jobId,
      book_id: body.bookId,
      edition_id: body.editionId,
      channel: body.channel,
      status: "running",
      request_json: { action: "validate", editionUpdatedAt: edition.updated_at, bookModelSha256: modelSha256 },
      idempotency_key: body.idempotencyKey,
      created_by: req.userId,
      started_at: new Date().toISOString(),
    }).select("*").single();
    if (insertError?.code === "23505") {
      const { data: existing } = await service.from("publishing_jobs").select("*")
        .eq("idempotency_key", body.idempotencyKey).eq("book_id", body.bookId)
        .eq("created_by", req.userId).maybeSingle();
      if (!existing) throw new AppError(409, "That preflight request key is already in use.");
      const request = requestJson(existing);
      if (request.action !== "validate" || existing.edition_id !== body.editionId || existing.channel !== body.channel
        || request.editionUpdatedAt !== edition.updated_at || request.bookModelSha256 !== modelSha256) {
        throw new AppError(409, "That preflight request key belongs to different saved book content, edition settings, or channel.");
      }
      if (existing.status !== "succeeded") throw new AppError(409, `That preflight request is already ${existing.status}.`);
      reply.header("cache-control", "private, no-store");
      return reply.status(200).send({ jobId: existing.id, ...(existing.response_json as Record<string, unknown>) });
    }
    if (insertError || !inserted) throw new AppError(500, "Could not create the preflight job.");

    let completionPersisted = false;
    try {
      const baseUrl = (process.env.RENDERING_SERVICE_URL
        ?? `http://127.0.0.1:${process.env.RENDERING_SERVICE_PORT ?? "8002"}`).replace(/\/$/u, "");
      const response = await renderFetcher(`${baseUrl}/preflight`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.RENDERING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN
            ? { "x-service-token": process.env.RENDERING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN! }
            : {}),
        },
        body: JSON.stringify({
          editionConfig: config,
          bookModel: model,
          channel: body.channel === "export" ? null : body.channel,
          includeArtifact: true,
          ...images,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(150_000),
      });
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > 2_000_000) throw new AppError(503, "The validator response exceeded the supported size.");
      const responseText = await response.text();
      if (!response.ok) throw new AppError(503, "The edition validator could not complete this request.");
      if (responseText.length > 2_000_000) throw new AppError(503, "The validator response exceeded the supported size.");
      let raw: unknown;
      try { raw = JSON.parse(responseText); } catch { throw new AppError(503, "The validator returned an invalid response."); }
      const validation = preflightResponseSchema.safeParse(raw);
      if (!validation.success) throw new AppError(503, "The validator returned an invalid response.");
      if (body.channel !== "export" && validation.data.channel !== body.channel) {
        throw new AppError(503, "The validator returned results for the wrong publishing channel.");
      }

      const result = { ...validation.data, requestedChannel: body.channel };
      const { data: completed, error: completeError } = await service.rpc("complete_preflight_job", {
        p_job_id: jobId,
        p_result: result,
      });
      let completedJob = Array.isArray(completed) ? completed[0] : completed;
      if (completeError || !completedJob) {
        const { data: recovered } = await service.from("publishing_jobs").select("*").eq("id", jobId).maybeSingle();
        if (recovered?.status === "succeeded") completedJob = recovered;
        else {
          await failPreflightJob(service, jobId);
          if (completeError?.code === "PGRST202" || completeError?.code === "42883") {
            throw new AppError(503, "The preflight workflow migration is not installed.");
          }
          throw new AppError(500, "Could not persist the validation result.");
        }
      }
      completionPersisted = true;
      reply.header("cache-control", "private, no-store");
      return reply.status(201).send({ jobId: completedJob.id, ...(completedJob.response_json as Record<string, unknown>) });
    } catch (error) {
      if (!completionPersisted) await failPreflightJob(service, jobId);
      if (error instanceof AppError) throw error;
      throw new AppError(503, "The edition validator could not complete this request.");
    }
  });

  app.post("/publishing/jobs", async (req, reply) => {
    const parsed = packageRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Check the publishing package request.", { issues: parsed.error.issues });
    const body = parsed.data;
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, body.bookId, req.userId, true);
    const { data: edition, error: editionError } = await user.from("editions").select("*")
      .eq("id", body.editionId).eq("book_id", body.bookId).maybeSingle();
    if (editionError) throw new AppError(500, "Could not load the edition for publishing.");
    if (!edition) throw new AppError(404, "Edition not found for this book.");
    const configResult = editionConfigSchema.safeParse(edition.edition_metadata_json);
    if (!configResult.success || configResult.data.kind !== edition.type) {
      throw new AppError(422, "This edition has invalid settings. Save it before creating a package.");
    }
    const config = configResult.data;
    if (config.kind === "audiobook") {
      throw new AppError(422, "Audiobook retailer packaging is not available in this release.");
    }
    const service = app.supabaseFactory();
    const { data: workspace, error: workspaceError } = await service.from("workspaces")
      .select("organization_id").eq("id", book.workspace_id).maybeSingle();
    if (workspaceError || !workspace) throw new AppError(404, "workspace not found");
    const entitlement = await requireEntitlement(service, workspace.organization_id, "publishing");
    if (!entitlement.entitlements.publishing_channels.includes(CHANNEL_ENTITLEMENT[body.channel])) {
      throw new AppError(422, `Your current plan does not include ${body.channel} export packages.`, undefined, "publishing_channel_not_in_plan");
    }

    const model = withEditionLanguage(await assembleBookModel(user, book), edition.language);
    const modelSha256 = bookModelFingerprint(model);
    const [{ data: renderJob, error: renderError }, { data: preflightJob, error: preflightError }] = await Promise.all([
      service.from("publishing_jobs").select("*").eq("id", body.renderJobId).maybeSingle(),
      service.from("publishing_jobs").select("*").eq("id", body.preflightJobId).maybeSingle(),
    ]);
    if (renderError || preflightError) throw new AppError(500, "Could not verify the source publishing jobs.");
    const source = { bookId: body.bookId, editionId: body.editionId, editionUpdatedAt: edition.updated_at, bookModelSha256: modelSha256 };
    assertSourceJob(renderJob, { ...source, action: "render", channel: "render" });
    assertSourceJob(preflightJob, { ...source, action: "validate", channel: body.channel });
    const storedPreflight = storedPreflightResponseSchema.safeParse(preflightJob?.response_json);
    if (!storedPreflight.success || storedPreflight.data.requestedChannel !== body.channel || storedPreflight.data.errors !== 0) {
      throw new AppError(422, "Resolve all channel preflight errors and run preflight again before creating a package.");
    }

    const artifactsBase64 = await loadRenderedPackageInputs(service, book.workspace_id, config.kind, renderJob!);
    const jobId = randomUUID();
    const requestJson = {
      action: "export_package", editionUpdatedAt: edition.updated_at,
      bookModelSha256: modelSha256,
      sourceRenderJobId: body.renderJobId, sourcePreflightJobId: body.preflightJobId,
    };
    const { data: inserted, error: insertError } = await service.from("publishing_jobs").insert({
      id: jobId, book_id: body.bookId, edition_id: body.editionId, channel: body.channel,
      status: "running", request_json: requestJson, idempotency_key: body.idempotencyKey,
      created_by: req.userId, started_at: new Date().toISOString(),
    }).select("*").single();
    if (insertError?.code === "23505") {
      const { data: existing } = await service.from("publishing_jobs").select("*")
        .eq("idempotency_key", body.idempotencyKey).eq("book_id", body.bookId).eq("created_by", req.userId).maybeSingle();
      if (!existing) throw new AppError(409, "That publishing request key is already in use.");
      const existingRequest = existing.request_json && typeof existing.request_json === "object" && !Array.isArray(existing.request_json)
        ? existing.request_json as Record<string, unknown> : {};
      if (existing.channel !== body.channel || existing.edition_id !== body.editionId
        || existingRequest.action !== "export_package" || existingRequest.editionUpdatedAt !== edition.updated_at
        || existingRequest.bookModelSha256 !== modelSha256
        || existingRequest.sourceRenderJobId !== body.renderJobId
        || existingRequest.sourcePreflightJobId !== body.preflightJobId) {
        throw new AppError(409, "That publishing request key belongs to a different package request.");
      }
      if (existing.status !== "succeeded") throw new AppError(409, `That publishing request is already ${existing.status}.`);
      reply.header("cache-control", "private, no-store");
      return reply.status(200).send(await hydratePackageJob(service, existing));
    }
    if (insertError || !inserted) throw new AppError(500, "Could not create the publishing package job.");

    const uploadedPaths: string[] = [];
    let completionPersisted = false;
    try {
      const baseUrl = (process.env.PUBLISHING_SERVICE_URL
        ?? `http://127.0.0.1:${process.env.PUBLISHING_SERVICE_PORT ?? "8003"}`).replace(/\/$/u, "");
      const response = await publishingFetcher(`${baseUrl}/v1/publishing/package`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.PUBLISHING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN
            ? { "x-service-token": process.env.PUBLISHING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN! }
            : {}),
        },
        body: JSON.stringify({ channel: body.channel, editionConfig: config, bookModel: model, artifactsBase64 }),
        redirect: "error", signal: AbortSignal.timeout(150_000),
      });
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > 280_000_000) throw new AppError(503, "The publishing package response exceeded the supported size.");
      const responseText = await response.text();
      if (response.status === 422) throw new AppError(422, "The saved render no longer passes channel validation. Run preflight and render again.");
      if (!response.ok) throw new AppError(503, "The publishing package service could not complete this request.");
      if (responseText.length > 280_000_000) throw new AppError(503, "The publishing package response exceeded the supported size.");
      let raw: unknown;
      try { raw = JSON.parse(responseText); } catch { throw new AppError(503, "The publishing package service returned an invalid response."); }
      const packaged = packageServiceResponseSchema.safeParse(raw);
      if (!packaged.success || packaged.data.channel !== body.channel) {
        throw new AppError(503, "The publishing package service returned an invalid response.");
      }
      const servicePackage = packaged.data.packages[0];
      if (servicePackage.path !== `${body.channel}-export.zip`) {
        throw new AppError(503, "The publishing package service returned a package for the wrong channel.");
      }
      const bytes = decodePackage(servicePackage.dataBase64, servicePackage.sha256);
      const assetId = randomUUID();
      const storagePath = `workspaces/${book.workspace_id}/assets/${assetId}/v1/${servicePackage.path}`;
      const artifact = {
        assetId, storagePath, filename: servicePackage.path, type: "publishing_package", role: "publishing_package",
        name: `${String(book.title).slice(0, 220)} · ${body.channel} export`, mimeType: "application/zip",
        sizeBytes: bytes.length, checksum: servicePackage.sha256.toLowerCase(),
      };
      const { error: uploadError } = await service.storage.from(BUCKET).upload(storagePath, bytes, {
        contentType: "application/zip", upsert: false,
      });
      if (uploadError) throw new AppError(503, "The publishing package could not be stored.");
      uploadedPaths.push(storagePath);

      const { data: completed, error: completeError } = await service.rpc("complete_publishing_package_job", {
        p_job_id: jobId, p_artifact: artifact, p_rule_version: packaged.data.ruleVersion,
        p_source_render_job_id: body.renderJobId, p_source_preflight_job_id: body.preflightJobId,
      });
      let completedJob = Array.isArray(completed) ? completed[0] : completed;
      if (completeError || !completedJob) {
        const { data: recovered } = await service.from("publishing_jobs").select("*").eq("id", jobId).maybeSingle();
        if (recovered?.status === "succeeded") completedJob = recovered;
        else {
          await service.storage.from(BUCKET).remove(uploadedPaths);
          await failPackageJob(service, jobId, "package_persistence_failed");
          if (completeError?.code === "PGRST202" || completeError?.code === "42883") {
            throw new AppError(503, "The publishing package workflow migration is not installed.");
          }
          throw new AppError(500, "Could not persist the publishing package.");
        }
      }
      completionPersisted = true;
      reply.header("cache-control", "private, no-store");
      return reply.status(201).send(await hydratePackageJob(service, completedJob));
    } catch (error) {
      if (!completionPersisted) {
        if (uploadedPaths.length) await service.storage.from(BUCKET).remove(uploadedPaths);
        await failPackageJob(service, jobId, "package_failed");
      }
      if (error instanceof AppError) throw error;
      throw new AppError(503, "The publishing package could not be created.");
    }
  });

  app.get("/publishing/jobs", async (req) => {
    const parsed = listPackageJobsSchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(422, "Check the publishing history filters.", { issues: parsed.error.issues });
    const query = parsed.data;
    const user = app.supabaseFactory(req.userToken);
    await loadBook(user, query.bookId, req.userId);
    const { data, error } = await user.from("publishing_jobs").select("*")
      .eq("book_id", query.bookId).in("channel", retailerChannelSchema.options)
      .order("created_at", { ascending: false }).limit(100);
    if (error) throw new AppError(500, "Could not load publishing package history.");
    const jobs = (data ?? []).filter((job) => requestJson(job).action === "export_package"
      && (!query.editionId || job.edition_id === query.editionId)
      && (!query.channel || job.channel === query.channel)).slice(0, query.limit);
    const service = app.supabaseFactory();
    return { jobs: await Promise.all(jobs.map((job) => hydratePackageJob(service, job))) };
  });

  app.get("/publishing/jobs/:jobId", async (req) => {
    const parsed = z.object({ jobId: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) throw new AppError(422, "Invalid publishing job id.");
    const user = app.supabaseFactory(req.userToken);
    const { data: job, error } = await user.from("publishing_jobs").select("*").eq("id", parsed.data.jobId).maybeSingle();
    if (error) throw new AppError(500, "Could not load the publishing job.");
    if (!job || requestJson(job).action !== "export_package") throw new AppError(404, "Publishing package job not found.");
    await loadBook(user, job.book_id, req.userId);
    return hydratePackageJob(app.supabaseFactory(), job);
  });
}
