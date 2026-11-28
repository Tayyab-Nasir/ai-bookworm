import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { createClient } from "../../../packages/api-client/src/index.js";
import { clearPendingWorkspaceCreation, readPendingWorkspaceCreation, savePendingWorkspaceCreation } from "../lib/workspace-creation-recovery.js";

test("workspace creation and recovery bind the actor and original operation", async () => {
  const actor = randomUUID(), other = randomUUID(), operationId = randomUUID(), workspaceId = randomUUID();
  const original = globalThis.fetch, calls: { url: string; init: RequestInit }[] = [];
  let result: unknown = { viewerId: actor, operationId, workspace: { id: workspaceId, created_by: actor } };
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return Response.json(result); };
  try {
    const api = createClient({ baseUrl: "http://local.test", idempotencyKey: () => { throw new Error("Do not create a second request identity"); } });
    assert.equal((await api.createOnboardingWorkspace({ name: "Studio", operationId }, actor)).workspace.id, workspaceId);
    result = { viewerId: actor, receipt: { operationId, status: "not_found", workspaceId: null } };
    assert.equal((await api.recoverWorkspaceCreation(operationId, actor)).status, "not_found");
    result = { viewerId: actor, receipt: { operationId, status: "closed", workspaceId: null } };
    assert.equal((await api.recoverWorkspaceCreation(operationId, actor, true)).status, "closed");
    assert.deepEqual(calls.map(call => call.url), ["http://local.test/v1/workspaces/onboarding", "http://local.test/v1/workspaces/onboarding/check", "http://local.test/v1/workspaces/onboarding/close"]);
    for (const call of calls) { assert.equal(new Headers(call.init.headers).get("x-bookworm-actor"), actor); assert(!new Headers(call.init.headers).has("idempotency-key")); }
    for (const invalid of [
      { viewerId: other, receipt: { operationId, status: "closed", workspaceId: null } },
      { viewerId: actor, receipt: { operationId: randomUUID(), status: "closed", workspaceId: null } },
      { viewerId: actor, receipt: { operationId, status: "created", workspaceId: null } },
      { viewerId: actor, receipt: { operationId, status: "not_found", workspaceId: null } },
    ]) { result = invalid; await assert.rejects(api.recoverWorkspaceCreation(operationId, actor, true)); }
    result = { viewerId: actor, operationId, workspace: { id: workspaceId, created_by: other } };
    await assert.rejects(api.createOnboardingWorkspace({ name: "Studio", operationId }, actor));
  } finally { globalThis.fetch = original; }
});

test("workspace recovery stores only one opaque operation per account", () => {
  const actor = randomUUID(), other = randomUUID(), operationId = randomUUID(), store = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key),
  } });
  try {
    savePendingWorkspaceCreation(actor, operationId);
    assert.equal(readPendingWorkspaceCreation(actor), operationId); assert.equal(readPendingWorkspaceCreation(other), null);
    assert.deepEqual([...store.values()], [operationId]);
    assert.throws(() => savePendingWorkspaceCreation(actor, randomUUID()));
    clearPendingWorkspaceCreation(actor, randomUUID()); assert.equal(readPendingWorkspaceCreation(actor), operationId);
    clearPendingWorkspaceCreation(actor, operationId); assert.equal(store.size, 0);
    assert.throws(() => savePendingWorkspaceCreation("not-an-actor", operationId));
  } finally { if (original) Object.defineProperty(globalThis, "sessionStorage", original); else Reflect.deleteProperty(globalThis, "sessionStorage"); }
});
