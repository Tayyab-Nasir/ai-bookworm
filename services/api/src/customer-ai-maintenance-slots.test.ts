import assert from "node:assert/strict";
import { test } from "node:test";
import { customerAiMaintenanceSlots } from "./lib/customer-ai-maintenance-slots.js";

const config = { databaseUrl: "https://database.invalid", serviceRoleKey: "synthetic-private-service-role" };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json", "retry-after": "1" } });
const job = "10000000-0000-4000-8000-000000000001", other = "10000000-0000-4000-8000-000000000002";
const attemptId = "20000000-0000-4000-8000-000000000001", otherAttempt = "20000000-0000-4000-8000-000000000002";
const selection = { jobId: job, action: "recover_receipt" as const };
const ack = { ...selection, attemptId, version: 1 };
const open = { status: "open", version: 1, attempt: { ...selection, attemptId, state: "pending", result: null } };

test("lost open and ack use one call each; explicit restart recovers the same database identity", async () => {
  const calls: Array<{ name: string; args: unknown }> = []; let available = false;
  const fetcher: typeof fetch = async (input, init) => {
    const name = new URL(input instanceof Request ? input.url : String(input)).pathname.split("/").at(-1)!;
    calls.push({ name, args: JSON.parse(String(init?.body)) }); assert.equal(init?.redirect, "error");
    if (!available) return json({ secret: "never echo" }, 503);
    return json(name === "open_customer_ai_maintenance_slot" ? open : { status: "observed", attemptId, version: 1, result: "settled" });
  };
  let client = customerAiMaintenanceSlots({ ...config, databaseFetch: fetcher });
  assert.deepEqual(await client.open(selection), { status: "unknown", request: selection }); client.close();
  available = true; client = customerAiMaintenanceSlots({ ...config, databaseFetch: fetcher });
  assert.deepEqual(await client.open(selection), { status: "confirmed", value: open });
  available = false; assert.deepEqual(await client.ack(ack), { status: "unknown", request: ack });
  available = true; assert.deepEqual(await client.ack(ack), { status: "confirmed", value: { status: "observed", attemptId, version: 1, result: "settled" } });
  assert.deepEqual(calls.map(c => c.name), ["open_customer_ai_maintenance_slot", "open_customer_ai_maintenance_slot", "ack_customer_ai_maintenance_slot", "ack_customer_ai_maintenance_slot"]);
  assert.deepEqual(calls[2]?.args, { p_job_id: job, p_action: "recover_receipt", p_attempt_id: attemptId, p_version: 1 }); client.close();
});

test("spoofed identities, states, versions and extra data cannot become confirmed", async () => {
  let response: unknown, count = 0;
  const client = customerAiMaintenanceSlots({ ...config, databaseFetch: async () => { count++; return json(response); } });
  for (const bad of [
    { ...open, version: 0 }, { ...open, attempt: { ...open.attempt, jobId: other } },
    { ...open, attempt: { ...open.attempt, action: "reconcile" } },
    { ...open, attempt: { ...open.attempt, state: "pending", result: "settled" } },
    { ...open, attempt: { ...open.attempt, state: "completed", result: "released" } },
    { ...open, attempt: { ...open.attempt, secret: "private" } }, { status: "not_actionable", secret: "private" },
  ]) { response = bad; assert.deepEqual(await client.open(selection), { status: "unknown", request: selection }); }
  for (const bad of [
    { status: "observed", attemptId: otherAttempt, version: 1, result: "settled" },
    { status: "observed", attemptId, version: 2, result: "settled" },
    { status: "observed", attemptId, version: 1, result: "released" },
    { status: "observed", attemptId, version: 1, result: "settled", extra: "private" },
  ]) { response = bad; assert.deepEqual(await client.ack(ack), { status: "unknown", request: ack }); }
  assert.equal(count, 11); client.close();
});

