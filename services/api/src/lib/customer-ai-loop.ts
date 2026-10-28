/** Explicitly invoked private consumer loop. No environment, process signal,
 * network client or provider configuration is installed by this module. */
import { setTimeout as delay } from "node:timers/promises";
import type { customerAiComposition } from "./customer-ai-composition.js";

type Runtime = Pick<ReturnType<typeof customerAiComposition>, "tick" | "scanMaintenance" | "close">;
type MaintenanceSummary = Awaited<ReturnType<Runtime["scanMaintenance"]>>;

export async function runCustomerAiLoop(runtime: Runtime, options: { signal: AbortSignal; idleDelayMs?: number; onMaintenance?: (summary: MaintenanceSummary) => void }): Promise<void> {
  const idleDelayMs = options?.idleDelayMs ?? 2_000;
  if (!runtime || typeof runtime.tick !== "function" || typeof runtime.scanMaintenance !== "function" || typeof runtime.close !== "function"
    || !options || !(options.signal instanceof AbortSignal)
    || (options.onMaintenance !== undefined && typeof options.onMaintenance !== "function")
    || !Number.isInteger(idleDelayMs) || idleDelayMs < 100 || idleDelayMs > 30_000) {
    throw new Error("Customer AI loop configuration is invalid.");
  }
  const wake = new AbortController(); let stopped = false;
  let closing: Promise<boolean> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true; wake.abort();
    // close() stops the current page's intake but drains any active worker.
    // Convert failure to data immediately to prevent an unhandled rejection.
    closing = Promise.resolve().then(() => runtime.close()).then(() => true, () => false);
  };
  options.signal.addEventListener("abort", stop, { once: true });
  if (options.signal.aborted) stop();
  let failed = false;
  try {
    while (!stopped) {
      const maintenance = await runtime.scanMaintenance();
      if (stopped) break;
      options.onMaintenance?.(maintenance);
      const result = await runtime.tick();
      if (stopped) break;
      if (result.cycleComplete && maintenance.slotsCycleComplete && maintenance.candidatesCycleComplete) {
        try { await delay(idleDelayMs, undefined, { signal: wake.signal }); }
        catch { if (!stopped) throw new Error(); }
      }
    }
  } catch { failed = true; }
  finally {
    stop();
    if (!(await closing)) failed = true;
    options.signal.removeEventListener("abort", stop);
  }
  if (failed) throw new Error("Customer AI loop stopped unexpectedly.");
}
