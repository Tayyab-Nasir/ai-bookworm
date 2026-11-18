import assert from "node:assert/strict";
import { test } from "node:test";
import { beginReferralClaim, clearReferralClaim, readReferralClaim } from "../lib/referral-claim-recovery";

const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
function storage(): Storage {
  const entries = new Map<string, string>();
  return { get length() { return entries.size; }, key: index => [...entries.keys()][index] ?? null,
    getItem: key => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); },
    removeItem: key => { entries.delete(key); }, clear: () => entries.clear() };
}

test("referral claim fence stays account-bound and cannot be overwritten", () => {
  const store = storage();
  const claim = beginReferralClaim(store, a, "bw-first123");
  assert.deepEqual(readReferralClaim(store, a), claim);
  assert.equal(readReferralClaim(store, b), null);
  assert.throws(() => beginReferralClaim(store, a, "bw-other123"), /previous claim/);
  assert.throws(() => clearReferralClaim(store, { actor: a, code: "bw-other123" }), /changed/);
  assert.deepEqual(readReferralClaim(store, a), claim);
  clearReferralClaim(store, claim);
  assert.equal(readReferralClaim(store, a), null);
});

test("invalid and unwritable recovery fail closed", () => {
  const store = storage();
  assert.throws(() => beginReferralClaim(store, a, "../bad"), /valid referral code/);
  store.setItem(`bookworm:referral-claim:v1:${a}`, "corrupt");
  assert.throws(() => readReferralClaim(store, a), /unreadable/);
  assert.throws(() => beginReferralClaim(store, a, "bw-valid"), /unreadable/);
  const blocked = { ...storage(), setItem() { throw new Error("QuotaExceededError"); } } as Storage;
  assert.throws(() => beginReferralClaim(blocked, a, "bw-valid"), /QuotaExceededError/);
});
