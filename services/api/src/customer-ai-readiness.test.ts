import assert from "node:assert/strict";
import { test } from "node:test";
import { customerAiReadiness, isCustomerAiReady } from "./lib/customer-ai-readiness.js";

const current = 1_800_000_000_000;
const expected = { deploymentId: "deploy", projectRef: "project", serviceId: "service", keyId: "key", schemaRevision: "revision" };
function fixture() {
  const identity: Record<string, unknown> = { deploymentId: "deploy", serviceId: "service", keyId: "key", identityVerified: true, observedAt: current };
  const database: Record<string, unknown> = { deploymentId: "deploy", projectRef: "project", schemaRevision: "revision", aclVerified: true, observedAt: current };
  const worker: Record<string, unknown> = { deploymentId: "deploy", projectRef: "project", serviceId: "service", keyId: "key", kind: "customer_generation", ready: true, observedAt: current, expiresAt: current + 4000 };
  const state = { enabled: true };
  const config = { expected, now: () => current, operatorEnabled: () => state.enabled,
    verifyIdentity: async (_signal: AbortSignal): Promise<unknown> => identity,
    verifyDatabase: async (_signal: AbortSignal): Promise<unknown> => database,
    verifyWorker: async (_signal: AbortSignal): Promise<unknown> => worker };
  return { identity, database, worker, state, config };
}

test("requires a coordinator, all independently verified fresh proofs and active operator gate", async () => {
  const f = fixture(), ready = customerAiReadiness(f.config);
  assert(Object.isFrozen(ready)); assert.equal(await isCustomerAiReady(ready), true);
  assert.equal(await isCustomerAiReady(undefined), false);
  assert.equal(await isCustomerAiReady({ check: async () => true }), false);
  f.state.enabled = false; assert.equal(await isCustomerAiReady(ready), false);
  f.state.enabled = true;
  f.config.verifyWorker = async () => { f.state.enabled = false; return f.worker; };
  assert.equal(await isCustomerAiReady(customerAiReadiness(f.config)), false);
});

test("rejects stale, expired, future, misbound, malformed and insufficient scope evidence", async () => {
  const cases: [keyof Pick<ReturnType<typeof fixture>, "identity" | "database" | "worker">, string, unknown][] = [
    ["identity", "observedAt", current - 5001], ["database", "observedAt", current + 1],
    ["worker", "observedAt", current - 5001], ["worker", "expiresAt", current],
    ["worker", "expiresAt", current + 5001], ["identity", "deploymentId", "other"],
    ["identity", "serviceId", "other"], ["identity", "keyId", "other"], ["identity", "identityVerified", false],
    ["database", "deploymentId", "other"], ["database", "projectRef", "other"], ["database", "schemaRevision", "other"],
    ["database", "aclVerified", false], ["worker", "deploymentId", "other"], ["worker", "projectRef", "other"],
    ["worker", "serviceId", "other"], ["worker", "keyId", "other"], ["worker", "kind", "maintenance"],
    ["worker", "ready", false], ["worker", "unexpected", "x"], ["identity", "observedAt", null],
  ];
  for (const [proof, field, value] of cases) {
    const f = fixture(); f[proof][field] = value;
    assert.equal(await isCustomerAiReady(customerAiReadiness(f.config)), false, `${proof}.${field}`);
  }
});

test("timeouts, rejected verifiers and invalid config fail closed without exposing errors", async () => {
  const f = fixture();
  f.config.verifyIdentity = async () => { throw new Error("private-detail"); };
  assert.equal(await isCustomerAiReady(customerAiReadiness(f.config)), false);
  let abortSignal: AbortSignal | undefined;
  f.config.verifyIdentity = async signal => { abortSignal = signal; return new Promise(() => {}); };
  assert.equal(await isCustomerAiReady(customerAiReadiness({ ...f.config, timeoutMs: 5 })), false);
  assert.equal(abortSignal?.aborted, true);
  assert.throws(() => customerAiReadiness({ ...f.config, maxAgeMs: 60000 }), /configuration is invalid/);
});
