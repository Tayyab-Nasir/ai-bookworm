/** Operator-invoked, unregistered service-only maintenance scan. Discovery is
 * advisory. Reconcile can release an expired/exhausted undispatched job under
 * database locks; receipt recovery only settles an existing validated receipt.
 * Neither operation sends to a provider. No timer, route or credentials here.
 */
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import type { customerAiComposition } from "./customer-ai-composition.js";

const id = z.string().uuid().regex(/^[0-9a-f-]+$/u);
const timestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u);
const row = z.object({ job_id: id, created_at: timestamp,
  action: z.enum(["none", "investigate", "review", "reconcile", "receipt_available"]) }).strict();
const reconcileResult = z.object({ state: z.enum(["settled", "released", "requires_review", "unchanged"]), suppressionCleared: z.boolean() }).strict();
const receiptResult = z.object({ state: z.literal("settled"), suppressionCleared: z.boolean() }).strict();
type Runtime = Pick<ReturnType<typeof customerAiComposition>, "reconcile" | "recoverReceipt">;
type Cursor = { createdAt: string; jobId: string };
type Event = { jobId: string; status: "investigate" | "review" | "unconfirmed" | "unchanged" | "settled" | "released" };

// Caller supplies a service-role client with SDK retries disabled and owns its
// lifetime; do not expose this controller to a browser or construct it from env.
export function customerAiReconciliationScan(sb: SupabaseClient, runtime: Runtime, options: { pageSize?: number } = {}) {
  const limit = options.pageSize ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !runtime
    || typeof runtime.reconcile !== "function" || typeof runtime.recoverReceipt !== "function") {
    throw new Error("Customer AI maintenance configuration is invalid.");
  }
  let cursor: Cursor | undefined, active: Promise<unknown> | undefined, closed = false;
  const uncertain = new Set<string>();
  return {
    /** Explicit operator decision to revisit a prior unconfirmed DB operation.
     * This only permits a later scan; it does not dispatch or alter a job.
     */
    acknowledgeForExplicitReplay(jobId: string): boolean {
      if (closed || active || !id.safeParse(jobId).success) throw new Error("Customer AI maintenance is unavailable.");
      return uncertain.delete(jobId);
    },
    async scan(signal?: AbortSignal): Promise<{ scanned: number; events: Event[]; cycleComplete: boolean }> {
      if (closed) throw new Error("Customer AI maintenance is closed.");
      if (active) throw new Error("Customer AI maintenance is already running.");
      if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("Customer AI maintenance is unavailable.");
      if (signal?.aborted) return { scanned: 0, events: [], cycleComplete: false };
      const perform = async () => {
        const response = await sb.rpc("discover_customer_ai_reconciliation_candidates", {
          p_limit: limit, p_after_created_at: cursor?.createdAt ?? null, p_after_job_id: cursor?.jobId ?? null,
        }).abortSignal(AbortSignal.any([AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]));
        if (signal?.aborted || closed) return { scanned: 0, events: [], cycleComplete: false };
        if (response.error) throw new Error();
        const rows = z.array(row).max(limit).parse(response.data);
        if (new Set(rows.map(item => item.job_id)).size !== rows.length
          || rows.some(item => item.job_id === cursor?.jobId && item.created_at === cursor.createdAt)) throw new Error();
        let scanned = 0; const events: Event[] = [];
        for (const item of rows) {
          if (signal?.aborted || closed) return { scanned, events, cycleComplete: false };
          if (uncertain.has(item.job_id)) events.push({ jobId: item.job_id, status: "unconfirmed" });
          else if (item.action === "investigate" || item.action === "review") events.push({ jobId: item.job_id, status: item.action });
          else if (item.action === "reconcile" || item.action === "receipt_available") {
            if (uncertain.size >= 1024) throw new Error("review required");
            try {
              const result = item.action === "reconcile"
                ? reconcileResult.parse(await runtime.reconcile(item.job_id, signal))
                : receiptResult.parse(await runtime.recoverReceipt(item.job_id, signal));
              const status = result.state === "requires_review" ? "review" : result.state;
              events.push({ jobId: item.job_id, status });
            } catch {
              uncertain.add(item.job_id);
              events.push({ jobId: item.job_id, status: "unconfirmed" });
            }
          }
          cursor = { createdAt: item.created_at, jobId: item.job_id }; scanned++;
        }
        const cycleComplete = rows.length < limit;
        if (cycleComplete) cursor = undefined;
        return { scanned, events, cycleComplete };
      };
      const operation = perform(); active = operation;
      try { return await operation; }
      catch { throw new Error("Customer AI maintenance is unavailable."); }
      finally { if (active === operation) active = undefined; }
    },
    async close(): Promise<void> {
      closed = true;
      try { await active; } catch { /* scan caller receives its own failure */ }
    },
  };
}
