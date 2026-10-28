/** Explicit, unregistered composition for a private customer-key worker.
 * Callers must enforce operator-only configuration and readiness. This does not
 * install a process, HTTP route, timer, policy, entitlement or provider key.
 */
import { createClient } from "@supabase/supabase-js";
import { boundedSupabaseFetch } from "./supabase.js";
import { customerAiWorker } from "./customer-ai-worker.js";
import { customerAiScheduler } from "./customer-ai-scheduler.js";
import { customerAiMaintenanceSlots } from "./customer-ai-maintenance-slots.js";
import { customerAiMaintenanceJournal } from "./customer-ai-maintenance-journal.js";
import { customerAiSlotController } from "./customer-ai-slot-controller.js";
import type { CredentialVault } from "./ai-connection-vault.js";
import type { customerDispatchSigner } from "./customer-ai-dispatch.js";

export function customerAiComposition(config: {
  databaseUrl: string; serviceRoleKey: string; serviceUrl: string; serviceToken: string;
  vault: CredentialVault; signer: ReturnType<typeof customerDispatchSigner>;
  pageSize?: number; mode?: "development" | "test" | "production"; allowLoopbackHttp?: boolean;
  databaseFetch?: typeof fetch; serviceFetch?: typeof fetch;
}) {
  const invalid = () => new Error("Customer AI composition configuration is invalid.");
  const lifetime = new AbortController();
  // Shutdown stops intake without aborting the current worker's receipt/hold recovery.
  const intake = new AbortController();
  let scheduler: ReturnType<typeof customerAiScheduler>;
  let maintenance: ReturnType<typeof customerAiSlotController>;
  let slots: ReturnType<typeof customerAiMaintenanceSlots>;
  let journal: ReturnType<typeof customerAiMaintenanceJournal>;
  try {
    if (!config || typeof config.allowLoopbackHttp !== "undefined" && typeof config.allowLoopbackHttp !== "boolean"
      || config.allowLoopbackHttp && !["development", "test"].includes(config.mode ?? "")
      || typeof config.databaseUrl !== "string" || config.databaseUrl !== config.databaseUrl.trim()
      || typeof config.serviceRoleKey !== "string" || !/^[A-Za-z0-9_./+=-]{16,4096}$/u.test(config.serviceRoleKey)) throw invalid();
    const url = new URL(config.databaseUrl), loopback = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)
      || !(url.protocol === "https:" || (config.allowLoopbackHttp === true && loopback && url.protocol === "http:"))) throw invalid();
    // Do not rely on SDK defaults: no request retries, including Retry-After.
    const sb = createClient(url.origin, config.serviceRoleKey, { db: { retry: false },
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
      global: { fetch: boundedSupabaseFetch(lifetime.signal, config.databaseFetch) } });
    const worker = customerAiWorker(sb, { serviceUrl: config.serviceUrl, serviceToken: config.serviceToken,
      vault: config.vault, signer: config.signer, allowLoopbackHttp: config.allowLoopbackHttp, fetcher: config.serviceFetch });
    const pageSize = config.pageSize ?? 1;
    scheduler = customerAiScheduler(sb, worker, { pageSize });
    const privateConfig = { databaseUrl: config.databaseUrl, serviceRoleKey: config.serviceRoleKey,
      mode: config.mode, allowLoopbackHttp: config.allowLoopbackHttp, databaseFetch: config.databaseFetch };
    slots = customerAiMaintenanceSlots(privateConfig, sb);
    journal = customerAiMaintenanceJournal(privateConfig, sb);
    maintenance = customerAiSlotController(sb, slots, journal, { pageSize });
  } catch { lifetime.abort(); throw invalid(); }
  let closed = false, active: Promise<unknown> | undefined, closing: Promise<void> | undefined;
  async function run<T>(action: () => Promise<T>): Promise<T> {
    if (closed) throw new Error("Customer AI composition is closed.");
    if (active) throw new Error("Customer AI composition is already running.");
    const operation = action(); active = operation;
    try { return await operation; } finally { if (active === operation) active = undefined; }
  }
  return {
    tick: (signal?: AbortSignal) => run(() => scheduler.tick(signal, intake.signal)),
    reconcile: (jobId: string, signal?: AbortSignal) => run(() => scheduler.reconcile(jobId, { signal })),
    recoverReceipt: (jobId: string, signal?: AbortSignal) => run(() => scheduler.recoverReceipt(jobId, { signal })),
    scanMaintenance: (signal?: AbortSignal) => run(() => maintenance.tick(signal)),
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      intake.abort();
      const maintenanceStop = maintenance.close();
      // Stop new work immediately, but allow the current worker to finish its
      // bounded receipt/hold recovery before cancelling the shared transport.
      closing = (async () => { try { await maintenanceStop; await active; } catch { /* caller observes its own result */ }
        finally { slots.close(); journal.close(); lifetime.abort(); } })();
      return closing;
    },
  };
}
