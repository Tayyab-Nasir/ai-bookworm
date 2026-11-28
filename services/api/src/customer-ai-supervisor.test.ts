import assert from "node:assert/strict";
import { test } from "node:test";
import { customerAiLifecycle } from "./lib/customer-ai-loop.js";
import { customerAiSupervisor } from "./lib/customer-ai-supervisor.js";

const scope = { deploymentId: "deployment", projectRef: "project", serviceId: "service", keyId: "key" };
const maintenance = { slotsScanned: 0, candidatesScanned: 0, events: [], slotsCycleComplete: true, candidatesCycleComplete: true };
const complete = { scanned: 1, attempted: 1, uncertain: 0, suppressed: 0, cycleComplete: true };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const signal = () => new AbortController().signal;
let sequence = 0; const options = () => { const owned = { ...scope, projectRef: `project-${++sequence}` }; return { scope: owned, lifecycle: customerAiLifecycle({ scope: owned, ttlMs: 5_000 }) }; };

test("stop times out without replacing or interrupting a paid in-flight tick, then observes the same drain", async () => {
  const started = deferred(), finish = deferred(); let ticks = 0, closes = 0, refundCalls = 0, active = 0;
  const runtime = {
    async scanMaintenance() { return maintenance; },
    async tick() { ticks++; active++; started.release(); await finish.promise; active--; return complete; },
    async close() { closes++; await finish.promise; },
    async refund() { refundCalls++; },
  };
  const supervisor = customerAiSupervisor(runtime, { ...options(), idleDelayMs: 100 });
  supervisor.start(); await started.promise;
  const first = supervisor.stop(10), second = supervisor.stop(20);
  assert.equal(supervisor.status(), "draining");
  await assert.rejects(supervisor.verifyWorker(signal()), /unavailable/u);
  assert.equal(await first, "draining"); assert.equal(await second, "draining");
  assert.equal(supervisor.status(), "draining");
  assert.throws(() => supervisor.start(), /unavailable/u);
  assert.equal(active, 1); assert.equal(closes, 1); assert.equal(ticks, 1); assert.equal(refundCalls, 0);
  finish.release();
  assert.equal(await supervisor.stop(1_000), "loop_stopped");
  assert.equal(supervisor.status(), "loop_stopped");
  assert.equal(ticks, 1); assert.equal(closes, 1); assert.equal(refundCalls, 0);
  assert.throws(() => supervisor.start(), /unavailable/u);
});

test("stop while scanning drains that operation and does not start generation", async () => {
  const started = deferred(), finish = deferred(); let ticks = 0, closes = 0;
  const runtime = {
    async scanMaintenance() { started.release(); await finish.promise; return maintenance; },
    async tick() { ticks++; return complete; },
    async close() { closes++; await finish.promise; },
  };
  const supervisor = customerAiSupervisor(runtime, options());
  supervisor.start(); await started.promise;
  assert.equal(await supervisor.stop(10), "draining"); assert.equal(ticks, 0);
  finish.release(); assert.equal(await supervisor.stop(1_000), "loop_stopped");
  assert.equal(ticks, 0); assert.equal(closes, 1);
});

test("stopping before start still closes once and cannot start later", async () => {
  const finish = deferred(); let closes = 0, ticks = 0;
  const runtime = { async scanMaintenance() { return maintenance; }, async tick() { ticks++; return complete; },
    async close() { closes++; await finish.promise; } };
  const supervisor = customerAiSupervisor(runtime, options());
  assert.equal(await supervisor.stop(10), "draining");
  assert.throws(() => supervisor.start(), /unavailable/u);
  finish.release(); assert.equal(await supervisor.stop(1_000), "loop_stopped");
  assert.equal(closes, 1); assert.equal(ticks, 0);
});

test("immediate stop after start closes the same owner without starting a page", async () => {
  let scans = 0, ticks = 0, closes = 0;
  const runtime = { async scanMaintenance() { scans++; return maintenance; }, async tick() { ticks++; return complete; }, async close() { closes++; } };
  const owner = customerAiSupervisor(runtime, options());
  owner.start(); assert.equal(await owner.stop(1_000), "loop_stopped");
  assert.equal(scans, 0); assert.equal(ticks, 0); assert.equal(closes, 1);
});

