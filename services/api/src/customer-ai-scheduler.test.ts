import { test } from "node:test";
import assert from "node:assert/strict";
import { customerAiScheduler } from "./lib/customer-ai-scheduler.js";
import type { SupabaseClient } from "./lib/supabase.js";
import type { CustomerAiOutcome } from "./lib/customer-ai-worker.js";

const ids = ["10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003"];
const row = (i: number, ready = true) => ({ job_id: ids[i], created_at: `2026-10-28T12:00:00.12345${i}+00:00`, ready });
function database(pages: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  const sb = { rpc(name: string, args: Record<string, unknown>) {
    assert.equal(name, "discover_customer_ai_ready_jobs"); calls.push(args);
    return { abortSignal: async () => ({ data: pages.shift(), error: null }) };
  } } as unknown as SupabaseClient;
  return { sb, calls };
}
const success = async (jobId: string): Promise<CustomerAiOutcome> => ({ jobId, status: "succeeded" });

test("shutdown interrupts non-cooperative discovery; late rows cannot start a worker", { timeout: 2000 }, async () => {
  let release!: (response: unknown) => void, claims = 0, calls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const sb = { rpc() { calls++; return { abortSignal() { return pending; } }; } } as unknown as SupabaseClient;
  const scheduler = customerAiScheduler(sb, { run: async id => { claims++; return success(id); } });
  const stop = new AbortController(), tick = scheduler.tick(undefined, stop.signal);
  stop.abort();
  assert.deepEqual(await tick, { scanned: 0, attempted: 0, uncertain: 0, suppressed: 0, cycleComplete: false });
  await assert.rejects(scheduler.tick(), /scheduler is unavailable/u);
  assert.equal(calls, 1);
  release({ data: [row(0)], error: null });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(claims, 0);
});

test("advances exact microsecond cursor across non-ready rows and wraps at scan end", async () => {
  const db = database([[row(0, false), row(1)], [row(2)], []]); const attempted: string[] = [];
  const scheduler = customerAiScheduler(db.sb, { run: async id => { attempted.push(id); return success(id); } }, { pageSize: 2 });
  assert.deepEqual(await scheduler.tick(), { scanned: 2, attempted: 1, uncertain: 0, suppressed: 0, cycleComplete: false });
  assert.deepEqual(await scheduler.tick(), { scanned: 1, attempted: 1, uncertain: 0, suppressed: 0, cycleComplete: true });
  await scheduler.tick();
  assert.deepEqual(attempted, [ids[1], ids[2]]);
  assert.equal(db.calls[1]?.p_after_created_at, row(1).created_at);
  assert.equal(db.calls[1]?.p_after_job_id, ids[1]);
  assert.equal(db.calls[2]?.p_after_created_at, null);
});

test("ambiguous and thrown worker outcomes are not retried in later scans", async () => {
  const db = database([[row(0), row(1)], [row(0), row(1)]]); const attempted: string[] = [];
  const scheduler = customerAiScheduler(db.sb, { run: async id => {
    attempted.push(id); if (id === ids[0]) throw new Error("private upstream error");
    return { jobId: id, status: "completion_unknown" };
  } }, { pageSize: 3 });
  assert.deepEqual(await scheduler.tick(), { scanned: 2, attempted: 2, uncertain: 2, suppressed: 0, cycleComplete: true });
  assert.deepEqual(await scheduler.tick(), { scanned: 2, attempted: 0, uncertain: 0, suppressed: 2, cycleComplete: true });
  assert.deepEqual(attempted, [ids[0], ids[1]]);
});

test("abort stops before further claims and resume keeps the last processed cursor", async () => {
  const controller = new AbortController();
  const db = database([[row(0), row(1)], [row(1)]]); const attempted: string[] = [];
  const scheduler = customerAiScheduler(db.sb, { run: async id => { attempted.push(id); controller.abort(); return success(id); } }, { pageSize: 2 });
  assert.deepEqual(await scheduler.tick(controller.signal), { scanned: 1, attempted: 1, uncertain: 0, suppressed: 0, cycleComplete: false });
  await scheduler.tick();
  assert.equal(db.calls[1]?.p_after_created_at, row(0).created_at);
  assert.deepEqual(attempted, [ids[0], ids[1]]);
});

