/** Explicitly invoked private consumer loop. No environment, process signal,
 * network client or provider configuration is installed by this module. */
import { setTimeout as delay } from "node:timers/promises";
import type { customerAiComposition } from "./customer-ai-composition.js";
import { performance } from "node:perf_hooks";
import { z } from "zod";

type Runtime = Pick<ReturnType<typeof customerAiComposition>, "tick" | "scanMaintenance" | "close">;
type MaintenanceSummary = Awaited<ReturnType<Runtime["scanMaintenance"]>>;

export async function runCustomerAiLoop(runtime: Runtime, options: { signal: AbortSignal; idleDelayMs?: number; onMaintenance?: (summary: MaintenanceSummary) => void; lifecycle?: CustomerAiLifecycle }): Promise<void> {
  const idleDelayMs = options?.idleDelayMs ?? 2_000;
  if (!runtime || typeof runtime.tick !== "function" || typeof runtime.scanMaintenance !== "function" || typeof runtime.close !== "function"
    || !options || !(options.signal instanceof AbortSignal)
    || (options.onMaintenance !== undefined && typeof options.onMaintenance !== "function")
    || !Number.isInteger(idleDelayMs) || idleDelayMs < 100 || idleDelayMs > 30_000) {
    throw new Error("Customer AI loop configuration is invalid.");
  }
  const lifecycle = options.lifecycle === undefined ? undefined : claimCustomerAiLifecycle(options.lifecycle, idleDelayMs);
  const wake = new AbortController(); let stopped = false;
  let closing: Promise<boolean> | undefined;
  const stop = () => {
    if (stopped) return;
    stopped = true; lifecycle?.stop(); wake.abort();
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
      if (stopped) break;
      const result = await runtime.tick();
      if (stopped) break;
      // A completed maintenance page and generation page, not a timer, is progress.
      lifecycle?.progress();
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

/** In-process evidence of the last completed loop progress within its TTL.
 * A subsequently blocked operation may retain recent evidence until expiry;
 * this does not establish instantaneous available intake. It is not a remote
 * heartbeat, supervisor, database/ACL proof, provider check, or registration.
 * Trusted composition must keep this capability private to its worker process.
 */



const binding = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/u);
const scopeSchema = z.object({ deploymentId: binding, projectRef: binding, serviceId: binding, keyId: binding }).strict();
type Scope = z.infer<typeof scopeSchema>;
type Clock = () => { wall: number; monotonic: number };
type Evidence = Scope & { kind: "customer_generation"; ready: true; observedAt: number; expiresAt: number };
export type CustomerAiLifecycle = { verifyWorker(signal: AbortSignal): Promise<Evidence> };
type State = { scope: Scope; ttl: number; clock: Clock; claimed: boolean; stopped: boolean;
  progress?: { wall: number; monotonic: number } };
const states = new WeakMap<CustomerAiLifecycle, State>();
const unavailable = () => new Error("Customer AI worker progress is unavailable.");

function readClock(clock: Clock) {
  const time = clock();
  if (!time || !Number.isSafeInteger(time.wall) || time.wall < 0 || !Number.isSafeInteger(time.monotonic) || time.monotonic < 0) throw unavailable();
  return time;
}

/** Only trusted server code may create or wire this capability. Test clocks are
 * accepted only in explicit test mode; no secrets are part of the evidence. */
export function customerAiLifecycle(config: { scope: Scope; ttlMs?: number; mode?: "test" | "production"; _testClock?: Clock }): CustomerAiLifecycle {
  const scope = scopeSchema.safeParse(config?.scope), ttl = config?.ttlMs ?? 5_000;
  if (!scope.success || !Number.isInteger(ttl) || ttl < 1_000 || ttl > 30_000
    || (config.mode !== undefined && config.mode !== "test" && config.mode !== "production")
    || (config._testClock !== undefined && (config.mode !== "test" || typeof config._testClock !== "function"))) {
    throw new Error("Customer AI lifecycle configuration is invalid.");
  }
  const clock = config._testClock ?? (() => ({ wall: Date.now(), monotonic: Math.floor(performance.now()) }));
  const state: State = { scope: scope.data, ttl, clock, claimed: false, stopped: false };
  const result: CustomerAiLifecycle = {
    async verifyWorker(signal) {
      try {
        if (!(signal instanceof AbortSignal) || signal.aborted || !state.claimed || state.stopped || !state.progress) throw unavailable();
        const current = readClock(state.clock), previous = state.progress;
        const elapsed = current.monotonic - previous.monotonic, wallElapsed = current.wall - previous.wall;
        // Reject monotonic rollback, wall rollback, expiry and clock discontinuity.
        if (elapsed < 0 || wallElapsed < 0 || elapsed >= state.ttl || wallElapsed >= state.ttl
          || Math.abs(elapsed - wallElapsed) > 1_000 || !Number.isSafeInteger(previous.wall + state.ttl)) throw unavailable();
        return { ...state.scope, kind: "customer_generation", ready: true,
          observedAt: previous.wall, expiresAt: previous.wall + state.ttl };
      } catch { throw unavailable(); }
    },
  };
  Object.freeze(result); states.set(result, state); return result;
}

/** Internal loop integration. A capability can be claimed by one loop, once.
 * Never export or call its returned progress method from a timer or endpoint. */
function claimCustomerAiLifecycle(lifecycle: CustomerAiLifecycle, idleDelayMs: number) {
  const state = states.get(lifecycle);
  if (!state || state.claimed || state.stopped || !Number.isInteger(idleDelayMs) || idleDelayMs >= state.ttl) {
    throw new Error("Customer AI lifecycle configuration is invalid.");
  }
  state.claimed = true;
  return {
    progress() {
      if (state.stopped) return;
      const now = readClock(state.clock), previous = state.progress;
      if (previous && (now.wall < previous.wall || now.monotonic < previous.monotonic
        || Math.abs((now.wall - previous.wall) - (now.monotonic - previous.monotonic)) > 1_000)) throw unavailable();
      state.progress = now;
    },
    stop() { state.stopped = true; state.progress = undefined; },
  };
}
