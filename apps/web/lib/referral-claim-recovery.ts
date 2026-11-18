// A claim may commit after its HTTP reply is lost. Keep the original code per
// account so a retry cannot race the first claim with a different referrer.
export type ReferralClaim = { actor: string; code: string };

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const codePattern = /^[a-z0-9-]{1,64}$/u;
const key = (actor: string) => `bookworm:referral-claim:v1:${actor}`;

export function readReferralClaim(storage: Storage, actor: string): ReferralClaim | null {
  if (!uuid.test(actor)) throw new Error("The referral account could not be verified.");
  const raw = storage.getItem(key(actor));
  if (raw === null) return null;
  if (raw.length > 256) throw new Error("Referral recovery is unreadable. Contact support before claiming another code.");
  let item: unknown;
  try { item = JSON.parse(raw); } catch { throw new Error("Referral recovery is unreadable. Contact support before claiming another code."); }
  const value = item as Partial<ReferralClaim> | null;
  if (!value || value.actor !== actor || typeof value.code !== "string" || !codePattern.test(value.code)) {
    throw new Error("Referral recovery is unreadable. Contact support before claiming another code.");
  }
  return { actor, code: value.code };
}

export function beginReferralClaim(storage: Storage, actor: string, code: string): ReferralClaim {
  if (!uuid.test(actor) || !codePattern.test(code)) throw new Error("Enter a valid referral code.");
  if (readReferralClaim(storage, actor)) throw new Error("A previous claim still needs confirmation.");
  const claim = { actor, code };
  const encoded = JSON.stringify(claim);
  storage.setItem(key(actor), encoded);
  if (storage.getItem(key(actor)) !== encoded) throw new Error("Referral recovery could not be saved. No claim was sent.");
  return claim;
}

export function clearReferralClaim(storage: Storage, claim: ReferralClaim): void {
  const current = readReferralClaim(storage, claim.actor);
  if (!current || current.code !== claim.code) throw new Error("Referral recovery changed. Contact support before claiming another code.");
  storage.removeItem(key(claim.actor));
  if (storage.getItem(key(claim.actor)) !== null) throw new Error("Referral recovery could not be cleared. Contact support before claiming another code.");
}
