import assert from "node:assert/strict";
import { test } from "node:test";
import { rememberReferral, claimPendingReferral } from "../lib/referrals";

function storage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }, clear: () => values.clear(),
  };
}
const key = "bookworm:pendingReferral";

test("attribution survives rate limits and expired sessions, then clears on success", async () => {
  const store = storage();
  rememberReferral("?ref=BW-A1B2C3D4", store);
  assert.equal(store.getItem(key), "bw-a1b2c3d4");
  for (const status of [401, 403, 429, 503]) {
    await claimPendingReferral(async () => { throw { status }; }, store);
    assert.equal(store.getItem(key), "bw-a1b2c3d4");
  }
  await claimPendingReferral(async (code) => assert.equal(code, "bw-a1b2c3d4"), store);
  assert.equal(store.getItem(key), null);
});

test("blocked storage is harmless and invalid codes are ignored", async () => {
  const store = storage();
  rememberReferral("?ref=invalid", store);
  assert.equal(store.length, 0);
  const blocked = { getItem() { throw new Error("SecurityError"); }, setItem() { throw new Error("QuotaExceededError"); } } as unknown as Storage;
  assert.doesNotThrow(() => rememberReferral("?ref=bw-a1b2c3d4", blocked));
  await claimPendingReferral(async () => assert.fail("must not claim"), blocked);
});

test("duplicate mounts share the request and never clear a newer invitation", async () => {
  const store = storage();
  rememberReferral("?ref=bw-a1b2c3d4", store);
  let finish!: () => void;
  let calls = 0;
  const claim = async () => { calls++; await new Promise<void>((resolve) => { finish = resolve; }); };
  const first = claimPendingReferral(claim, store);
  const second = claimPendingReferral(claim, store);
  assert.equal(calls, 1);
  rememberReferral("?ref=bw-12345678", store);
  finish();
  await Promise.all([first, second]);
  assert.equal(store.getItem(key), "bw-12345678");
  await claimPendingReferral(async () => { throw { status: 422 }; }, store);
  assert.equal(store.getItem(key), null);
});