test("slot pages enforce exact ordering, binding and bounded cursors", async () => {
  let response: unknown; const calls: unknown[] = [];
  const client = customerAiMaintenanceSlots({ ...config, databaseFetch: async (_input, init) => { calls.push(JSON.parse(String(init?.body))); return json(response); } });
  const one = { job_id: job, action: "reconcile", version: 1, attempt_id: attemptId, state: "pending", result: null };
  const two = { job_id: other, action: "recover_receipt", version: 3, attempt_id: otherAttempt, state: "completed", result: "settled" };
  response = [one, two];
  assert.deepEqual(await client.listSlots({ limit: 2 }), { status: "confirmed", value: { rows: [one, two], nextCursor: { jobId: other, action: "recover_receipt" } } });
  response = [one]; const cursor = { jobId: other, action: "recover_receipt" as const };
  assert.deepEqual(await client.listSlots({ limit: 2, cursor }), { status: "unknown", request: { limit: 2, cursor } });
  response = [two, one]; assert.deepEqual(await client.listSlots({ limit: 2 }), { status: "unknown", request: { limit: 2 } });
  response = [one, { ...two, attempt_id: attemptId }]; assert.deepEqual(await client.listSlots({ limit: 2 }), { status: "unknown", request: { limit: 2 } });
  response = [{ ...one, result: "settled" }]; assert.deepEqual(await client.listSlots({ limit: 2 }), { status: "unknown", request: { limit: 2 } });
  assert.deepEqual(calls[0], { p_limit: 2, p_after_job_id: null, p_after_action: null }); client.close();
});

test("observation cursor retains and orders sub-millisecond precision", async () => {
  let response: unknown;
  const client = customerAiMaintenanceSlots({ ...config, databaseFetch: async () => json(response) });
  const one = { attempt_id: attemptId, job_id: job, action: "reconcile", slot_version: 1, result: "unchanged", created_at: "2026-10-28T13:00:00.123456+00:00" };
  const two = { attempt_id: otherAttempt, job_id: job, action: "recover_receipt", slot_version: 2, result: "settled", created_at: "2026-10-28T13:00:00.123457+00:00" };
  response = [one, two];
  assert.deepEqual(await client.listObservations({ limit: 2 }), { status: "confirmed", value: { rows: [one, two], nextCursor: { createdAt: two.created_at, attemptId: otherAttempt } } });
  response = [two, one]; assert.deepEqual(await client.listObservations({ limit: 2 }), { status: "unknown", request: { limit: 2 } });
  response = [one, { ...two, attempt_id: attemptId }]; assert.deepEqual(await client.listObservations({ limit: 2 }), { status: "unknown", request: { limit: 2 } });
  response = [one, { ...one, attempt_id: otherAttempt, created_at: two.created_at }]; assert.deepEqual(await client.listObservations({ limit: 2 }), { status: "unknown", request: { limit: 2 } });
  response = [{ ...one, created_at: "2026-02-30T13:00:00.123456+00:00" }]; assert.deepEqual(await client.listObservations({ limit: 2 }), { status: "unknown", request: { limit: 2 } });
  response = [{ ...two, result: "released" }]; assert.deepEqual(await client.listObservations({ limit: 2 }), { status: "unknown", request: { limit: 2 } });
  const cursor = { createdAt: two.created_at, attemptId: otherAttempt }; response = [one];
  assert.deepEqual(await client.listObservations({ limit: 1, cursor }), { status: "unknown", request: { limit: 1, cursor } }); client.close();
});

test("abort, close and invalid inputs never trigger extra calls or disclose configuration", async () => {
  let release!: (response: Response) => void, started!: () => void, calls = 0;
  const began = new Promise<void>(done => { started = done; });
  const client = customerAiMaintenanceSlots({ ...config, databaseFetch: () => { calls++; started(); return new Promise(done => { release = done; }); } });
  const controller = new AbortController(), running = client.ack(ack, controller.signal); await began; controller.abort();
  assert.deepEqual(await running, { status: "unknown", request: ack });
  release(json({ status: "observed", attemptId, version: 1, result: "settled" })); await Promise.resolve(); assert.equal(calls, 1);
  const pre = new AbortController(); pre.abort(); assert.deepEqual(await client.open(selection, pre.signal), { status: "unknown", request: selection });
  await assert.rejects(client.ack({ ...ack, version: 0 }), /unavailable/u);
  await assert.rejects(client.listSlots({ limit: 101 }), /unavailable/u);
  assert.equal(calls, 1); client.close(); await assert.rejects(client.open(selection), /unavailable/u);
  assert.throws(() => customerAiMaintenanceSlots({ ...config, databaseUrl: "https://user:password@example.invalid" }), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.stack ?? "", /password|synthetic-private/u); return true;
  });
});
