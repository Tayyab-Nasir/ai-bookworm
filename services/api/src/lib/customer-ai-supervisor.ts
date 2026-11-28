/** Explicit, single-use in-process supervisor for a customer-key worker.
 *
 * This module installs no process, listener, configuration or readiness gate.
 * A timed-out stop means the original loop is still draining; it never proves
 * that a paid request was cancelled, and it never starts a replacement.
 */
import {
  runCustomerAiLoop,
  verifyCustomerAiLifecycle,
  type CustomerAiLifecycle,
} from "./customer-ai-loop.js";
import type { customerAiComposition } from "./customer-ai-composition.js";

type Runtime = Pick<ReturnType<typeof customerAiComposition>, "tick" | "scanMaintenance" | "close">;
type SupervisorState = "idle" | "running" | "draining" | "loop_stopped" | "failed";
type Completed = "loop_stopped" | "failed";
type Scope = { deploymentId: string; projectRef: string; serviceId: string; keyId: string };
const unavailable = () => new Error("Customer AI supervisor is unavailable.");
// Reservations are never released in this process: a resolved loop does not
// establish that detached transport or the remote provider stopped. An
// external single-host/distributed owner and reconciliation are still required.
const reserved = new Set<string>();
const binding = /^[A-Za-z0-9_.:-]{1,128}$/u;

export function customerAiSupervisor(runtime: Runtime, options: {
  scope: Scope;
  lifecycle: CustomerAiLifecycle;
  idleDelayMs?: number;
  onMaintenance?: Parameters<typeof runCustomerAiLoop>[1]["onMaintenance"];
}) {
  if (!runtime || typeof runtime.tick !== "function" || typeof runtime.scanMaintenance !== "function"
    || typeof runtime.close !== "function" || !options?.lifecycle
    || !options.scope || Object.keys(options.scope).sort().join(",") !== "deploymentId,keyId,projectRef,serviceId"
    || ![options.scope.deploymentId, options.scope.projectRef, options.scope.serviceId, options.scope.keyId].every(x => typeof x === "string" && binding.test(x))
    || (options.idleDelayMs !== undefined && (!Number.isInteger(options.idleDelayMs) || options.idleDelayMs < 100 || options.idleDelayMs > 30_000))
    || (options.onMaintenance !== undefined && typeof options.onMaintenance !== "function")) throw unavailable();

  const expected = Object.freeze({ ...options.scope });
  // Neither key nor deployment/service rotation may bypass an unresolved
  // worker for the same project. Sharding requires a reviewed durable owner.
  const owner = expected.projectRef;
  if (reserved.size >= 1024 || reserved.has(owner)) throw unavailable();
  reserved.add(owner);
  const { lifecycle, idleDelayMs, onMaintenance } = options;
  const controller = new AbortController();
  let state: SupervisorState = "idle";
  let execution: Promise<Completed> | undefined;
  let generation = 0;

  return {
    /** This owner can start the loop once. Restart requires a new, separately
     * supervised process and reconciliation; no automatic replacement occurs. */
    start() {
      if (state !== "idle") throw unavailable();
      state = "running";
      generation++;
      // Publish the tracked execution before invoking injected runtime code.
      const running = Promise.resolve().then(() => runCustomerAiLoop(runtime, {
        signal: controller.signal,
        lifecycle,
        ...(idleDelayMs === undefined ? {} : { idleDelayMs }),
        ...(onMaintenance === undefined ? {} : { onMaintenance }),
      }));
      execution = running.then<Completed, Completed>(
        () => { state = state === "draining" ? "loop_stopped" : "failed"; generation++; return state; },
        () => { state = "failed"; generation++; return "failed"; },
      );
    },
    /** Local owner phase only, not health or worker capacity. A loop that
     * failed but is still closing may remain running until it settles. */
    status(): SupervisorState { return state; },
    /** Reject readiness on shutdown and recheck after the asynchronous probe. */
    async verifyWorker(signal: AbortSignal) {
      if (state !== "running" || !(signal instanceof AbortSignal) || signal.aborted) throw unavailable();
      const started = generation;
      try {
        const evidence = await verifyCustomerAiLifecycle(lifecycle, signal);
        if (state !== "running" || generation !== started || signal.aborted
          || evidence.deploymentId !== expected.deploymentId || evidence.projectRef !== expected.projectRef
          || evidence.serviceId !== expected.serviceId || evidence.keyId !== expected.keyId) throw unavailable();
        return evidence;
      } catch { throw unavailable(); }
    },
    /** A loop_stopped result confirms only that the loop returned; it does not
     * establish remote cancellation, closed sockets or safe process replacement.
     * A timeout retains the original handle and never starts or refunds work. */
    async stop(waitMs: number): Promise<"draining" | Completed> {
      if (!Number.isInteger(waitMs) || waitMs < 1 || waitMs > 300_000) throw unavailable();
      if (state === "idle") {
        state = "draining"; generation++;
        execution = Promise.resolve().then(() => runtime.close()).then<Completed, Completed>(
          () => { state = "loop_stopped"; generation++; return "loop_stopped"; },
          () => { state = "failed"; generation++; return "failed"; },
        );
      }
      if (state === "loop_stopped" || state === "failed") return state;
      if (state === "running") {
        state = "draining"; generation++; controller.abort();
      }
      if (!execution) throw unavailable();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          execution,
          new Promise<"draining">(resolve => { timer = setTimeout(() => resolve("draining"), waitMs); }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
    },
  };
}
