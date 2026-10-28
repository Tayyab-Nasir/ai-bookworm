/** Explicitly invoked customer-key queue scan. No launcher, timer or provider
 * configuration is installed here. Discovery is advisory; the worker's claim
 * and one-way resolver remain the authority for every job.
 */
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import type { CustomerAiOutcome } from "./customer-ai-worker.js";

const id = z.string().uuid().regex(/^[0-9a-f-]+$/u);
// Keep the exact database string: Date truncates PostgreSQL microseconds.
const timestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u);
const row = z.object({ job_id: id, created_at: timestamp, ready: z.boolean() }).strict();
type Cursor = { createdAt: string; jobId: string };
type Worker = { run(jobId: string, signal?: AbortSignal): Promise<CustomerAiOutcome> };
const reconciliation = z.object({ jobId: id, state: z.enum([
  "settled", "released", "undispatched_safe_to_retry", "undispatched_exhausted", "in_flight", "dispatched", "unknown",
]) }).strict();
// This seam is deliberately injected and unregistered. A production adapter
// must use a narrowly scoped, service-only database RPC with locked, durable
// evidence; an arbitrary callback is not authority to retry or release work.
type Reconcile = (jobId: string, signal: AbortSignal) => Promise<unknown>;
class SchedulerReviewRequired extends Error {
  constructor() { super("Customer AI scheduler requires outcome review."); }
}

export function customerAiScheduler(sb: SupabaseClient, worker: Worker, options: { pageSize?: number; reconcile?: Reconcile } = {}) {
  const pageSize = options.pageSize ?? 20;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !worker || typeof worker.run !== "function") {
    throw new Error("Customer AI scheduler configuration is invalid.");
  }
  let cursor: Cursor | undefined;
  let running = false;
  // Unknown outcomes are never automatically dispatched again in this instance.
  // Fail closed on saturation instead of evicting uncertain identities.
  const uncertain = new Set<string>();
  return {
    /** Explicit review only; never mutates a job, refunds or calls the worker.
     * The next normal tick still relies on discovery and the atomic DB claim.
     */
    async reconcile(jobId: string, input: { allowUndispatchedRetry?: boolean; signal?: AbortSignal } = {}) {
      if (running) throw new Error("Customer AI scheduler is already running.");
      if (!id.safeParse(jobId).success || !options.reconcile
        || (input.allowUndispatchedRetry !== undefined && typeof input.allowUndispatchedRetry !== "boolean")) {
        throw new Error("Customer AI reconciliation is unavailable.");
      }
      if (input.signal?.aborted) throw new Error("Customer AI reconciliation is unavailable.");
      running = true;
      const deadline = AbortSignal.any([AbortSignal.timeout(15_000), ...(input.signal ? [input.signal] : [])]);
      let stopWaiting: (() => void) | undefined;
      try {
        const interrupted = new Promise<never>((_, reject) => {
          stopWaiting = () => reject(new Error());
          deadline.addEventListener("abort", stopWaiting, { once: true });
          if (deadline.aborted) stopWaiting();
        });
        const evidence = reconciliation.parse(await Promise.race([options.reconcile(jobId, deadline), interrupted]));
        if (deadline.aborted || evidence.jobId !== jobId) throw new Error();
        const cleared = evidence.state === "settled" || evidence.state === "released"
          || (evidence.state === "undispatched_safe_to_retry" && input.allowUndispatchedRetry === true);
        const wasSuppressed = cleared && uncertain.delete(jobId);
        return { state: evidence.state, suppressionCleared: wasSuppressed };
      } catch {
        throw new Error("Customer AI reconciliation is unavailable.");
      } finally {
        if (stopWaiting) deadline.removeEventListener("abort", stopWaiting);
        running = false;
      }
    },
    async tick(signal?: AbortSignal): Promise<{ scanned: number; attempted: number; uncertain: number; suppressed: number; cycleComplete: boolean }> {
      if (running) throw new Error("Customer AI scheduler is already running.");
      if (signal?.aborted) return { scanned: 0, attempted: 0, uncertain: 0, suppressed: 0, cycleComplete: false };
      if (uncertain.size >= 1024) throw new SchedulerReviewRequired();
      running = true;
      try {
        const response = await sb.rpc("discover_customer_ai_ready_jobs", {
          p_limit: pageSize, p_after_created_at: cursor?.createdAt ?? null, p_after_job_id: cursor?.jobId ?? null,
        }).abortSignal(AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]));
        if (signal?.aborted) return { scanned: 0, attempted: 0, uncertain: 0, suppressed: 0, cycleComplete: false };
        if (response.error) throw new Error();
        const rows = z.array(row).max(pageSize).parse(response.data);
        if (new Set(rows.map(item => item.job_id)).size !== rows.length
          || rows.some(item => item.job_id === cursor?.jobId && item.created_at === cursor.createdAt)) throw new Error();
        let scanned = 0, attempted = 0, uncertainCount = 0, suppressed = 0;
        for (const item of rows) {
          if (signal?.aborted) return { scanned, attempted, uncertain: uncertainCount, suppressed, cycleComplete: false };
          if (item.ready && uncertain.has(item.job_id)) suppressed++;
          if (item.ready && !uncertain.has(item.job_id)) {
            if (uncertain.size >= 1024) throw new SchedulerReviewRequired();
            attempted++;
            try {
              const outcome = await worker.run(item.job_id, signal);
              if (outcome.jobId !== item.job_id || !["unavailable", "preparation_failed", "succeeded", "requires_review", "completion_unknown"].includes(outcome.status)) throw new Error();
              if (outcome.status === "requires_review" || outcome.status === "completion_unknown") { uncertain.add(item.job_id); uncertainCount++; }
            } catch { uncertain.add(item.job_id); uncertainCount++; }
          }
          cursor = { createdAt: item.created_at, jobId: item.job_id };
          scanned++;
        }
        const cycleComplete = rows.length < pageSize;
        if (cycleComplete) cursor = undefined;
        return { scanned, attempted, uncertain: uncertainCount, suppressed, cycleComplete };
      } catch (error) {
        if (error instanceof SchedulerReviewRequired) throw error;
        // No response bodies, secrets, manuscript text or raw upstream errors.
        throw new Error("Customer AI scheduler is unavailable.");
      } finally { running = false; }
    },
  };
}
