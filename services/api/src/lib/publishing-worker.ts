import { randomUUID } from "node:crypto";
import { z } from "zod";
import { AppError } from "../errors.js";
import { assembleBookModel, bookModelFingerprint, loadBook } from "./authoring.js";
import { currentEntitlements } from "./entitlements.js";
import type { SupabaseClient } from "./supabase.js";
import { decodeArtifact, decodeRenderedCover, editionConfigSchema, loadRenderImages, renderResponseSchema } from "../routes/editions.js";
import {
  assertSourceJob, decodePackage, loadRenderedPackageInputs, packageServiceResponseSchema,
  preflightResponseSchema, storedPreflightResponseSchema,
} from "../routes/publishing.js";

export const publishingActions = ["render", "validate", "export_package"] as const;
export type PublishingAction = typeof publishingActions[number];
const jobSchema = z.object({
  id: z.string().uuid(), book_id: z.string().uuid(), edition_id: z.string().uuid(),
  created_by: z.string().uuid(), channel: z.string(), lease_token: z.string().uuid(),
  request_json: z.object({
    action: z.enum(publishingActions), editionUpdatedAt: z.string().datetime({ offset: true }),
    bookModelSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    sourceRenderJobId: z.string().uuid().optional(), sourcePreflightJobId: z.string().uuid().optional(),
  }),
}).passthrough();
type Job = z.infer<typeof jobSchema>;
const BUCKET = "book-assets";

export class WorkerFailure extends Error {
  constructor(readonly code: string, readonly retryable: boolean) { super(code); }
}

function row(value: unknown): Record<string, unknown> | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  return candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : null;
}

export async function loadPublishingInputs(sb: SupabaseClient, job: Job) {
  const { book } = await loadBook(sb, job.book_id, job.created_by, true);
  const { data: edition, error } = await sb.from("editions").select("*")
    .eq("id", job.edition_id).eq("book_id", job.book_id).maybeSingle();
  if (error) throw new WorkerFailure("worker_database_unavailable", true);
  const parsed = editionConfigSchema.safeParse(edition?.edition_metadata_json);
  if (!edition || !parsed.success || parsed.data.kind !== edition.type
    || Date.parse(edition.updated_at) !== Date.parse(job.request_json.editionUpdatedAt)) {
    throw new WorkerFailure("worker_edition_changed", false);
  }
  const config = parsed.data;
  if (config.kind === "audiobook") throw new WorkerFailure("worker_invalid_channel", false);
  const formatChannels: Record<string, readonly string[]> = {
    render: ["ebook", "print"], export: ["ebook", "print"], kdp: ["ebook", "print"],
    apple: ["ebook"], barnesnoble: ["ebook", "print"], lulu: ["print"],
  };
  if (!formatChannels[job.channel]?.includes(config.kind)
    || (job.request_json.action === "render" ? job.channel !== "render" : job.channel === "render")
    || (job.request_json.action === "export_package" && job.channel === "export")) {
    throw new WorkerFailure("worker_invalid_channel", false);
  }
  const { data: workspace, error: workspaceError } = await sb.from("workspaces").select("organization_id")
    .eq("id", book.workspace_id).maybeSingle();
  if (workspaceError) throw new WorkerFailure("worker_database_unavailable", true);
  if (!workspace) throw new WorkerFailure("worker_workspace_missing", false);
  const { entitlements } = await currentEntitlements(sb, workspace.organization_id);
  if (job.request_json.action === "export_package") {
    const entitlement = { kdp: "kdp", apple: "apple_books", barnesnoble: "barnes_noble", lulu: "lulu" }[job.channel];
    if (!entitlement || !entitlements.publishing_channels.includes(entitlement)) throw new WorkerFailure("worker_plan_changed", false);
  } else if (entitlements.rendering !== true) throw new WorkerFailure("worker_plan_changed", false);
  const model = await assembleBookModel(sb, book);
  if (bookModelFingerprint(model) !== job.request_json.bookModelSha256) throw new WorkerFailure("worker_book_changed", false);
  return { book, config, model };
}

async function serviceRequest(fetcher: typeof fetch, kind: "RENDERING" | "PUBLISHING", path: string,
  body: unknown, maxBytes: number, signal: AbortSignal) {
  const url = (process.env[`${kind}_SERVICE_URL`] ?? `http://127.0.0.1:${process.env[`${kind}_SERVICE_PORT`] ?? (kind === "RENDERING" ? "8002" : "8003")}`).replace(/\/$/u, "");
  const token = process.env[`${kind}_SERVICE_TOKEN`] || process.env.SERVICE_AUTH_TOKEN;
  const response = await fetcher(`${url}${path}`, {
    method: "POST", headers: { "content-type": "application/json", ...(token ? { "x-service-token": token } : {}) },
    body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(150_000)]),
  });
  if (response.status === 422) throw new WorkerFailure("worker_service_rejected_input", false);
  if (!response.ok) throw new WorkerFailure("worker_service_unavailable", true);
  if (Number(response.headers.get("content-length")) > maxBytes) throw new WorkerFailure("worker_response_too_large", false);
  if (!response.body) throw new WorkerFailure("worker_invalid_response", true);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > maxBytes) {
        await reader.cancel();
        throw new WorkerFailure("worker_response_too_large", false);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown; }
  catch { throw new WorkerFailure("worker_invalid_response", true); }
}

