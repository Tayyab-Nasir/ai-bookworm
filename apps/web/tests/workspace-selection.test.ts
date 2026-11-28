import assert from "node:assert/strict";
import { test } from "node:test";
import { forgetWorkspacePreference, readWorkspacePreference, rememberWorkspace, resolveWorkspace, WorkspaceSelectionError, workspacePreferenceKey, type WorkspacePreferenceStorage } from "../lib/workspace-selection";

const available = [{ id: "workspace-a", name: "A" }, { id: "workspace-b", name: "B" }];
function preference(initial: string | null) {
  const values = new Map<string, string>();
  if (initial !== null) values.set(workspacePreferenceKey, initial);
  const writes: string[][] = [];
  const storage: WorkspacePreferenceStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { writes.push([key, value]); values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  return { storage, values, writes };
}

test("explicit authorized selection outranks the remembered workspace", () => {
  const { storage } = preference("workspace-a");
  assert.equal(resolveWorkspace(available, "workspace-b", storage), available[1]);
});

test("bare navigation restores only a currently authorized remembered ID", () => {
  const { storage } = preference("workspace-b");
  assert.equal(resolveWorkspace(available, null, storage), available[1]);
});

test("invalid explicit selection fails closed instead of falling back or rewriting preferences", () => {
  const { storage, values, writes } = preference("workspace-b");
  for (const requested of ["foreign-workspace", "", "not-a-uuid"]) {
    assert.throws(() => resolveWorkspace(available, requested, storage), WorkspaceSelectionError);
  }
  assert.equal(values.get(workspacePreferenceKey), "workspace-b");
  assert.deepEqual(writes, []);
  assert.throws(() => resolveWorkspace([], "workspace-b", storage), WorkspaceSelectionError);
});

test("stale remembered IDs are discarded on revocation or account switch", () => {
  const { storage, values } = preference("other-account-workspace");
  assert.equal(resolveWorkspace(available, undefined, storage), available[0]);
  assert.equal(values.has(workspacePreferenceKey), false);
  storage.setItem(workspacePreferenceKey, "workspace-a");
  assert.equal(resolveWorkspace([], null, storage), null);
  assert.equal(values.has(workspacePreferenceKey), false);
});

test("missing selection uses the current authorized fallback or onboarding", () => {
  const { storage } = preference(null);
  assert.equal(resolveWorkspace(available, undefined, storage), available[0]);
  assert.equal(resolveWorkspace([], undefined, storage), null);
});

test("blocked preference reads, writes and removals never block authorized access", () => {
  const storage: WorkspacePreferenceStorage = {
    getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); },
  };
  assert.equal(resolveWorkspace(available, "workspace-b", storage), available[1]);
  assert.equal(resolveWorkspace(available, null, storage), available[0]);
  assert.equal(readWorkspacePreference(storage), null);
  assert.equal(rememberWorkspace(available, "workspace-b", storage), false);
  assert.doesNotThrow(() => forgetWorkspacePreference(storage));
});

test("only authorized IDs are remembered, without workspace or account metadata", () => {
  const { storage, writes } = preference(null);
  assert.equal(rememberWorkspace(available, "foreign-workspace", storage), false);
  assert.deepEqual(writes, []);
  assert.equal(rememberWorkspace(available, "workspace-b", storage), true);
  assert.deepEqual(writes, [[workspacePreferenceKey, "workspace-b"]]);
});
