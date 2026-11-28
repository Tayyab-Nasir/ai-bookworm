import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { customerAiMaintenanceJournal, type CustomerAiMaintenanceIdentity } from "./lib/customer-ai-maintenance-journal.js";

const id = (): CustomerAiMaintenanceIdentity => ({ attemptId: randomUUID(), jobId: randomUUID(), action: "recover_receipt" });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body),
  { status, headers: { "content-type": "application/json", "retry-after": "1" } });
const config = { databaseUrl: "https://database.invalid", serviceRoleKey: "synthetic-private-service-role" };

test("lost begin and execute remain unknown until an explicit read of the same saved identity", async () => {
  const saved = id(), calls: Array<{ name: string; args: unknown }> = [];
  let phase = "begin";
  const client = customerAiMaintenanceJournal({ ...config, databaseFetch: async (input, init) => {
    const name = new URL(input instanceof Request ? input.url : String(input)).pathname.split("/").at(-1)!;
    calls.push({ name, args: JSON.parse(String(init?.body)) }); assert.equal(init?.redirect, "error");
    if (phase === "begin" || phase === "execute") return json({ message: "synthetic-secret" }, 503);
    return json({ ...saved, state: phase === "pending" ? "pending" : "completed", result: phase === "pending" ? null : "settled" });
  } });
  assert.deepEqual(await client.begin(saved), { status: "unknown", identity: saved });
  phase = "pending"; assert.deepEqual(await client.read(saved), { status: "confirmed", receipt: { ...saved, state: "pending", result: null } });
  phase = "execute"; assert.deepEqual(await client.execute(saved), { status: "unknown", identity: saved });
  phase = "completed"; assert.deepEqual(await client.read(saved), { status: "confirmed", receipt: { ...saved, state: "completed", result: "settled" } });
  assert.deepEqual(calls, [
    { name: "begin_customer_ai_maintenance", args: { p_attempt_id: saved.attemptId, p_job_id: saved.jobId, p_action: saved.action } },
    { name: "read_customer_ai_maintenance", args: { p_attempt_id: saved.attemptId } },
    { name: "execute_customer_ai_maintenance", args: { p_attempt_id: saved.attemptId } },
    { name: "read_customer_ai_maintenance", args: { p_attempt_id: saved.attemptId } },
  ]);
  client.close();
});

test("identity spoof, malformed results and database errors never become confirmation", async () => {
  const saved = id(); let value: unknown; let count = 0;
  const client = customerAiMaintenanceJournal({ ...config, databaseFetch: async () => { count++; return json(value); } });
  for (const mutation of [
    { ...saved, attemptId: randomUUID(), state: "pending", result: null },
    { ...saved, jobId: randomUUID(), state: "pending", result: null },
    { ...saved, action: "reconcile", state: "pending", result: null },
    { ...saved, state: "pending", result: "settled" },
    { ...saved, state: "completed", result: "released" },
    { ...saved, state: "completed", result: "settled", secret: "private" },
    null,
  ]) {
    value = mutation; assert.deepEqual(await client.read(saved), { status: "unknown", identity: saved });
  }
  assert.equal(count, 7); client.close();
});

test("abort during a non-cooperative call returns unknown once and ignores late completion", async () => {
  const saved = id(), controller = new AbortController(); let calls = 0, release!: (response: Response) => void, started!: () => void;
  const began = new Promise<void>(done => { started = done; });
  const client = customerAiMaintenanceJournal({ ...config, databaseFetch: () => { calls++; started(); return new Promise(done => { release = done; }); } });
  const pending = client.execute(saved, controller.signal); await began; controller.abort();
  assert.deepEqual(await pending, { status: "unknown", identity: saved });
  release(json({ ...saved, state: "completed", result: "settled" })); await Promise.resolve(); assert.equal(calls, 1);
  const aborted = new AbortController(); aborted.abort(); assert.deepEqual(await client.begin(saved, aborted.signal), { status: "unknown", identity: saved });
  assert.equal(calls, 1); client.close(); await assert.rejects(client.read(saved), /journal is unavailable/u);
});

test("strict caller identity and configuration validation never expose credentials", async () => {
  const saved = id(); let calls = 0;
  const client = customerAiMaintenanceJournal({ ...config, databaseFetch: async () => { calls++; return json(null); } });
  await assert.rejects(client.begin({ ...saved, attemptId: "invalid" }), /journal is unavailable/u);
  await assert.rejects(client.execute({ ...saved, extra: "private" } as never), /journal is unavailable/u);
  assert.equal(calls, 0); client.close();
  assert.throws(() => customerAiMaintenanceJournal({ ...config, databaseUrl: "https://user:password@example.invalid" }), error => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.stack ?? "", /password|synthetic-private/u); return true;
  });
});