// This builds actual outputs; status is written only by the fenced SQL wrapper.
export async function buildPublishingOutput(sb: SupabaseClient, job: Job, fetcher: typeof fetch,
  signal: AbortSignal, uploadedPaths: string[]) {
  const { book, config, model } = await loadPublishingInputs(sb, job);
  const artifacts: Record<string, unknown>[] = [];
  async function upload(bytes: Buffer, filename: string, type: string, role: string, mimeType: string, checksum: string) {
    signal.throwIfAborted();
    const assetId = randomUUID();
    const storagePath = `workspaces/${book.workspace_id}/assets/${assetId}/v1/${filename}`;
    const { error } = await sb.storage.from(BUCKET).upload(storagePath, bytes, { contentType: mimeType, upsert: false });
    if (error) throw new WorkerFailure("worker_storage_unavailable", true);
    uploadedPaths.push(storagePath);
    signal.throwIfAborted();
    const artifact = {
      assetId, storagePath, filename, type, role, name: `${String(book.title).slice(0, 220)} ${filename}`,
      mimeType, sizeBytes: bytes.length, checksum: checksum.toLowerCase(),
    };
    artifacts.push(artifact);
    return artifact;
  }
  if (job.request_json.action === "export_package") {
    const { sourceRenderJobId, sourcePreflightJobId } = job.request_json;
    if (!sourceRenderJobId || !sourcePreflightJobId) throw new WorkerFailure("worker_invalid_source_jobs", false);
    const [render, preflight] = await Promise.all([
      sb.from("publishing_jobs").select("*").eq("id", sourceRenderJobId).maybeSingle(),
      sb.from("publishing_jobs").select("*").eq("id", sourcePreflightJobId).maybeSingle(),
    ]);
    if (render.error || preflight.error) throw new WorkerFailure("worker_database_unavailable", true);
    const source = { bookId: job.book_id, editionId: job.edition_id,
      editionUpdatedAt: job.request_json.editionUpdatedAt, bookModelSha256: job.request_json.bookModelSha256 };
    assertSourceJob(render.data, { ...source, action: "render", channel: "render" });
    assertSourceJob(preflight.data, { ...source, action: "validate", channel: job.channel });
    const validation = storedPreflightResponseSchema.safeParse(preflight.data?.response_json);
    if (!validation.success || validation.data.errors !== 0 || validation.data.requestedChannel !== job.channel) {
      throw new WorkerFailure("worker_preflight_failed", false);
    }
    const artifactsBase64 = await loadRenderedPackageInputs(sb, book.workspace_id, config.kind, render.data!);
    const raw = await serviceRequest(fetcher, "PUBLISHING", "/v1/publishing/package",
      { channel: job.channel, editionConfig: config, bookModel: model, artifactsBase64 }, 280_000_000, signal);
    const parsed = packageServiceResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.channel !== job.channel || parsed.data.packages[0].path !== `${job.channel}-export.zip`) {
      throw new WorkerFailure("worker_invalid_response", true);
    }
    const pkg = parsed.data.packages[0];
    const artifact = await upload(decodePackage(pkg.dataBase64, pkg.sha256), pkg.path, "publishing_package", "publishing_package", "application/zip", pkg.sha256);
    return { artifact, ruleVersion: parsed.data.ruleVersion };
  }
  const images = await loadRenderImages(sb, book.workspace_id, model.assets.map((a) => a.id), config.cover.asset_id);
  if (job.request_json.action === "validate") {
    const raw = await serviceRequest(fetcher, "RENDERING", "/preflight", {
      editionConfig: config, bookModel: model, channel: job.channel === "export" ? null : job.channel, includeArtifact: true, ...images,
    }, 2_000_000, signal);
    const parsed = preflightResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.channel !== (job.channel === "export" ? null : job.channel)) throw new WorkerFailure("worker_invalid_response", true);
    return { ...parsed.data, requestedChannel: job.channel };
  }
  const raw = await serviceRequest(fetcher, "RENDERING", "/render", { editionConfig: config, bookModel: model, ...images }, 220_000_000, signal);
  const parsed = renderResponseSchema.safeParse(raw);
  const format = config.kind === "ebook" ? "epub" : "pdf";
  if (!parsed.success || parsed.data.format !== format) throw new WorkerFailure("worker_invalid_response", true);
  const rendered = parsed.data;
  const decodedCover = decodeRenderedCover(config, rendered);
  const primary = decodeArtifact(rendered.artifactBase64, rendered.sha256, 150 * 1024 * 1024,
    Buffer.from(format === "epub" ? "PK" : "%PDF-"), format);
  await upload(primary, `book.${format}`, "rendered_book", config.kind === "ebook" ? "rendered_ebook" : "rendered_print",
    format === "epub" ? "application/epub+zip" : "application/pdf", rendered.sha256);
  if (decodedCover) {
    await upload(decodedCover.bytes, decodedCover.filename, "rendered_cover", "rendered_cover", decodedCover.mimeType, decodedCover.checksum);
  }
  return { artifacts, rendererVersion: rendered.rendererVersion, usage: {
    renderedBytes: artifacts.reduce((total, artifact) => total + Number(artifact.sizeBytes), 0), illustrationCount: model.assets.length,
  } };
}

