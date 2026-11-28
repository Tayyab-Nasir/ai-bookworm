import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { BookMetadataSchema } from "@bookworm/book-model";
import { RETAILER_SUBMISSION_STATUSES, type RetailerSubmission } from "@bookworm/types";
import { artworkSnapshotSchema, renderImagesFingerprint, assertRenderImagesCurrent, printProofImageInputs } from "../lib/render-images.js";
import { AppError } from "../errors.js";
import { boundedServiceText } from "../lib/bounded-service-response.js";
import { assembleBookModel, bookModelFingerprint, loadBook } from "../lib/authoring.js";
import { requireEntitlement } from "../lib/entitlements.js";
import { boundedSupabaseFetch } from "../lib/supabase.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { readPackageListing } from "../lib/package-listing.js";
import { editionConfigSchema, loadRenderImages, withEditionLanguage, requiresEffectiveEbookCoverPolicy, uploadedCoverVersion,
  EFFECTIVE_EBOOK_COVER_POLICY, EFFECTIVE_EBOOK_COVER_RENDERER_VERSION, UPLOADED_WRAP_RENDERER_VERSION } from "./editions.js";

const channelSchema = z.enum(["export", "kdp", "apple", "barnesnoble", "lulu", "googleplay"]);
const retailerChannelSchema = z.enum(["kdp", "apple", "barnesnoble", "lulu", "googleplay"]);
const submissionJobIdSchema = z.object({ jobId: z.guid().transform(value => value.toLowerCase()) });
const submissionStatusSchema = z.enum(RETAILER_SUBMISSION_STATUSES);
const submissionUpdateSchema = z.object({
  status: submissionStatusSchema,
  expectedRevision: z.guid().nullable(),
}).strict();
const submissionRowSchema = z.object({
  publishing_job_id: z.guid(),
  status: submissionStatusSchema,
  revision: z.guid(),
  updated_at: z.string().datetime({ offset: true }),
});

function submissionResult(row: unknown, jobId: string): RetailerSubmission {
  const parsed = submissionRowSchema.safeParse(row);
  if (!parsed.success || parsed.data.publishing_job_id !== jobId) {
    throw new AppError(503, "The submission status could not be verified.");
  }
  const { status, revision, updated_at: updatedAt } = parsed.data;
  return { jobId, status, revision, updatedAt };
}