test("intake stop after discovery prevents claims without aborting a worker", async () => {
  const controller = new AbortController(); let release!: (value: unknown) => void, attempts = 0;
  const sb = { rpc: () => ({ abortSignal: () => new Promise(resolve => { release = resolve; }) }) } as unknown as SupabaseClient;
  const scheduler = customerAiScheduler(sb, { run: async id => { attempts++; return success(id); } });
  const pending = scheduler.tick(undefined, controller.signal);
  controller.abort(); release({ data: [row(0)], error: null });
  assert.deepEqual(await pending, { scanned: 0, attempted: 0, uncertain: 0, suppressed: 0, cycleComplete: false });
  assert.equal(attempts, 0);
});

test("rejects overlapping scans, malformed responses, and exposes no upstream errors", async () => {
  let release!: (value: unknown) => void;
  const sb = { rpc: () => ({ abortSignal: () => new Promise(resolve => { release = resolve; }) }) } as unknown as SupabaseClient;
  const scheduler = customerAiScheduler(sb, { run: success });
  const active = scheduler.tick();
  await assert.rejects(scheduler.tick(), /already running/u);
  release({ data: [], error: null }); await active;
  const broken = database([[{ ...row(0), created_at: "infinity", secret: "private-value" }]]);
  await assert.rejects(customerAiScheduler(broken.sb, { run: success }).tick(), error => {
    assert.ok(error instanceof Error); assert.equal(error.message, "Customer AI scheduler is unavailable.");
    assert.doesNotMatch(error.stack ?? "", /private-value/u); return true;
  });
});

test("bounded uncertain tracking stops new work and reports that review is required", async () => {
  const rows = Array.from({ length: 1025 }, (_, i) => ({
    job_id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    created_at: "2026-10-28T12:00:00.123456+00:00", ready: true,
  }));
  const pages = Array.from({ length: 11 }, (_, i) => rows.slice(i * 100, i * 100 + 100));
  const db = database(pages); let attempts = 0;
  const scheduler = customerAiScheduler(db.sb, { run: async jobId => {
    attempts++; return { jobId, status: "completion_unknown" };
  } }, { pageSize: 100 });
  for (let i = 0; i < 10; i++) await scheduler.tick();
  await assert.rejects(scheduler.tick(), /requires outcome review/u);
  await assert.rejects(scheduler.tick(), /requires outcome review/u);
  assert.equal(attempts, 1024);
});

test("reconciliation uses the exact service RPC and only clears confirmed terminal states", async () => {
  let state: unknown = "unchanged", attempts = 0; const calls: Array<{ name: string; args: unknown }> = [];
  const sb = { rpc(name: string, args: unknown) { calls.push({ name, args }); return { abortSignal: async () =>
    ({ data: name === "discover_customer_ai_ready_jobs" ? [row(0)] : state, error: null }) }; } } as unknown as SupabaseClient;
  const scheduler = customerAiScheduler(sb, { run: async jobId => { attempts++; return { jobId, status: "completion_unknown" }; } }, { pageSize: 2 });
  await scheduler.tick();
  for (const value of ["unchanged", "requires_review"]) {
    state = value;
    assert.deepEqual(await scheduler.reconcile(ids[0]), { state: value, suppressionCleared: false });
    assert.equal((await scheduler.tick()).suppressed, 1);
  }
  assert.equal(attempts, 1);
  state = "released";
  assert.deepEqual(await scheduler.reconcile(ids[0]), { state, suppressionCleared: true });
  assert.deepEqual(calls.filter(call => call.name === "reconcile_customer_ai_job"),
    Array.from({ length: 3 }, () => ({ name: "reconcile_customer_ai_job", args: { p_job_id: ids[0] } })));
  await scheduler.tick();
  state = "settled";
  assert.deepEqual(await scheduler.reconcile(ids[0]), { state, suppressionCleared: true });
});

test("reconciliation rejects malformed or failed evidence and invalid inputs without clearing suppression", async () => {
  let data: unknown = { jobId: ids[1], state: "settled" }, error: unknown = null, calls = 0;
  const sb = { rpc(name: string) { calls++; return { abortSignal: async () => ({ data: name === "discover_customer_ai_ready_jobs" ? [row(0)] : data, error }) }; } } as unknown as SupabaseClient;
  const scheduler = customerAiScheduler(sb, { run: async jobId => ({ jobId, status: "completion_unknown" }) }, { pageSize: 2 });
  await scheduler.tick();
  await assert.rejects(scheduler.reconcile(ids[0]), /reconciliation is unavailable/u);
  data = "undispatched_safe_to_retry";
  await assert.rejects(scheduler.reconcile(ids[0]), /reconciliation is unavailable/u);
  data = "settled"; error = { message: "private secret" };
  await assert.rejects(scheduler.reconcile(ids[0]), e => { assert.ok(e instanceof Error); assert.doesNotMatch(e.stack ?? "", /private secret/u); return true; });
  error = null;
  const abort = new AbortController(); abort.abort(); const before = calls;
  await assert.rejects(scheduler.reconcile(ids[0], { signal: abort.signal }), /reconciliation is unavailable/u);
  await assert.rejects(scheduler.reconcile(ids[0], { allowUndispatchedRetry: true } as never), /reconciliation is unavailable/u);
  assert.equal(calls, before);
  assert.equal((await scheduler.tick()).suppressed, 1);
});

