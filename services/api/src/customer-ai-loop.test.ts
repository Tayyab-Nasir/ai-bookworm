import assert from "node:assert/strict";
import { test } from "node:test";
import { runCustomerAiLoop } from "./lib/customer-ai-loop.js";

const complete = { scanned: 1, attempted: 1, uncertain: 0, suppressed: 0, cycleComplete: true };
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };

test("stop drains an active tick and prevents subsequent ticks", async () => {
  const controller = new AbortController(), started = deferred(), done = deferred();
  let ticks = 0, closes = 0, active = 0, maxActive = 0;
  const runtime = { async tick() { ticks++; active++; maxActive = Math.max(maxActive, active); started.release(); await done.promise; active--; return complete; },
    async close() { closes++; await done.promise; } };
  const running = runCustomerAiLoop(runtime, { signal: controller.signal });
  await started.promise; controller.abort(); await Promise.resolve();
  assert.equal(closes, 1); assert.equal(active, 1); done.release(); await running;
  assert.equal(ticks, 1); assert.equal(maxActive, 1); assert.equal(closes, 1);
});

test("already stopped and idle stop close exactly once without starting another tick", async () => {
  const already = new AbortController(); already.abort(); let ticks = 0, closes = 0;
  const runtime = { async tick() { ticks++; return complete; }, async close() { closes++; } };
  await runCustomerAiLoop(runtime, { signal: already.signal }); assert.equal(ticks, 0); assert.equal(closes, 1);
  const idle = new AbortController(), started = deferred();
  const waiting = runCustomerAiLoop({ async tick() { ticks++; started.release(); return complete; }, async close() { closes++; } },
    { signal: idle.signal, idleDelayMs: 30_000 });
  await started.promise; idle.abort(); await waiting; assert.equal(ticks, 1); assert.equal(closes, 2);
});

test("full pages scan sequentially without auto-reconciling uncertain results", async () => {
  const controller = new AbortController(); let ticks = 0, active = 0, maxActive = 0, closes = 0, reconciliations = 0;
  const runtime = { async tick() {
    active++; maxActive = Math.max(maxActive, active); ticks++;
    await Promise.resolve(); active--;
    if (ticks === 2) controller.abort();
    return { ...complete, uncertain: 1, cycleComplete: false };
  }, async close() { closes++; }, async reconcile() { reconciliations++; } };
  await runCustomerAiLoop(runtime, { signal: controller.signal });
  assert.equal(ticks, 2); assert.equal(maxActive, 1); assert.equal(closes, 1); assert.equal(reconciliations, 0);
});

test("sanitizes tick and close errors, stops on failure and rejects unsafe configuration", async () => {
  for (const failing of ["tick", "close"]) {
    const controller = new AbortController(); let ticks = 0, closes = 0;
    const runtime = { async tick() { ticks++; if (failing === "tick") throw new Error("private-token"); controller.abort(); return complete; },
      async close() { closes++; if (failing === "close") throw new Error("private-token"); } };
    await assert.rejects(runCustomerAiLoop(runtime, { signal: controller.signal }), error => {
      assert.ok(error instanceof Error); assert.equal(error.message, "Customer AI loop stopped unexpectedly.");
      assert.doesNotMatch(error.stack ?? "", /private-token/u); return true;
    });
    assert.equal(ticks, 1); assert.equal(closes, 1);
  }
  const runtime = { async tick() { return complete; }, async close() {} };
  for (const idleDelayMs of [0, 99, 30_001, Number.NaN])
    await assert.rejects(runCustomerAiLoop(runtime, { signal: new AbortController().signal, idleDelayMs }), /configuration is invalid/u);
});