test("ready evidence requires completed progress and is revoked synchronously at stop", async () => {
  const ready = deferred(), held = deferred(); let ticks = 0;
  const runtime = { async scanMaintenance() { return maintenance; }, async tick() {
    if (++ticks === 1) return { ...complete, cycleComplete: false };
    ready.release(); await held.promise; return complete;
  }, async close() { await held.promise; } };
  const supervisor = customerAiSupervisor(runtime, { ...options(), idleDelayMs: 100 });
  await assert.rejects(supervisor.verifyWorker(signal()), /unavailable/u);
  supervisor.start(); await ready.promise;
  assert.equal((await supervisor.verifyWorker(signal())).ready, true);
  const stopping = supervisor.stop(10);
  await assert.rejects(supervisor.verifyWorker(signal()), /unavailable/u);
  assert.equal(await stopping, "draining"); held.release(); assert.equal(await supervisor.stop(1_000), "loop_stopped");
});

test("unexpected failure is terminal, secret-free and never restarts", async () => {
  const failed = deferred(); let ticks = 0, closes = 0;
  const runtime = { async scanMaintenance() { return maintenance; }, async tick(): Promise<typeof complete> {
    ticks++; failed.release(); throw new Error("secret-sensitive-diagnostic");
  }, async close() { closes++; } };
  const supervisor = customerAiSupervisor(runtime, options());
  supervisor.start(); await failed.promise;
  assert.equal(await supervisor.stop(1_000), "failed");
  assert.equal(supervisor.status(), "failed"); assert.equal(ticks, 1); assert.equal(closes, 1);
  assert.throws(() => supervisor.start(), error => error instanceof Error && !error.message.includes("secret-sensitive"));
  await assert.rejects(supervisor.verifyWorker(signal()), error => error instanceof Error && !error.message.includes("secret-sensitive"));
});

test("a failed loop with a hanging close cannot report ready or admit another owner", async () => {
  const closing = deferred(), release = deferred(); let ticks = 0, closes = 0;
  const runtime = { async scanMaintenance() { return maintenance; }, async tick(): Promise<typeof complete> {
    ticks++; throw new Error("private-failure");
  }, async close() { closes++; closing.release(); await release.promise; } };
  const config = options(), owner = customerAiSupervisor(runtime, config);
  owner.start(); await closing.promise;
  assert.equal(owner.status(), "running"); // Owner phase, not a health proof.
  await assert.rejects(owner.verifyWorker(signal()), /unavailable/u);
  assert.throws(() => customerAiSupervisor(runtime, config), /unavailable/u);
  assert.equal(await owner.stop(10), "draining");
  release.release(); assert.equal(await owner.stop(1_000), "failed");
  assert.equal(ticks, 1); assert.equal(closes, 1);
});

test("rejects invalid configuration and bounded waits without starting a worker", async () => {
  let ticks = 0;
  const runtime = { async scanMaintenance() { return maintenance; }, async tick() { ticks++; return complete; }, async close() {} };
  assert.throws(() => customerAiSupervisor(runtime, { ...options(), idleDelayMs: 0 }), /unavailable/u);
  const supervisor = customerAiSupervisor(runtime, options());
  for (const ms of [0, -1, 300_001, Number.NaN]) await assert.rejects(supervisor.stop(ms), /unavailable/u);
  assert.equal(supervisor.status(), "idle"); assert.equal(ticks, 0);
  assert.equal(await supervisor.stop(1_000), "loop_stopped");
});

