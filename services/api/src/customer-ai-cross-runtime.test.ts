import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { test } from "node:test";
import { credentialVault } from "./lib/ai-connection-vault.js";
import { customerDispatchSigner, prepareCustomerDispatch, type CustomerDispatchScope } from "./lib/customer-ai-dispatch.js";
import { customerAiComposition } from "./lib/customer-ai-composition.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["path", "systemroot", "windir", "temp", "tmp", "bookworm_python"].includes(key.toLowerCase())));
Object.assign(env, { PYTHONPATH: join(root, "services/ai") + (process.platform === "win32" ? ";" : ":") + join(root, "services/ai/tests"),
  PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" });
function bridge(input: unknown) {
  const child = spawnSync(process.execPath, [join(root, "scripts/run-python.mjs"), join(root, "services/ai/tests/customer_cross_runtime_bridge.py")],
    { cwd: root, env, input: JSON.stringify(input), timeout: 20_000, maxBuffer: 1_048_576 });
  // The subprocess receives only synthetic values; do not echo raw stderr or envelope.
  assert.equal(child.status, 0, "Synthetic private-app bridge failed.");
  return JSON.parse(child.stdout.toString("utf8"));
}

test("TypeScript scheduler signs a job consumed by the actual Python ASGI app with one synthetic provider call", async () => {
  const [scope, request] = bridge({ action: "fixture" }) as [CustomerDispatchScope, unknown];
  const prepared = prepareCustomerDispatch(scope, request), events: string[] = [];
  const job = { id: scope.jobId, workspace_id: scope.workspaceId, book_id: scope.bookId, created_by: scope.ownerId,
    agent_type: scope.agentType, billing_mode: "customer_key", model: scope.policy.model,
    input_ref: { customerGrantId: scope.grantId, requestSha256: scope.expectedRequestSha256 }, status: "running", lease_token: scope.leaseToken };
  const vault = credentialVault({ AI_CONNECTION_VAULT_KEYRING_JSON: JSON.stringify({ active: "test", keys: { test: randomBytes(32).toString("base64") } }) })!;
  const binding = { ownerId: scope.ownerId, provider: scope.provider, connectionId: scope.connectionId, revision: scope.credentialRevision };
  const credential = vault.seal("synthetic-customer-credential-0001", binding);
  const signer = customerDispatchSigner("synthetic", Buffer.from(Array.from({ length: 32 }, (_, i) => i)), () => 1900000000);
  let receipt: any, posts = 0;
  const databaseFetch: typeof fetch = async (input, init) => {
    const name = new URL(input instanceof Request ? input.url : String(input)).pathname.split("/").at(-1)!; events.push(name);
    const args = JSON.parse(String(init?.body ?? "{}"));
    const reply = (value: unknown) => Response.json(value);
    if (name === "discover_customer_ai_ready_jobs") return reply([{ job_id: job.id, created_at: "2026-10-28T13:00:00.123456+00:00", ready: true }]);
    assert.equal(args.p_job_id, job.id);
    if (name === "claim_customer_ai_job") return reply(job);
    if (name === "prepare_customer_ai_dispatch") return reply({ scope, request });
    if (name === "resolve_customer_ai_dispatch") { assert.equal(args.p_fingerprint, prepared.fingerprint); return reply({ scope, request, credential }); }
    if (name === "complete_customer_ai_job") {
      assert.equal(receipt.customerDispatchSha256, prepared.fingerprint); assert.equal(receipt.status, "succeeded");
      assert.equal(receipt.usage.estimatedCostUsd, null); assert.equal(args.p_owner_id, scope.ownerId);
      return reply({ ...job, status: "succeeded", lease_token: null,
        output_ref: { customerDispatchSha256: prepared.fingerprint, costPayer: "customer", providerCostStatus: "unknown", reviewRequired: true } });
    }
    throw new Error("Unexpected synthetic database operation");
  };
  const serviceFetch: typeof fetch = async (_url, init) => {
    posts++; assert.equal(init?.redirect, "error");
    const body = init?.body as Buffer;
    const proof = bridge({ action: "dispatch", body: body.toString("base64") });
    assert.equal(proof.status, 201); assert.equal(proof.providerCalls, 1); assert.equal(proof.receiptCount, 1);
    receipt = proof.result;
    // A lost HTTP response must recover the saved receipt, not send again.
    throw new Error("Synthetic lost reply");
  };
  const runtime = customerAiComposition({ databaseUrl: "https://database.invalid", serviceRoleKey: "synthetic-private-database-token",
    serviceUrl: "https://private.invalid", serviceToken: "synthetic-private-service-token", mode: "test", vault, signer, databaseFetch, serviceFetch });
  try {
    assert.deepEqual(await runtime.tick(), { scanned: 1, attempted: 1, uncertain: 0, suppressed: 0, cycleComplete: true });
    assert.equal(posts, 1);
    assert.deepEqual(events, ["discover_customer_ai_ready_jobs", "claim_customer_ai_job", "prepare_customer_ai_dispatch",
      "resolve_customer_ai_dispatch", "complete_customer_ai_job"]);
  } finally { await runtime.close(); signer.dispose(); }
});
