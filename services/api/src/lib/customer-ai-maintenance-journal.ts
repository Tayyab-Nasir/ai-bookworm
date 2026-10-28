/** Explicit service-only journal client. The caller must durably persist the
 * exact attempt/job/action identity before begin; this factory does not provide
 * storage, scheduling, automatic retries, a launcher, or provider dispatch.
 */
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { boundedSupabaseFetch, type SupabaseClient } from "./supabase.js";

const id = z.string().uuid().regex(/^[0-9a-f-]+$/u);
const identity = z.object({ attemptId: id, jobId: id, action: z.enum(["reconcile", "recover_receipt"]) }).strict();
const receipt = identity.extend({ state: z.enum(["pending", "completed", "needs_review"]),
  result: z.enum(["unchanged", "settled", "released", "requires_review"]).nullable() }).strict().refine(value =>
  value.state === "completed" ? value.result !== null && (value.action !== "recover_receipt" || value.result === "settled") : value.result === null);
export type CustomerAiMaintenanceIdentity = z.infer<typeof identity>;
type JournalOutcome = { status: "confirmed"; receipt: z.infer<typeof receipt> } | { status: "unknown"; identity: CustomerAiMaintenanceIdentity };

// An injected client is trusted internal composition only; its owner must
// enforce service-role scope, bounded transport and disabled SDK retries.
export function customerAiMaintenanceJournal(config: {
  databaseUrl: string; serviceRoleKey: string; mode?: "development" | "test" | "production";
  allowLoopbackHttp?: boolean; databaseFetch?: typeof fetch;
}, sharedClient?: SupabaseClient) {
  const invalid = () => new Error("Customer AI maintenance journal configuration is invalid.");
  const lifetime = new AbortController();
  let sb: SupabaseClient;
  try {
    if (!config || typeof config.databaseUrl !== "string" || config.databaseUrl !== config.databaseUrl.trim()
      || typeof config.serviceRoleKey !== "string" || !/^[A-Za-z0-9_./+=-]{16,4096}$/u.test(config.serviceRoleKey)
      || (config.allowLoopbackHttp !== undefined && typeof config.allowLoopbackHttp !== "boolean")
      || (config.allowLoopbackHttp === true && !["development", "test"].includes(config.mode ?? ""))) throw invalid();
    const url = new URL(config.databaseUrl), loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
      || !(url.protocol === "https:" || (config.allowLoopbackHttp === true && loopback && url.protocol === "http:"))) throw invalid();
    sb = sharedClient ?? createClient(url.origin, config.serviceRoleKey, { db: { retry: false },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: boundedSupabaseFetch(lifetime.signal, config.databaseFetch) } });
  } catch { lifetime.abort(); throw invalid(); }
  let closed = false;
  async function call(op: "begin" | "execute" | "read", value: CustomerAiMaintenanceIdentity, signal?: AbortSignal): Promise<JournalOutcome> {
    const parsed = identity.safeParse(value);
    if (closed || !parsed.success || (signal !== undefined && !(signal instanceof AbortSignal))) {
      throw new Error("Customer AI maintenance journal is unavailable.");
    }
    const saved = parsed.data;
    if (signal?.aborted) return { status: "unknown", identity: saved };
    const deadline = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000), ...(signal ? [signal] : [])]);
    let abort: (() => void) | undefined;
    try {
      const interrupted = new Promise<never>((_, reject) => {
        abort = () => reject(new Error()); deadline.addEventListener("abort", abort, { once: true });
        if (deadline.aborted) abort();
      });
      const name = op === "begin" ? "begin_customer_ai_maintenance" : op === "execute"
        ? "execute_customer_ai_maintenance" : "read_customer_ai_maintenance";
      const args = op === "begin" ? { p_attempt_id: saved.attemptId, p_job_id: saved.jobId, p_action: saved.action }
        : { p_attempt_id: saved.attemptId };
      const response = await Promise.race([sb.rpc(name, args).abortSignal(deadline), interrupted]);
      if (deadline.aborted || response.error) throw new Error();
      const value = receipt.parse(response.data);
      if (value.attemptId !== saved.attemptId || value.jobId !== saved.jobId || value.action !== saved.action) throw new Error();
      return { status: "confirmed", receipt: value };
    } catch {
      // A request may have committed even when the response was lost. Never
      // replace the caller's ID, retry the RPC, or echo database errors.
      return { status: "unknown", identity: saved };
    } finally { if (abort) deadline.removeEventListener("abort", abort); }
  }
  return {
    begin: (value: CustomerAiMaintenanceIdentity, signal?: AbortSignal) => call("begin", value, signal),
    execute: (value: CustomerAiMaintenanceIdentity, signal?: AbortSignal) => call("execute", value, signal),
    read: (value: CustomerAiMaintenanceIdentity, signal?: AbortSignal) => call("read", value, signal),
    close() { closed = true; lifetime.abort(); },
  };
}
