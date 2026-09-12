import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";
import { createHttpAssetScanner, type AssetMalwareScanner } from "./asset-scanner.js";
import { executeManuscriptImport } from "./manuscript-import.js";

// Public job responses deliberately exclude source checksums and lease tokens.
export const importJobSchema = z.object({
  id: z.string().uuid(), book_id: z.string().uuid(), source_asset_id: z.string().uuid(),
  status: z.enum(["queued", "running", "succeeded", "failed"]), attempts: z.number().int().min(0).max(5),
  error_code: z.string().regex(/^[a-z][a-z0-9_]{0,79}$/).nullable(),
  created_at: z.string(), available_at: z.string(), completed_at: z.string().nullable(),
});
const claimSchema = importJobSchema.extend({ created_by: z.string().uuid(),
  source_checksum: z.string().regex(/^[a-f0-9]{64}$/), lease_token: z.string().uuid() });
const row = (value: unknown) => Array.isArray(value) ? value[0] : value;
export type DocumentWorkerOutcome = { status: "idle" | "succeeded" | "queued" | "failed" | "lease_lost" | "completion_unknown"; jobId?: string };

export async function runOneDocumentJob(sb: SupabaseClient, options: {
  leaseSeconds?: number; fetcher?: typeof fetch; scanner?: AssetMalwareScanner;
  execute?: typeof executeManuscriptImport;
} = {}): Promise<DocumentWorkerOutcome> {
  const leaseSeconds = options.leaseSeconds ?? 180;
  const claimed = await sb.rpc("claim_manuscript_import", { p_lease_seconds: leaseSeconds });
  if (claimed.error) throw new Error("document_claim_failed");
  if (!row(claimed.data)) return { status: "idle" };
  const job = claimSchema.parse(row(claimed.data));
  const abort = new AbortController();
  let renewal: Promise<void> | undefined;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = (async () => {
      try {
        const renewed = await sb.rpc("renew_manuscript_import_lease", {
          p_job_id: job.id, p_lease_token: job.lease_token, p_lease_seconds: leaseSeconds,
        });
        if (renewed.error || renewed.data !== true) abort.abort();
      } catch { abort.abort(); }
    })().finally(() => { renewal = undefined; });
  }, Math.floor(leaseSeconds * 1000 / 3));
  heartbeat.unref();
  try {
    await (options.execute ?? executeManuscriptImport)({ sb, service: sb, scanner: options.scanner ?? createHttpAssetScanner(),
      bookId: job.book_id, actorId: job.created_by, assetId: job.source_asset_id,
      expectedChecksum: job.source_checksum, lease: { jobId: job.id, token: job.lease_token },
      signal: abort.signal, fetcher: options.fetcher });
    abort.signal.throwIfAborted();
    // If a prior/synchronous attempt already saved the receipt, finish the job
    // through the same fenced transaction. No parser or asset writes repeat.
    const completed = await sb.rpc("complete_leased_manuscript_import", {
      p_job_id: job.id, p_lease_token: job.lease_token, p_chapters: [], p_images: [], p_report: {},
    });
    if (completed.error || !completed.data) throw new AppError(503, "document_completion_unknown");
    return { status: "succeeded", jobId: job.id };
  } catch (error) {
    // Always read after errors: a lost commit reply can follow durable success.
    // Do not delete private objects or fail an unverified commit outcome.
    let state;
    try { state = await sb.from("manuscript_import_jobs").select("status,lease_token").eq("id", job.id).maybeSingle(); }
    catch { return { status: "completion_unknown", jobId: job.id }; }
    if (state.error || !state.data) return { status: "completion_unknown", jobId: job.id };
    if (state.data.status === "succeeded") return { status: "succeeded", jobId: job.id };
    if (abort.signal.aborted || state.data.status !== "running" || state.data.lease_token !== job.lease_token) return { status: "lease_lost", jobId: job.id };
    const retryable = !(error instanceof AppError) || error.status >= 500;
    const failed = await sb.rpc("fail_manuscript_import", { p_job_id: job.id, p_lease_token: job.lease_token,
      p_error_code: retryable ? "document_dependency_unavailable" : "document_source_rejected", p_retryable: retryable });
    if (failed.error?.code === "40001") return { status: "lease_lost", jobId: job.id };
    if (failed.error || !row(failed.data)) throw new Error("document_failure_persistence_failed");
    return { status: row(failed.data).status === "queued" ? "queued" : "failed", jobId: job.id };
  } finally {
    clearInterval(heartbeat);
    await renewal;
  }
}