export type WorkerOutcome = { status: "idle" | "succeeded" | "queued" | "failed" | "lease_lost" | "completion_unknown"; jobId?: string };

export async function runOnePublishingJob(sb: SupabaseClient, options: {
  actions?: PublishingAction[]; leaseSeconds?: number; fetcher?: typeof fetch;
} = {}): Promise<WorkerOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 180;
  const { data, error } = await sb.rpc("claim_publishing_job", {
    p_actions: options.actions ?? [...publishingActions], p_lease_seconds: leaseSeconds,
  });
  if (error) throw new WorkerFailure("worker_claim_failed", true);
  const claimed = row(data);
  if (!claimed) return { status: "idle" };
  const jobId = String(claimed.id);
  const token = String(claimed.lease_token);
  const abort = new AbortController();
  let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = (async () => {
      try {
        const result = await sb.rpc("renew_publishing_job_lease", { p_job_id: jobId, p_lease_token: token, p_lease_seconds: leaseSeconds });
        if (result.error || result.data !== true) abort.abort(new WorkerFailure("worker_lease_lost", true));
      } catch { abort.abort(new WorkerFailure("worker_lease_lost", true)); }
    })().finally(() => { renewal = undefined; });
  }, Math.floor(leaseSeconds * 1000 / 3));
  heartbeat.unref();
  const uploadedPaths: string[] = [];
  let completionAttempted = false;
  try {
    const parsed = jobSchema.safeParse(claimed);
    if (!parsed.success) throw new WorkerFailure("worker_invalid_input", false);
    const output = await buildPublishingOutput(sb, parsed.data, options.fetcher ?? fetch, abort.signal, uploadedPaths);
    // A long renderer call must not publish a stale current-edition result.
    await loadPublishingInputs(sb, parsed.data);
    abort.signal.throwIfAborted();
    completionAttempted = true;
    const completed = await sb.rpc("complete_leased_publishing_job", { p_job_id: jobId, p_lease_token: token, p_result: output });
    if (completed.error || row(completed.data)?.status !== "succeeded") {
      throw new WorkerFailure(completed.error?.code === "40001" ? "worker_lease_lost" : "worker_completion_failed", true);
    }
    return { status: "succeeded", jobId };
  } catch (error) {
    if (completionAttempted) {
      // A lost HTTP reply may follow a committed transaction. Never remove its
      // objects unless a subsequent authoritative read proves they are unused.
      try {
        const recovered = await sb.from("publishing_jobs").select("status,lease_token,response_json").eq("id", jobId).maybeSingle();
        if (recovered.error || !recovered.data) return { status: "completion_unknown", jobId };
        if (recovered.data.status === "succeeded" && recovered.data.lease_token === token) return { status: "succeeded", jobId };
      } catch { return { status: "completion_unknown", jobId }; }
    }
    if (uploadedPaths.length) {
      // Paths contain fresh random IDs per attempt; another lease never shares them.
      try { await sb.storage.from(BUCKET).remove(uploadedPaths); } catch { /* Private orphan cleanup is operational maintenance. */ }
    }
    if (abort.signal.aborted || (error instanceof WorkerFailure && error.code === "worker_lease_lost")) return { status: "lease_lost", jobId };
    const failure = error instanceof WorkerFailure ? error
      : error instanceof AppError ? new WorkerFailure(error.status < 500 ? "worker_input_rejected" : "worker_dependency_failed", error.status >= 500)
        : new WorkerFailure("worker_execution_failed", true);
    const failed = await sb.rpc("fail_leased_publishing_job", {
      p_job_id: jobId, p_lease_token: token, p_error_code: failure.code, p_retryable: failure.retryable,
    });
    if (failed.error?.code === "40001") return { status: "lease_lost", jobId };
    if (failed.error || !row(failed.data)) throw new WorkerFailure("worker_failure_persistence_failed", true);
    return { status: row(failed.data)!.status === "queued" ? "queued" : "failed", jobId };
  } finally {
    clearInterval(heartbeat);
    await renewal;
  }
}