test("abort during reconciliation cannot clear suppression from a late response", async () => {
  const controller = new AbortController(); let resolve!: (value: unknown) => void;
  const sb = { rpc(name: string) { return { abortSignal: () => name === "discover_customer_ai_ready_jobs"
    ? Promise.resolve({ data: [row(0)], error: null }) : new Promise(done => { resolve = done; }) }; } } as unknown as SupabaseClient;
  const scheduler = customerAiScheduler(sb, { run: async jobId => ({ jobId, status: "completion_unknown" }) }, { pageSize: 2 });
  await scheduler.tick();
  const pending = scheduler.reconcile(ids[0], { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /reconciliation is unavailable/u);
  resolve({ data: "settled", error: null });
  await Promise.resolve();
  assert.equal((await scheduler.tick()).suppressed, 1);
});

test("receipt recovery binds one service RPC to the exact job and only confirmed settlement clears suppression", async () => {
  let data: unknown = "unchanged", rpcError: unknown = null; const calls: Array<{ name: string; args: unknown }> = [];
  const sb = { rpc(name: string, args: unknown) { calls.push({ name, args }); return { abortSignal: async () => ({
    data: name === "discover_customer_ai_ready_jobs" ? [row(0)] : data, error: rpcError }) }; } } as unknown as SupabaseClient;
  let workerCalls = 0;
  const scheduler = customerAiScheduler(sb, { run: async jobId => { workerCalls++; return { jobId, status: "completion_unknown" }; } }, { pageSize: 2 });
  await scheduler.tick();
  await assert.rejects(scheduler.recoverReceipt(ids[0]), /receipt recovery is unavailable/u);
  assert.equal((await scheduler.tick()).suppressed, 1);
  data = { jobId: ids[1], state: "settled" };
  await assert.rejects(scheduler.recoverReceipt(ids[0]), /receipt recovery is unavailable/u);
  data = "settled"; rpcError = { message: "synthetic secret" };
  await assert.rejects(scheduler.recoverReceipt(ids[0]), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.stack ?? "", /synthetic secret/u); return true;
  });
  rpcError = null;
  assert.deepEqual(await scheduler.recoverReceipt(ids[0]), { state: "settled", suppressionCleared: true });
  assert.deepEqual(calls.filter(call => call.name === "recover_customer_ai_receipt"),
    Array.from({ length: 4 }, () => ({ name: "recover_customer_ai_receipt", args: { p_job_id: ids[0] } })));
  assert.equal(workerCalls, 1);
  assert.ok(!calls.some(call => /cancel|release|dispatch/u.test(call.name)));
});

test("lost or aborted receipt recovery does not retry or clear suppression on a late reply", async () => {
  const controller = new AbortController(); let resolve!: (value: unknown) => void; let calls = 0;
  const sb = { rpc(name: string) { if (name === "recover_customer_ai_receipt") calls++; return { abortSignal: () =>
    name === "discover_customer_ai_ready_jobs" ? Promise.resolve({ data: [row(0)], error: null })
      : new Promise(done => { resolve = done; }) }; } } as unknown as SupabaseClient;
  const scheduler = customerAiScheduler(sb, { run: async jobId => ({ jobId, status: "completion_unknown" }) }, { pageSize: 2 });
  await scheduler.tick();
  const pending = scheduler.recoverReceipt(ids[0], { signal: controller.signal });
  await assert.rejects(scheduler.tick(), /already running/u);
  controller.abort();
  await assert.rejects(pending, /receipt recovery is unavailable/u);
  resolve({ data: "settled", error: null }); await Promise.resolve();
  assert.equal((await scheduler.tick()).suppressed, 1);
  assert.equal(calls, 1);
});
