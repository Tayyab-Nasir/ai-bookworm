import assert from "node:assert/strict";
import { test } from "node:test";
import { customerAiReconciliationScan } from "./lib/customer-ai-reconciliation-scan.js";
import type { SupabaseClient } from "./lib/supabase.js";

const ids = Array.from({ length: 5 }, (_, i) => `10000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const row = (i: number, action: string) => ({ job_id: ids[i], created_at: `2026-10-28T13:00:00.12345${i}+00:00`, action });
function database(pages: unknown[]) {
  const calls: Record<string, unknown>[] = [];
  const sb = { rpc(name: string, args: Record<string, unknown>) {
    assert.equal(name, "discover_customer_ai_reconciliation_candidates"); calls.push(args);
    return { abortSignal: async () => ({ data: pages.shift(), error: null }) };
  } } as unknown as SupabaseClient;
  return { sb, calls };
}
const settled = { state: "settled" as const, suppressionCleared: false };
const released = { state: "released" as const, suppressionCleared: false };

test("bounded pages advance exact microseconds past all actions and surface operator review", async () => {
  const db = database([[row(0, "none"), row(1, "review")], [row(2, "investigate"), row(3, "reconcile")], [row(4, "receipt_available")], []]);
  const actions: string[] = [];
  const scan = customerAiReconciliationScan(db.sb, { reconcile: async job => { actions.push("reconcile:" + job); return released; },
    recoverReceipt: async job => { actions.push("receipt:" + job); return settled; } }, { pageSize: 2 });
  assert.deepEqual(await scan.scan(), { scanned: 2, events: [{ jobId: ids[1], status: "review" }], cycleComplete: false, reviewRequired: false });
  assert.deepEqual(await scan.scan(), { scanned: 2, events: [{ jobId: ids[2], status: "investigate" }, { jobId: ids[3], status: "released" }], cycleComplete: false, reviewRequired: false });
  assert.deepEqual(await scan.scan(), { scanned: 1, events: [{ jobId: ids[4], status: "settled" }], cycleComplete: true, reviewRequired: false });
  await scan.scan();
  assert.equal(db.calls[1]?.p_after_created_at, row(1, "review").created_at);
  assert.equal(db.calls[1]?.p_after_job_id, ids[1]); assert.equal(db.calls[3]?.p_after_created_at, null);
  assert.deepEqual(actions, ["reconcile:" + ids[3], "receipt:" + ids[4]]);
});

test("lost or malformed action remains unconfirmed until an explicit operator replay", async () => {
  const db = database([[row(0, "receipt_available")], [row(0, "receipt_available")], [row(0, "receipt_available")]]);
  let calls = 0;
  const scan = customerAiReconciliationScan(db.sb, { reconcile: async () => released, recoverReceipt: async () => {
    calls++; if (calls === 1) throw new Error("synthetic secret"); return settled;
  } }, { pageSize: 2 });
  assert.deepEqual((await scan.scan()).events, [{ jobId: ids[0], status: "unconfirmed" }]);
  assert.deepEqual((await scan.scan()).events, [{ jobId: ids[0], status: "unconfirmed" }]);
  assert.equal(calls, 1);
  assert.equal(scan.acknowledgeForExplicitReplay(ids[0]), true);
  assert.deepEqual((await scan.scan()).events, [{ jobId: ids[0], status: "settled" }]); assert.equal(calls, 2);
});

test("malformed discovery and database errors fail closed without leaking upstream content", async () => {
  const db = database([[{ ...row(0, "review"), action: "unsafe-secret" }]]);
  const scan = customerAiReconciliationScan(db.sb, { reconcile: async () => released, recoverReceipt: async () => settled });
  await assert.rejects(scan.scan(), error => { assert.ok(error instanceof Error); assert.equal(error.message, "Customer AI maintenance is unavailable.");
    assert.doesNotMatch(error.stack ?? "", /unsafe-secret/u); return true; });
  const failed = { rpc: () => ({ abortSignal: async () => ({ data: null, error: { message: "database secret" } }) }) } as unknown as SupabaseClient;
  await assert.rejects(customerAiReconciliationScan(failed, { reconcile: async () => released, recoverReceipt: async () => settled }).scan(), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.stack ?? "", /database secret/u); return true;
  });
});

test("malformed action result is surfaced as uncertain without automatic repeat", async () => {
  const db = database([[row(0, "reconcile")], [row(0, "reconcile")]]); let calls = 0;
  const scan = customerAiReconciliationScan(db.sb, { reconcile: async () => { calls++; return { state: "invented", suppressionCleared: true } as never; },
    recoverReceipt: async () => settled }, { pageSize: 2 });
  assert.equal((await scan.scan()).events[0]?.status, "unconfirmed");
  assert.equal((await scan.scan()).events[0]?.status, "unconfirmed"); assert.equal(calls, 1);
});

test("close drains the current action and stops further rows, without closing the shared runtime", async () => {
  const db = database([[row(0, "reconcile"), row(1, "receipt_available")]]);
  let release!: () => void, began!: () => void, receipts = 0;
  const started = new Promise<void>(done => { began = done; });
  const scan = customerAiReconciliationScan(db.sb, { reconcile: async () => { began(); await new Promise<void>(done => { release = done; }); return released; },
    recoverReceipt: async () => { receipts++; return settled; } }, { pageSize: 2 });
  const pending = scan.scan(); await started;
  await assert.rejects(scan.scan(), /already running/u);
  let closed = false; const closing = scan.close().then(() => { closed = true; });
  assert.equal(closed, false); release();
  assert.deepEqual(await pending, { scanned: 1, events: [{ jobId: ids[0], status: "released" }], cycleComplete: false, reviewRequired: false });
  await closing; assert.equal(receipts, 0); await assert.rejects(scan.scan(), /closed/u);
});

test("abort before or during an action prevents further work and never repeats an uncertain operation automatically", async () => {
  const db = database([[row(0, "reconcile"), row(1, "receipt_available")], [row(0, "reconcile")]]);
  const signal = new AbortController(); let calls = 0;
  const scan = customerAiReconciliationScan(db.sb, { reconcile: async () => { calls++; signal.abort(); throw new Error("lost reply"); },
    recoverReceipt: async () => settled }, { pageSize: 2 });
  const pre = new AbortController(); pre.abort();
  assert.equal((await scan.scan(pre.signal)).scanned, 0); assert.equal(db.calls.length, 0);
  assert.deepEqual(await scan.scan(signal.signal), { scanned: 1, events: [{ jobId: ids[0], status: "unconfirmed" }], cycleComplete: false, reviewRequired: false });
  // New scan starts after the previous cursor; reset by completing the short page.
  // A stale RPC response with the same cursor is rejected, not treated as safe.
  await assert.rejects(scan.scan(), /unavailable/u); assert.equal(calls, 1);
});

test("saturated uncertainty returns earlier page results and retains the last completed cursor", async () => {
  const entries = Array.from({ length: 1026 }, (_, i) => ({
    job_id: `20000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    created_at: "2026-10-28T13:00:00.123456+00:00", action: "reconcile",
  }));
  const pages = Array.from({ length: 10 }, (_, i) => entries.slice(i * 100, i * 100 + 100));
  pages.push(entries.slice(1000)); pages.push(entries.slice(1025));
  const db = database(pages); let actions = 0;
  const scan = customerAiReconciliationScan(db.sb, { reconcile: async job => {
    actions++; if (job === entries[1000]!.job_id) return released; throw new Error("unknown");
  }, recoverReceipt: async () => settled }, { pageSize: 100 });
  for (let i = 0; i < 10; i++) await scan.scan();
  const partial = await scan.scan();
  assert.equal(partial.scanned, 25); assert.equal(partial.events.length, 25);
  assert.deepEqual(partial.events[0], { jobId: entries[1000]!.job_id, status: "released" });
  assert.equal(partial.reviewRequired, true); assert.equal(partial.cycleComplete, false); assert.equal(actions, 1025);
  assert.equal(scan.acknowledgeForExplicitReplay(entries[0]!.job_id), true);
  const resumed = await scan.scan();
  assert.equal(db.calls[11]?.p_after_job_id, entries[1024]!.job_id);
  assert.equal(resumed.scanned, 1); assert.equal(actions, 1026);
});