function publishingServiceUrl() {
  return (process.env.PUBLISHING_SERVICE_URL
    ?? `http://127.0.0.1:${process.env.PUBLISHING_SERVICE_PORT ?? "8003"}`).replace(/\/$/u, "");
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const managedPublishingBodySchema = z.object({ packageSha256: sha256Schema, withdraw: z.literal(true).optional() }).strict();
const managedPublishingRowSchema = z.object({
  package_job_id: z.guid(),
  workspace_id: z.guid(),
  requested_by: z.guid().nullable(),
  package_sha256: sha256Schema,
  requested_at: z.string().datetime({ offset: true }),
  withdrawn_at: z.string().datetime({ offset: true }).nullable(),
  claimed_by: z.guid().nullable(),
  claimed_at: z.string().datetime({ offset: true }).nullable(),
  confirmed_at: z.string().datetime({ offset: true }).nullable(),
  listing_url: z.string().max(1024).regex(/^https:\/\/[a-z0-9.]+\/[A-Za-z0-9/_~.%+?=-]+$/).nullable(),
});

function managedPublishingResult(row: unknown, jobId: string, workspaceId: string) {
  const parsed = managedPublishingRowSchema.safeParse(row);
  if (!parsed.success || parsed.data.package_job_id !== jobId || parsed.data.workspace_id !== workspaceId) {
    throw new AppError(503, "The managed publishing request could not be verified.");
  }
  const { requested_by: requestedBy, package_sha256: packageSha256, requested_at: requestedAt, withdrawn_at: withdrawnAt,
    claimed_by: claimedBy, claimed_at: claimedAt, confirmed_at: confirmedAt, listing_url: listingUrl } = parsed.data;
  if ((confirmedAt === null) !== (listingUrl === null) || (confirmedAt && withdrawnAt)) {
    throw new AppError(503, "The managed publishing state could not be verified.");
  }
  return { jobId, workspaceId, requestedBy, packageSha256, requestedAt, withdrawnAt, claimedAt: claimedBy ? claimedAt : null, confirmedAt, listingUrl };
}
const sourceEpubSchema = z.object({ jobId: z.guid(), sha256: sha256Schema }).strict();
const savedPreflightSourceFields = {
  sourceEpub: sourceEpubSchema.optional(),
  sourcePrint: sourceEpubSchema.extend({ coverSha256: sha256Schema.nullable() }).strict().optional(),
};
const savedPreflightSourceObject = z.object(savedPreflightSourceFields);
type SavedPreflightSources = z.infer<typeof savedPreflightSourceObject>;
type SavedProofSelection = NonNullable<SavedPreflightSources[keyof SavedPreflightSources]>;
const singleSavedPreflightSource = (value: SavedPreflightSources) => !(value.sourceEpub && value.sourcePrint);
export const savedPreflightSourcesSchema = savedPreflightSourceObject.refine(singleSavedPreflightSource);

function sameSavedPreflightSource(left: SavedPreflightSources, right: SavedPreflightSources) {
  const a = left.sourcePrint ?? left.sourceEpub, b = right.sourcePrint ?? right.sourceEpub;
  return a?.jobId === b?.jobId && a?.sha256 === b?.sha256 && left.sourcePrint?.coverSha256 === right.sourcePrint?.coverSha256;
}

const preflightSchema = z.object({
  bookId: z.guid(),
  editionId: z.guid(),
  channel: channelSchema.default("export"),
  idempotencyKey: z.string().trim().min(8).max(200),
  ...savedPreflightSourceFields,
}).strict().refine(singleSavedPreflightSource);

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

const storedPreflightResponseSchema = preflightResponseSchema.extend({
  requestedChannel: channelSchema,
  ...savedPreflightSourceFields,
}).strict().refine(singleSavedPreflightSource);
const validatorResponseSchema = preflightResponseSchema.extend({
  artifactSha256: sha256Schema.optional(), coverSha256: sha256Schema.nullable().optional(),
  listing: z.object({ schemaVersion: z.literal("1.0"), metadata: BookMetadataSchema.extend({
    title: z.string(), author: z.string(),
  }).strict() }).strict().optional(),
}).strict();

export function verifyPreflightReport(raw: unknown, channel: string, sources: SavedPreflightSources) {
  const validation = validatorResponseSchema.safeParse(raw);
  if (!validation.success) throw new AppError(503, "The validator returned an invalid response.");
  if (channel !== "export" && validation.data.channel !== channel) {
    throw new AppError(503, "The validator returned results for the wrong publishing channel.");
  }
  const { artifactSha256, coverSha256, ...report } = validation.data;
  if (artifactSha256 !== (sources.sourcePrint ?? sources.sourceEpub)?.sha256 || coverSha256 !== sources.sourcePrint?.coverSha256) {
    throw new AppError(503, sources.sourcePrint ? "The validator did not verify the selected print interior and cover."
      : "The validator did not verify the selected saved EPUB.");
  }
  return { ...report, requestedChannel: channel, ...sources };
}

export function readPackagePreflight(job: Record<string, unknown>, channel: string) {
  const output = storedPreflightResponseSchema.safeParse(job.response_json);
  const input = savedPreflightSourcesSchema.safeParse(requestJson(job));
  return output.success && input.success && output.data.requestedChannel === channel && output.data.errors === 0
    && sameSavedPreflightSource(input.data, output.data) ? output.data : null;
}

const packageRequestSchema = z.object({
  bookId: z.guid(),
  editionId: z.guid(),
  channel: retailerChannelSchema,
  renderJobId: z.guid(),
  preflightJobId: z.guid(),
  idempotencyKey: z.string().trim().min(8).max(200),
}).strict();

const listPackageJobsSchema = z.object({
  bookId: z.guid(),
  editionId: z.guid().optional(),
  channel: retailerChannelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  beforeCreatedAt: z.string().datetime({ offset: true }).optional(),
  beforeId: z.guid().optional(),
}).strict().refine(query => Boolean(query.beforeCreatedAt) === Boolean(query.beforeId));

const renderArtifactSchema = z.object({
  assetId: z.guid(),
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
  usage: z.record(z.string(), z.unknown()),
}).strict();

const packageArtifactSchema = renderArtifactSchema.extend({
  type: z.literal("publishing_package"), role: z.literal("publishing_package"),
  mimeType: z.literal("application/zip"), sizeBytes: z.number().int().min(1).max(200 * 1024 * 1024),
  filename: z.string().regex(/^[a-z]+-export\.zip$/u).max(128),
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
  kdp: "kdp", apple: "apple_books", barnesnoble: "barnes_noble", lulu: "lulu", googleplay: "google_play",
};
const CHANNEL_FORMATS: Record<z.infer<typeof retailerChannelSchema>, ("ebook" | "print")[]> = {
  kdp: ["ebook", "print"], apple: ["ebook"], barnesnoble: ["ebook", "print"], lulu: ["print"], googleplay: ["ebook"],
};

const BUCKET = "book-assets";

async function failPreflightJob(sb: ReturnType<FastifyInstance["supabaseFactory"]>, jobId: string) {
  await sb.from("publishing_jobs").update({
    status: "failed", response_json: { error: "preflight_failed" }, completed_at: new Date().toISOString(),
  }).eq("id", jobId).in("status", ["queued", "running"]);
}

async function failPackageJob(sb: SupabaseClient, jobId: string, message: string) {
  const { data, error } = await sb.from("publishing_jobs").update({
    status: "failed", response_json: { error: message.slice(0, 500) }, completed_at: new Date().toISOString(),
  }).eq("id", jobId).in("status", ["queued", "running"]).select("id").maybeSingle();
  return !error && data?.id === jobId;
}

function requestJson(job: Record<string, unknown>) {
  return job.request_json && typeof job.request_json === "object" && !Array.isArray(job.request_json)
    ? job.request_json as Record<string, unknown>
    : {};
}

type PublishingSourceSnapshot = {
  bookId: string; editionId: string; editionUpdatedAt: string; bookModelSha256: string; imageSha256?: string;
};

export function assertSourceJob(
  job: Record<string, unknown> | null,
  expected: PublishingSourceSnapshot & { action: "render" | "validate"; channel: string },
): asserts job is Record<string, unknown> {
  const request = job ? requestJson(job) : {};
  if (!job || job.status !== "succeeded" || job.book_id !== expected.bookId || job.edition_id !== expected.editionId
    || job.channel !== expected.channel || request.action !== expected.action
    || request.editionUpdatedAt !== expected.editionUpdatedAt || request.bookModelSha256 !== expected.bookModelSha256
    || (expected.imageSha256 !== undefined && request.imageSha256 !== expected.imageSha256)) {
    throw new AppError(422, `Run a fresh successful ${expected.action === "render" ? "render" : "preflight"} for these saved edition settings.`);
  }
}

export async function readSavedPreflightRender(sb: SupabaseClient, snapshot: PublishingSourceSnapshot, proof: SavedProofSelection) {
  const { data: job, error } = await sb.from("publishing_jobs").select("*")
    .eq("id", proof.jobId).eq("book_id", snapshot.bookId).eq("edition_id", snapshot.editionId).maybeSingle();
  if (error) throw new AppError(503, "The selected saved proof could not be verified.");
  assertSourceJob(job, { ...snapshot, action: "render", channel: "render" });
  return job;
}

export const PACKAGE_RENDER_PROOF_CHANGE = "bookworm_publishing_render_proof_changed";
const unavailableRenderProof = () => new AppError(422,
  "A saved render or cover is no longer verified for packaging. Choose a current proof or render again.", undefined, "package_render_proof_changed");

export async function checkRenderedPackageInputs(
  sb: SupabaseClient,
  workspaceId: string,
  kind: "ebook" | "print",
  renderJob: Record<string, unknown>,
  config: z.infer<typeof editionConfigSchema>,
  proof?: SavedProofSelection,
) {
  if (config.kind !== kind) throw new AppError(422, "The selected render format does not match these saved edition settings.");
  if (proof && (kind !== ("coverSha256" in proof ? "print" : "ebook") || renderJob.id !== proof.jobId)) {
    const label = "coverSha256" in proof ? "print proof" : "EPUB";
    throw new AppError(422, `Run preflight on the same saved ${label} before creating its package.`);
  }
  assertSavedRenderedCoverPolicy(config, renderJob);
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
  if (primary[0].type !== "rendered_book" || primary[0].mimeType !== primaryMime || primary[0].filename !== primaryName) {
    throw new AppError(422, "The selected render format does not match this edition.");
  }
  if (proof && primary[0].checksum.toLowerCase() !== proof.sha256) {
    throw new AppError(409, "The saved interior does not match the selected checksum. Refresh the proof desk.");
  }
  if (proof && "coverSha256" in proof && (covers[0]?.checksum.toLowerCase() ?? null) !== proof.coverSha256) {
    throw new AppError(409, "The saved cover does not match the selected print proof. Refresh the proof desk.");
  }
  for (const cover of covers) {
    if (cover.type !== "rendered_cover" || !((cover.filename === "cover.png" && cover.mimeType === "image/png")
      || (kind === "print" && cover.filename === "cover.pdf" && cover.mimeType === "application/pdf"))) {
      throw new AppError(422, "The selected cover has an invalid format. Render this edition again.");
    }
  }

  const descriptors = [...primary, ...covers];
  const ids = descriptors.map((artifact) => artifact.assetId);
  const [assets, versions] = await Promise.all([
    sb.from("assets").select("*").eq("workspace_id", workspaceId).is("deleted_at", null).in("id", ids),
    sb.from("asset_versions").select("asset_id,version_number,storage_path,checksum,mime_type,size_bytes,scan_status")
      .eq("version_number", 1).in("asset_id", ids),
  ]);
  if (assets.error || versions.error) throw new AppError(503, "The saved proof's verification status could not be checked.");

  for (const descriptor of descriptors) {
    const asset = assets.data?.find(candidate => candidate.id === descriptor.assetId);
    const version = versions.data?.find(row => row.asset_id === descriptor.assetId);
    const path = `workspaces/${workspaceId}/assets/${descriptor.assetId}/v1/${descriptor.filename}`;
    const matches = (row: Record<string, unknown> | undefined) => row?.storage_path === descriptor.storagePath
      && row.mime_type === descriptor.mimeType && Number(row.size_bytes) === descriptor.sizeBytes
      && String(row.checksum).toLowerCase() === descriptor.checksum.toLowerCase();
    if (descriptor.storagePath !== path || !matches(asset) || asset?.type !== descriptor.type
      || !["draft", "in_review", "approved"].includes(String(asset?.status))
      || !matches(version) || version?.version_number !== 1 || !["clean", "trusted_generated"].includes(String(version?.scan_status))) {
      throw unavailableRenderProof();
    }
  }
  return descriptors;
}

export async function loadRenderedPackageInputs(
  sb: SupabaseClient, workspaceId: string, kind: "ebook" | "print", renderJob: Record<string, unknown>,
  config: z.infer<typeof editionConfigSchema>, proof?: SavedProofSelection,
) {
  const descriptors = await checkRenderedPackageInputs(sb, workspaceId, kind, renderJob, config, proof);
  const encoded: Record<string, string> = {};
  let total = 0;
  for (const descriptor of descriptors) {
    const { data: stored, error: downloadError } = await sb.storage.from(BUCKET).download(descriptor.storagePath);
    if (downloadError || !stored) throw new AppError(503, "A selected render artifact could not be loaded from private storage.");
    const bytes = Buffer.from(await stored.arrayBuffer());
    total += bytes.length;
    if (total > 175 * 1024 * 1024 || bytes.length !== descriptor.sizeBytes
      || createHash("sha256").update(bytes).digest("hex") !== descriptor.checksum.toLowerCase()) {
      throw new AppError(422, "A selected render artifact failed its integrity check.");
    }
    const signature = descriptor.mimeType === "application/epub+zip" ? Buffer.from("PK")
      : descriptor.mimeType === "application/pdf" ? Buffer.from("%PDF-") : Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    if (!bytes.subarray(0, signature.length).equals(signature)) {
      throw new AppError(422, "A selected render artifact has the wrong file format.");
    }
    encoded[descriptor.filename] = bytes.toString("base64");
  }
  return encoded;
}

async function findPackageRequest(sb: SupabaseClient, userId: string, bookId: string, key: string) {
  const { data, error } = await sb.from("publishing_jobs").select("*")
    .eq("book_id", bookId).eq("created_by", userId).eq("idempotency_key", key).maybeSingle();
  if (error) throw new AppError(503, "The original package request could not be checked. Keep its request ID.");
  return data as Record<string, unknown> | null;
}

function assertPackageActor(req: FastifyRequest) {
  const actor = req.headers["x-bookworm-actor"];
  if (actor !== undefined && (!z.guid().safeParse(actor).success || actor !== req.userId)) {
    throw new AppError(409, "Your account changed. Use the original account to recover this export request.");
  }
}

function assertPackageRequest(job: Record<string, unknown>, body: z.infer<typeof packageRequestSchema>) {
  const original = requestJson(job);
  if (job.book_id !== body.bookId || job.edition_id !== body.editionId || job.channel !== body.channel
    || original.action !== "export_package" || original.sourceRenderJobId !== body.renderJobId
    || original.sourcePreflightJobId !== body.preflightJobId) {
    throw new AppError(409, "That publishing request key belongs to a different package request.");
  }
}

export function assertSavedRenderedCoverPolicy(config: z.infer<typeof editionConfigSchema>, renderJob: Record<string, unknown> | null) {
  const sourcePdfVersion = uploadedCoverVersion(config);
  if (sourcePdfVersion === undefined && !requiresEffectiveEbookCoverPolicy(config)) return;
  const response = renderJobResponseSchema.safeParse(renderJob?.response_json);
  const covers = response.success ? response.data.artifacts.filter(artifact => artifact.role === "rendered_cover") : [];
  if (config.kind === "print" && sourcePdfVersion !== undefined) {
    const request = renderJob?.request_json as { artworkSnapshot?: unknown } | null;
    const snapshot = artworkSnapshotSchema.safeParse(request?.artworkSnapshot);
    const source = snapshot.success && snapshot.data.coverAssetId === config.cover.asset_id
      ? snapshot.data.assets.find(asset => asset.assetId === config.cover.asset_id) : undefined;
    if (!source || source.versionNumber !== sourcePdfVersion || source.mimeType !== "application/pdf"
      || !response.success || response.data.usage.coverRendererVersion !== UPLOADED_WRAP_RENDERER_VERSION
      || covers.length !== 1 || covers[0].type !== "rendered_cover" || covers[0].filename !== "cover.pdf"
      || covers[0].mimeType !== "application/pdf" || covers[0].checksum !== source.checksum || covers[0].sizeBytes !== source.sizeBytes) {
      throw new AppError(422, "The saved proof does not match the selected uploaded cover PDF. Render again before packaging.");
    }
    return;
  }
  if (!response.success || response.data.usage.coverRendererVersion !== EFFECTIVE_EBOOK_COVER_RENDERER_VERSION
    || response.data.usage.coverMetadataPolicy !== EFFECTIVE_EBOOK_COVER_POLICY
    || covers.length !== 1 || covers[0].type !== "rendered_cover" || covers[0].filename !== "cover.png" || covers[0].mimeType !== "image/png") {
    throw new AppError(422, "The selected render uses unsupported cover metadata. Render again with the updated renderer and a new request key before creating a package.",
      undefined, "saved_cover_metadata_policy_unsupported");
  }
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

function packageResponse(job: Record<string, unknown>) {
  return job.response_json && typeof job.response_json === "object" && !Array.isArray(job.response_json)
    ? job.response_json as Record<string, unknown> : {};
}

async function verifyPackageArtifact(sb: SupabaseClient, workspaceId: string, job: Record<string, unknown>) {
  const response = packageResponse(job);
  const parsed = packageArtifactSchema.safeParse(response.artifact);
  if (job.status === "succeeded" && parsed.success) {
    const descriptor = parsed.data;
    const canonicalPath = `workspaces/${workspaceId}/assets/${descriptor.assetId}/v1/${job.channel}-export.zip`;
    if (descriptor.filename === `${job.channel}-export.zip` && descriptor.storagePath === canonicalPath) {
      const [{ data: asset, error: assetError }, { data: version, error: versionError }] = await Promise.all([
        sb.from("assets").select("*").eq("id", descriptor.assetId).eq("workspace_id", workspaceId).is("deleted_at", null).maybeSingle(),
        sb.from("asset_versions").select("asset_id,version_number,storage_path,checksum,mime_type,size_bytes,scan_status")
          .eq("asset_id", descriptor.assetId).eq("version_number", 1).maybeSingle(),
      ]);
      if (assetError || versionError) throw new AppError(503, "The private package availability could not be verified.");
      const matches = (row: Record<string, unknown> | null) => row && row.storage_path === canonicalPath
        && row.mime_type === descriptor.mimeType && Number(row.size_bytes) === descriptor.sizeBytes
        && String(row.checksum).toLowerCase() === descriptor.checksum.toLowerCase();
      // Keep the immutable job in history, but never renew access to unavailable
      // or replaced bytes. Restoring the exact confirmed asset can restore its link.
      if (matches(asset) && asset?.workspace_id === workspaceId && asset.deleted_at === null
        && asset.type === descriptor.type && ["draft", "in_review", "approved"].includes(String(asset.status))
        && matches(version) && version?.asset_id === descriptor.assetId && version.version_number === 1
        && ["clean", "trusted_generated"].includes(String(version.scan_status))) {
        return { asset, descriptor };
      }
    }
  }
  return null;
}

async function hydratePackageJob(sb: SupabaseClient, workspaceId: string, job: Record<string, unknown>) {
  const response = packageResponse(job);
  const verified = await verifyPackageArtifact(sb, workspaceId, job);
  let packageArtifact = null;
  if (verified) {
    const { data: signed, error: signError } = await sb.storage.from(BUCKET).createSignedUrl(verified.descriptor.storagePath, 300);
    if (signError || !signed?.signedUrl) throw new AppError(503, "A private package download link could not be created.");
    packageArtifact = { asset: verified.asset, download: { url: signed.signedUrl, expiresIn: 300 } };
  }
  const request = requestJson(job);
  return {
    id: job.id, requestId: job.idempotency_key, bookId: job.book_id, editionId: job.edition_id, channel: job.channel, status: job.status,
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
    assertPackageActor(req);
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
    const { sourceEpub, sourcePrint } = body;
    const proof = sourcePrint ?? sourceEpub;
    const sources = { sourceEpub, sourcePrint };
    if (sourceEpub && (config.kind !== "ebook" || body.channel === "export")) {
      throw new AppError(422, "Choose a retailer that accepts EPUB before validating a saved ebook.");
    }
    if (sourcePrint && (config.kind !== "print" || body.channel === "export")) {
      throw new AppError(422, "Choose a retailer that accepts print PDFs before validating a saved print proof.");
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
    const loadedImages = await loadRenderImages(service, book.workspace_id, model.assets.map((asset) => asset.id), config.cover.asset_id,
      model.chapters.flatMap((chapter) => chapter.nodes), uploadedCoverVersion(config));
    const { artworkSnapshot, ...images } = loadedImages;
    const imageSha256 = renderImagesFingerprint(loadedImages);
    const snapshot = { bookId: body.bookId, editionId: body.editionId, editionUpdatedAt: edition.updated_at,
      bookModelSha256: modelSha256, imageSha256 };
    const savedRender = proof ? await readSavedPreflightRender(user, snapshot, proof) : null;
    const savedArtifacts = savedRender
      ? await loadRenderedPackageInputs(service, book.workspace_id, config.kind, savedRender, config, proof) : undefined;
    const jobId = randomUUID();
    const { data: inserted, error: insertError } = await service.from("publishing_jobs").insert({
      id: jobId,
      book_id: body.bookId,
      edition_id: body.editionId,
      channel: body.channel,
      status: "running",
      request_json: { action: "validate", editionUpdatedAt: edition.updated_at, bookModelSha256: modelSha256, imageSha256, artworkSnapshot, ...sources },
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
      const previousSource = savedPreflightSourcesSchema.safeParse(request);
      if (request.action !== "validate" || existing.edition_id !== body.editionId || existing.channel !== body.channel
        || request.editionUpdatedAt !== edition.updated_at || request.bookModelSha256 !== modelSha256 || request.imageSha256 !== imageSha256
        || !previousSource.success || !sameSavedPreflightSource(previousSource.data, sources)) {
        throw new AppError(409, "That preflight request key belongs to different saved content, edition settings, channel, or source proof.");
      }
      if (existing.status !== "succeeded") throw new AppError(409, `That preflight request is already ${existing.status}.`);
      reply.header("cache-control", "private, no-store");
      return reply.status(200).send({ jobId: existing.id, ...(existing.response_json as Record<string, unknown>) });
    }
    if (insertError || !inserted) throw new AppError(500, "Could not create the preflight job.");

    let completionPersisted = false;
    try {
      const baseUrl = savedArtifacts ? publishingServiceUrl() : (process.env.RENDERING_SERVICE_URL
        ?? `http://127.0.0.1:${process.env.RENDERING_SERVICE_PORT ?? "8002"}`).replace(/\/$/u, "");
      const serviceToken = (savedArtifacts ? process.env.PUBLISHING_SERVICE_TOKEN : process.env.RENDERING_SERVICE_TOKEN) || process.env.SERVICE_AUTH_TOKEN;
      const url = savedArtifacts ? `${baseUrl}/v1/publishing/validate` : `${baseUrl}/preflight`;
      const response = await (savedArtifacts ? publishingFetcher : renderFetcher)(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(body.channel === "export" ? {} : { "x-bookworm-include-listing": "true" }),
          ...(serviceToken ? { "x-service-token": serviceToken } : {}),
        },
        body: JSON.stringify(savedArtifacts ? {
          editionConfig: config, bookModel: model, channel: body.channel, artifactsBase64: savedArtifacts,
          ...printProofImageInputs(config.kind, model.chapters, images.assetImagesBase64),
        } : {
          editionConfig: config,
          bookModel: model,
          channel: body.channel === "export" ? null : body.channel,
          includeArtifact: true,
          ...images,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(150_000),
      });
      const responseText = await boundedServiceText(response, 2_000_000, "The validator response exceeded the supported size.");
      if (!response.ok) throw new AppError(503, "The edition validator could not complete this request.");
      let raw: unknown;
      try { raw = JSON.parse(responseText); } catch { throw new AppError(503, "The validator returned an invalid response."); }
      // The listing is a view of the exact checked model. Keep the durable
      // receipt shape compatible with active package workers and old reads.
      const { listing, ...result } = verifyPreflightReport(raw, body.channel, sources);
      await assertRenderImagesCurrent(service, book.workspace_id, model.assets.map(asset => asset.id), config.cover.asset_id,
        model.chapters.flatMap(chapter => chapter.nodes), imageSha256, uploadedCoverVersion(config));
      if (savedRender) await checkRenderedPackageInputs(service, book.workspace_id, config.kind, savedRender, config, proof);
      const { data: completed, error: completeError } = await service.rpc("complete_preflight_job", {
        p_job_id: jobId,
        p_result: result,
      });
      let completedJob = Array.isArray(completed) ? completed[0] : completed;
      if (completeError || !completedJob) {
        const { data: recovered, error: recoveryError } = await service.from("publishing_jobs").select("*").eq("id", jobId).maybeSingle();
        if (!recoveryError && recovered?.status === "succeeded") completedJob = recovered;
        else {
          await failPreflightJob(service, jobId);
          if (completeError?.code === "40001" && completeError.details === PACKAGE_RENDER_PROOF_CHANGE) throw unavailableRenderProof();
          if (completeError?.code === "PGRST202" || completeError?.code === "42883") {
            throw new AppError(503, "The preflight workflow migration is not installed.");
          }
          if (completeError?.code === "40001" || completeError?.code === "22023") {
            throw new AppError(422, "Book artwork or edition settings changed before completion. Run preflight again.");
          }
          if (completeError?.code === "42501") {
            throw new AppError(403, "Your book editing permission changed before completion. Check your access.");
          }
          throw new AppError(500, "Could not persist the validation result.");
        }
      }
      completionPersisted = true;
      reply.header("cache-control", "private, no-store");
      return reply.status(201).send({ jobId: completedJob.id, ...(completedJob.response_json as Record<string, unknown>),
        ...(body.channel !== "export" && listing ? { listing } : {}) });
    } catch (error) {
      if (!completionPersisted) await failPreflightJob(service, jobId);
      if (error instanceof AppError) throw error;
      throw new AppError(503, "The edition validator could not complete this request.");
    }
  });

  app.post("/publishing/jobs", { config: { durableIdempotency: true } }, async (req, reply) => {
    assertPackageActor(req);
    const parsed = packageRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Check the publishing package request.", { issues: parsed.error.issues });
    const body = parsed.data;
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, body.bookId, req.userId, true);
    const service = app.supabaseFactory();
    const replay = async (existing: Record<string, unknown>) => {
      assertPackageRequest(existing, body);
      if (existing.status !== "succeeded") throw new AppError(409, `That publishing request is already ${existing.status}. Recover its saved status before starting another export.`);
      reply.header("cache-control", "private, no-store");
      return reply.status(200).send(await hydratePackageJob(service, book.workspace_id, existing));
    };
    // Recovery reads the accepted immutable result. New work alone must pass
    // current source/plan gates; an edited manuscript must not erase its receipt.
    const existing = await findPackageRequest(user, req.userId, body.bookId, body.idempotencyKey);
    if (existing) return replay(existing);
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
    const earlySource = { bookId: body.bookId, editionId: body.editionId, editionUpdatedAt: edition.updated_at, bookModelSha256: modelSha256 };
    assertSourceJob(renderJob, { ...earlySource, action: "render", channel: "render" });
    assertSourceJob(preflightJob, { ...earlySource, action: "validate", channel: body.channel });
    assertSavedRenderedCoverPolicy(config, renderJob);
    const images = await loadRenderImages(service, book.workspace_id, model.assets.map(asset => asset.id), config.cover.asset_id,
      model.chapters.flatMap(chapter => chapter.nodes), uploadedCoverVersion(config));
    const { artworkSnapshot } = images;
    const imageSha256 = renderImagesFingerprint(images);
    const source = { bookId: body.bookId, editionId: body.editionId, editionUpdatedAt: edition.updated_at, bookModelSha256: modelSha256, imageSha256 };
    assertSourceJob(renderJob, { ...source, action: "render", channel: "render" });
    assertSourceJob(preflightJob, { ...source, action: "validate", channel: body.channel });
    const storedPreflight = readPackagePreflight(preflightJob, body.channel);
    if (!storedPreflight) {
      throw new AppError(422, "Resolve all channel preflight errors and run preflight again before creating a package.");
    }
    const proof = storedPreflight.sourcePrint ?? storedPreflight.sourceEpub;
    const artifactsBase64 = await loadRenderedPackageInputs(service, book.workspace_id, config.kind, renderJob, config, proof);
    const jobId = randomUUID();
    const requestJson = {
      action: "export_package", editionUpdatedAt: edition.updated_at,
      bookModelSha256: modelSha256,
      imageSha256,
      artworkSnapshot,
      sourceRenderJobId: body.renderJobId, sourcePreflightJobId: body.preflightJobId,
    };
    const { data: inserted, error: insertError } = await service.from("publishing_jobs").insert({
      id: jobId, book_id: body.bookId, edition_id: body.editionId, channel: body.channel,
      status: "running", request_json: requestJson, idempotency_key: body.idempotencyKey,
      created_by: req.userId, started_at: new Date().toISOString(),
    }).select("*").single();
    if (insertError?.code === "23505") {
      const existing = await findPackageRequest(user, req.userId, body.bookId, body.idempotencyKey);
      if (!existing) throw new AppError(409, "That publishing request key is already in use.");
      return replay(existing);
    }
    if (insertError || !inserted) throw new AppError(500, "Could not create the publishing package job.");

    const uploadedPaths: string[] = [];
    let completionPersisted = false;
    let completionAttempted = false;
    try {
      const response = await publishingFetcher(`${publishingServiceUrl()}/v1/publishing/package`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(process.env.PUBLISHING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN
            ? { "x-service-token": process.env.PUBLISHING_SERVICE_TOKEN || process.env.SERVICE_AUTH_TOKEN! }
            : {}),
        },
        body: JSON.stringify({ channel: body.channel, editionConfig: config, bookModel: model, artifactsBase64,
          ...printProofImageInputs(config.kind, model.chapters, images.assetImagesBase64),
        }),
        redirect: "error", signal: AbortSignal.timeout(150_000),
      });
      const responseText = await boundedServiceText(response, 280_000_000, "The publishing package response exceeded the supported size.");
      if (response.status === 422) throw new AppError(422, "The saved render no longer passes channel validation. Run preflight and render again.");
      if (!response.ok) throw new AppError(503, "The publishing package service could not complete this request.");
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
      await checkRenderedPackageInputs(service, book.workspace_id, config.kind, renderJob, config, proof);
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

      await assertRenderImagesCurrent(service, book.workspace_id, model.assets.map(asset => asset.id), config.cover.asset_id,
        model.chapters.flatMap(chapter => chapter.nodes), imageSha256, uploadedCoverVersion(config));
      completionAttempted = true;
      const { data: completed, error: completeError } = await service.rpc("complete_publishing_package_job", {
        p_job_id: jobId, p_artifact: artifact, p_rule_version: packaged.data.ruleVersion,
        p_source_render_job_id: body.renderJobId, p_source_preflight_job_id: body.preflightJobId,
      });
      let completedJob = Array.isArray(completed) ? completed[0] : completed;
      if (completeError || !completedJob) {
        const { data: recovered, error: recoveryError } = await service.from("publishing_jobs").select("*").eq("id", jobId).maybeSingle();
        if (!recoveryError && recovered?.status === "succeeded") completedJob = recovered;
        else if (completeError?.code === "40001" && completeError.details === PACKAGE_RENDER_PROOF_CHANGE) throw unavailableRenderProof();
        else {
          throw new AppError(503, "Package completion is unconfirmed. Output files are retained; avoid starting another package until its status is resolved.");
        }
      }
      completionPersisted = true;
      reply.header("cache-control", "private, no-store");
      return reply.status(201).send(await hydratePackageJob(service, book.workspace_id, completedJob));
    } catch (error) {
      const refusedProof = error instanceof AppError && error.code === "package_render_proof_changed";
      if (!completionPersisted && (!completionAttempted || refusedProof)) {
        const fenced = await failPackageJob(service, jobId, refusedProof ? "package_render_proof_changed" : "package_failed").catch(() => false);
        // After dispatch the failure transition must win before removing objects.
        if ((!completionAttempted || fenced) && uploadedPaths.length) {
          try { await service.storage.from(BUCKET).remove(uploadedPaths); } catch { /* Private orphan recovery is separate. */ }
        }
        if (refusedProof && fenced) throw error;
      }
      if (completionAttempted && !completionPersisted) {
        throw new AppError(503, "Package completion is unconfirmed. Output files are retained; avoid starting another package until its status is resolved.");
      }
      if (error instanceof AppError) throw error;
      throw new AppError(503, "The publishing package could not be created.");
    }
  });

  app.get("/publishing/requests/:requestId", async (req, reply) => {
    assertPackageActor(req);
    const params = z.object({ requestId: z.guid() }).safeParse(req.params);
    const query = z.object({ bookId: z.guid() }).strict().safeParse(req.query);
    if (!params.success || !query.success) throw new AppError(422, "Invalid saved package request.");
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, query.data.bookId, req.userId);
    const job = await findPackageRequest(user, req.userId, book.id, params.data.requestId);
    if (job && requestJson(job).action !== "export_package") throw new AppError(409, "This request ID is not a retailer package request.");
    reply.header("cache-control", "private, no-store");
    return { requestId: params.data.requestId, job: job ? await hydratePackageJob(app.supabaseFactory(), book.workspace_id, job) : null };
  });

  app.post("/publishing/requests/close", { config: { durableIdempotency: true } }, async (req, reply) => {
    assertPackageActor(req);
    const parsed = packageRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "Invalid package request to close.");
    const body = parsed.data;
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, body.bookId, req.userId, true);
    const service = app.supabaseFactory();
    let job = await findPackageRequest(user, req.userId, body.bookId, body.idempotencyKey);
    if (!job) {
      const { data: edition, error: editionError } = await user.from("editions").select("id")
        .eq("id", body.editionId).eq("book_id", body.bookId).maybeSingle();
      if (editionError) throw new AppError(503, "The saved edition could not be checked.");
      if (!edition) throw new AppError(404, "Edition not found for this book.");
      // The existing unique request key arbitrates closure against a delayed
      // create. Never update a queued/running/accepted job or delete its files.
      const { data, error } = await service.from("publishing_jobs").insert({
        id: randomUUID(), book_id: body.bookId, edition_id: body.editionId, channel: body.channel,
        status: "cancelled", idempotency_key: body.idempotencyKey, created_by: req.userId,
        request_json: { action: "export_package", sourceRenderJobId: body.renderJobId, sourcePreflightJobId: body.preflightJobId },
        response_json: { error: "request_closed_before_acceptance" }, completed_at: new Date().toISOString(),
      }).select("*").single();
      if (error && error.code !== "23505") throw new AppError(503, "Closure was not confirmed. Recover the original package request.");
      job = error ? await findPackageRequest(user, req.userId, body.bookId, body.idempotencyKey) : data;
    }
    if (!job) throw new AppError(409, "That publishing request key is already in use.");
    assertPackageRequest(job, body);
    reply.header("cache-control", "private, no-store");
    return { requestId: body.idempotencyKey, job: await hydratePackageJob(service, book.workspace_id, job) };
  });

  app.get("/publishing/jobs", async (req, reply) => {
    const parsed = listPackageJobsSchema.safeParse(req.query);
    if (!parsed.success) throw new AppError(422, "Check the publishing history filters.", { issues: parsed.error.issues });
    const query = parsed.data;
    const user = app.supabaseFactory(req.userToken);
    const { book } = await loadBook(user, query.bookId, req.userId);
    // Filter before the limit: later validations or packages for another
    // edition/channel must not hide this book's saved package history.
    let listing = user.from("publishing_jobs").select("*")
      .eq("book_id", query.bookId).in("channel", retailerChannelSchema.options)
      .contains("request_json", { action: "export_package" });
    if (query.editionId) listing = listing.eq("edition_id", query.editionId);
    if (query.channel) listing = listing.eq("channel", query.channel);
    if (query.beforeCreatedAt && query.beforeId) {
      listing = listing.or(`created_at.lt.${query.beforeCreatedAt},and(created_at.eq.${query.beforeCreatedAt},id.lt.${query.beforeId})`);
    }
    const { data, error } = await listing.order("created_at", { ascending: false })
      .order("id", { ascending: false }).limit(query.limit + 1);
    if (error) throw new AppError(500, "Could not load publishing package history.");
    const jobs = (data ?? []).slice(0, query.limit);
    const last = jobs.at(-1);
    const nextCursor = last && data && data.length > query.limit ? { createdAt: last.created_at, id: last.id } : null;
    const service = app.supabaseFactory();
    reply.header("cache-control", "private, no-store");
    return { jobs: await Promise.all(jobs.map((job) => hydratePackageJob(service, book.workspace_id, job))), nextCursor };
  });

  app.get("/publishing/jobs/:jobId", async (req, reply) => {
    const parsed = z.object({ jobId: z.guid() }).safeParse(req.params);
    if (!parsed.success) throw new AppError(422, "Invalid publishing job id.");
    const user = app.supabaseFactory(req.userToken);
    const { data: job, error } = await user.from("publishing_jobs").select("*").eq("id", parsed.data.jobId).maybeSingle();
    if (error) throw new AppError(500, "Could not load the publishing job.");
    if (!job || requestJson(job).action !== "export_package") throw new AppError(404, "Publishing package job not found.");
    const { book } = await loadBook(user, job.book_id, req.userId);
    reply.header("cache-control", "private, no-store");
    return hydratePackageJob(app.supabaseFactory(), book.workspace_id, job);
  });

  async function loadCompletedPackage(user: SupabaseClient, jobId: string) {
    const { data: job, error } = await user.from("publishing_jobs")
      .select("id,book_id,edition_id,channel,status,request_json,response_json").eq("id", jobId).maybeSingle();
    if (error) throw new AppError(503, "The publishing package could not be verified.");
    if (!job || job.id !== jobId || job.status !== "succeeded" || requestJson(job).action !== "export_package"
      || !retailerChannelSchema.safeParse(job.channel).success) {
      throw new AppError(404, "Completed retailer package not found.");
    }
    return job;
  }

  app.get("/publishing/jobs/:jobId/preflight", async (req, reply) => {
    assertPackageActor(req);
    const path = submissionJobIdSchema.safeParse(req.params);
    if (!path.success) throw new AppError(422, "Invalid publishing job id.");
    const user = app.supabaseFactory(req.userToken);
    const job = await loadCompletedPackage(user, path.data.jobId);
    await loadBook(user, job.book_id, req.userId);
    const snapshot = requestJson(job);
    const source = z.object({ sourcePreflightJobId: z.guid(), sourceRenderJobId: z.guid(),
      editionUpdatedAt: z.string().min(1), bookModelSha256: sha256Schema, imageSha256: sha256Schema }).safeParse(snapshot);
    const unavailable = new AppError(404, "The preflight for this package could not be verified.");
    if (!source.success) throw unavailable;
    const { sourcePreflightJobId, sourceRenderJobId, ...fingerprint } = source.data;
    const { data: preflight, error } = await user.from("publishing_jobs")
      .select("id,book_id,edition_id,channel,status,request_json,response_json")
      .eq("id", sourcePreflightJobId).eq("book_id", job.book_id).eq("edition_id", job.edition_id).maybeSingle();
    if (error) throw new AppError(503, "The saved package preflight is temporarily unavailable.");
    if (!preflight || preflight.id !== sourcePreflightJobId) throw unavailable;
    try {
      assertSourceJob(preflight, { ...fingerprint, bookId: job.book_id, editionId: job.edition_id, action: "validate", channel: job.channel });
    } catch (reason) {
      if (reason instanceof AppError && reason.status === 422) throw unavailable;
      throw reason;
    }
    const report = readPackagePreflight(preflight, job.channel);
    const proof = report?.sourcePrint ?? report?.sourceEpub;
    if (!report || report.channel !== job.channel || (proof && proof.jobId !== sourceRenderJobId)) throw unavailable;
    reply.header("cache-control", "private, no-store");
    return { packageJobId: job.id, preflightJobId: preflight.id, ruleVersion: report.ruleVersion,
      warnings: report.warnings, findings: report.findings };
  });

  // The listing may require reading a large private ZIP. Keep one such
  // operation in flight per API instance, independently of package creation.
  let readingListing = false;
  app.get("/publishing/jobs/:jobId/listing", async (req, reply) => {
    assertPackageActor(req);
    const path = submissionJobIdSchema.safeParse(req.params);
    const query = z.object({ checksum: sha256Schema }).strict().safeParse(req.query);
    if (!path.success || !query.success) throw new AppError(422, "The package and its checksum are required.");
    const user = app.supabaseFactory(req.userToken);
    const job = await loadCompletedPackage(user, path.data.jobId);
    const { book } = await loadBook(user, job.book_id, req.userId);
    if (readingListing) throw new AppError(503, "The listing reader is busy. Try again shortly.");
    readingListing = true;
    try {
      const signal = AbortSignal.timeout(90_000);
      const service = app.supabaseFactory(undefined, boundedSupabaseFetch(signal, fetch, 200 * 1024 * 1024));
      const verified = await verifyPackageArtifact(service, book.workspace_id, job);
      if (!verified || verified.descriptor.checksum.toLowerCase() !== query.data.checksum) {
        throw new AppError(404, "The saved package is unavailable.");
      }
      const descriptor = verified.descriptor;
      const { data, error } = await service.storage.from(BUCKET).download(descriptor.storagePath);
      if (error || !data || data.size !== descriptor.sizeBytes) throw new AppError(409, "The saved package could not be verified.");
      const bytes = Buffer.from(await data.arrayBuffer());
      if (createHash("sha256").update(bytes).digest("hex") !== query.data.checksum) {
        throw new AppError(409, "The saved package could not be verified.");
      }
      const metadata = readPackageListing(bytes);
      if (!metadata) throw new AppError(404, "This package has no readable saved listing.");
      await loadBook(user, job.book_id, req.userId);
      if (!await verifyPackageArtifact(service, book.workspace_id, job)) throw new AppError(404, "The saved package is unavailable.");
      signal.throwIfAborted();
      reply.header("cache-control", "private, no-store");
      return { packageJobId: job.id, packageSha256: query.data.checksum, metadata };
    } finally { readingListing = false; }
  });

  app.get("/publishing/jobs/:jobId/submission", async (req, reply) => {
    const path = submissionJobIdSchema.safeParse(req.params);
    if (!path.success) throw new AppError(422, "Invalid publishing job id.");
    const { jobId } = path.data;
    const user = app.supabaseFactory(req.userToken);
    const job = await loadCompletedPackage(user, jobId);
    const { data, error } = await user.from("retailer_submissions")
      .select("publishing_job_id,status,revision,updated_at").eq("publishing_job_id", jobId).maybeSingle();
    if (error) throw new AppError(503, "Retailer submission status is unavailable.");
    await loadBook(user, job.book_id, req.userId);
    reply.header("cache-control", "private, no-store");
    return { submission: data === null ? null : submissionResult(data, jobId) };
  });

  app.put("/publishing/jobs/:jobId/submission", async (req, reply) => {
    const path = submissionJobIdSchema.safeParse(req.params);
    const body = submissionUpdateSchema.safeParse(req.body);
    if (!path.success || !body.success) throw new AppError(422, "Check the retailer package and status.");
    const { jobId } = path.data;
    const { status, expectedRevision } = body.data;
    const user = app.supabaseFactory(req.userToken);
    const { data, error } = await user.rpc("save_retailer_submission", {
      p_job_id: jobId,
      p_status: status,
      p_expected_revision: expectedRevision,
    });
    if (error?.code === "PT404") throw new AppError(404, "Completed retailer package not found.");
    if (error?.code === "42501") throw new AppError(403, "Your workspace role cannot update submission status.");
    if (error?.code === "PT409") throw new AppError(409, "Submission status changed. Check the saved status.");
    if (error) throw new AppError(503, "Retailer submission status is unavailable.");
    const row = Array.isArray(data) && data.length === 1 ? data[0] : data;
    const submission = submissionResult(row, jobId);
    if (submission.status !== status || submission.revision === expectedRevision) {
      throw new AppError(503, "The saved submission status could not be verified.");
    }
    reply.header("cache-control", "private, no-store");
    return { submission };
  });

  app.route({
    method: ["GET", "PUT"],
    url: "/publishing/jobs/:jobId/managed-request",
    handler: async (req, reply) => {
      const path = submissionJobIdSchema.safeParse(req.params);
      if (!path.success || req.headers["x-bookworm-actor"] !== req.userId) {
        throw new AppError(422, "The package and original account are required.");
      }
      const { jobId } = path.data;
      const user = app.supabaseFactory(req.userToken);
      const job = await loadCompletedPackage(user, jobId);
      const { book, role } = await loadBook(user, job.book_id, req.userId);
      if (role !== "owner" && role !== "admin") throw new AppError(403, "Only a workspace owner or admin can manage this request.");

      reply.header("cache-control", "private, no-store");
      if (req.method === "GET") {
        const { data, error } = await user.from("managed_publishing_requests")
          .select("package_job_id,workspace_id,requested_by,package_sha256,requested_at,withdrawn_at,claimed_by,claimed_at,confirmed_at,listing_url").eq("package_job_id", jobId).maybeSingle();
        if (error) throw new AppError(503, "The managed publishing request is unavailable.");
        return { request: data === null ? null : managedPublishingResult(data, jobId, book.workspace_id) };
      }

      const body = managedPublishingBodySchema.safeParse(req.body);
      if (!body.success) throw new AppError(422, "The reviewed package checksum is required.");
      if (!body.data.withdraw && process.env.MANAGED_PUBLISHING_ENABLED !== "true") {
        throw new AppError(404, "Managed publishing is currently unavailable.");
      }
      const consent = { p_job_id: jobId, p_sha256: body.data.packageSha256 };
      const { data, error } = await (body.data.withdraw
        ? user.rpc("withdraw_managed_publishing", consent)
        : app.supabaseFactory().rpc("request_managed_publishing", { ...consent, p_actor: req.userId }));
      if (error?.code === "PT404") throw new AppError(404, "Completed retailer package not found.");
      if (error?.code === "42501") throw new AppError(403, "This account cannot request managed publishing.");
      if (error?.code === "PT409") throw new AppError(409, "The reviewed package or its saved request changed. Check the saved request.");
      if (error) throw new AppError(503, "The managed publishing request is unavailable.");
      const row = Array.isArray(data) && data.length === 1 ? data[0] : data;
      const request = managedPublishingResult(row, jobId, book.workspace_id);
      if (request.packageSha256 !== body.data.packageSha256
        || (body.data.withdraw ? !request.withdrawnAt : request.requestedBy !== req.userId)) {
        throw new AppError(503, "The managed publishing request could not be verified.");
      }
      return { request };
    },
  });
}