test("a loop return does not release ownership while detached transport might remain live", async () => {
  const orphanedTransport = deferred(), tickStarted = deferred(); let dispatches = 0, stillActive = false;
  const runtime = { async scanMaintenance() { return maintenance; }, async tick() {
    dispatches++; stillActive = true; void orphanedTransport.promise.then(() => { stillActive = false; });
    tickStarted.release(); return complete;
  }, async close() { /* A timed-out or detached provider call may survive close. */ } };
  const config = options();
  const owner = customerAiSupervisor(runtime, { ...config, idleDelayMs: 100 });
  assert.throws(() => customerAiSupervisor(runtime, config), /unavailable/u);
  owner.start(); await tickStarted.promise;
  assert.equal(await owner.stop(1_000), "loop_stopped");
  assert.equal(stillActive, true);
  assert.throws(() => customerAiSupervisor(runtime, config), /unavailable/u);
  const rotated = { ...config.scope, keyId: "rotated" };
  assert.throws(() => customerAiSupervisor(runtime, { scope: rotated, lifecycle: customerAiLifecycle({ scope: rotated }) }), /unavailable/u);
  const moved = { ...config.scope, deploymentId: "new-deployment", serviceId: "new-service" };
  assert.throws(() => customerAiSupervisor(runtime, { scope: moved, lifecycle: customerAiLifecycle({ scope: moved }) }), /unavailable/u);
  assert.equal(dispatches, 1);
  orphanedTransport.release(); await orphanedTransport.promise;
});

test("last progress expires while a generation is blocked", async () => {
  let wall = 2_000_000, monotonic = 1_000, ticks = 0;
  const owned = { ...scope, projectRef: `project-${++sequence}` };
  const proof = customerAiLifecycle({ scope: owned, ttlMs: 5_000, mode: "test", _testClock: () => ({ wall, monotonic }) });
  const blocked = deferred(), release = deferred();
  const runtime = { async scanMaintenance() { return maintenance; }, async tick() {
    if (++ticks === 1) return { ...complete, cycleComplete: false };
    blocked.release(); await release.promise; return complete;
  }, async close() { await release.promise; } };
  const owner = customerAiSupervisor(runtime, { scope: owned, lifecycle: proof, idleDelayMs: 100 });
  owner.start(); await blocked.promise;
  assert.equal((await owner.verifyWorker(signal())).ready, true);
  wall += 5_000; monotonic += 5_000;
  await assert.rejects(owner.verifyWorker(signal()), /unavailable/u);
  const stopping = owner.stop(10); assert.equal(await stopping, "draining");
  release.release(); assert.equal(await owner.stop(1_000), "loop_stopped");
});

test("a lifecycle for a different deployment cannot prove supervisor readiness", async () => {
  const config = options(), held = deferred(), ready = deferred(); let ticks = 0;
  const mismatched = { ...config.scope, deploymentId: "another-deployment" };
  const runtime = { async scanMaintenance() { return maintenance; }, async tick() {
    if (++ticks === 1) return { ...complete, cycleComplete: false };
    ready.release(); await held.promise; return complete;
  }, async close() { await held.promise; } };
  const owner = customerAiSupervisor(runtime, { scope: mismatched, lifecycle: config.lifecycle, idleDelayMs: 100 });
  owner.start(); await ready.promise;
  await assert.rejects(owner.verifyWorker(signal()), /unavailable/u);
  const stopping = owner.stop(10); assert.equal(await stopping, "draining");
  held.release(); assert.equal(await owner.stop(1_000), "loop_stopped");
});

test("mutating the operator options after construction cannot replace proof or observer", async () => {
  const config = options(), held = deferred(), ready = deferred(); let ticks = 0, oldEvents = 0, newEvents = 0;
  const opts = { ...config, idleDelayMs: 100, onMaintenance: () => { oldEvents++; } };
  const runtime = { async scanMaintenance() { return maintenance; }, async tick() {
    if (++ticks === 1) return { ...complete, cycleComplete: false };
    ready.release(); await held.promise; return complete;
  }, async close() { await held.promise; } };
  const owner = customerAiSupervisor(runtime, opts);
  opts.scope = { ...opts.scope, deploymentId: "changed" };
  opts.lifecycle = customerAiLifecycle({ scope: opts.scope });
  opts.onMaintenance = () => { newEvents++; };
  owner.start(); await ready.promise;
  assert.equal((await owner.verifyWorker(signal())).deploymentId, config.scope.deploymentId);
  assert.equal(oldEvents, 2); assert.equal(newEvents, 0);
  const stopping = owner.stop(10); assert.equal(await stopping, "draining");
  held.release(); assert.equal(await owner.stop(1_000), "loop_stopped");
});
