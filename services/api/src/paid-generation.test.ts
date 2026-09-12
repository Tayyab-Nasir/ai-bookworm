import { test } from "node:test";
import assert from "node:assert/strict";
import { currentEntitlements, requireEntitlement } from "./lib/entitlements.js";

function database(subscription: unknown = null, plan: unknown = null) {
  return { from(table: string) {
    const builder = {
      select() { return builder; }, eq() { return builder; }, in() { return builder; },
      order() { return builder; }, limit() { return builder; }, gte() { return builder; },
      async maybeSingle() { return { data: table === "subscriptions" ? subscription : plan, error: null }; },
      then(resolve: (value: unknown) => unknown) { return resolve({ data: [], error: null }); },
    };
    return builder;
  } } as never;
}

test("unpaid accounts receive no text or image generation allowance", async () => {
  const db = database();
  const { entitlements } = await currentEntitlements(db, "org");
  assert.equal(entitlements.ai_credits_monthly, 0);
  assert.equal(entitlements.image_credits_monthly, 0);
  for (const meter of ["ai_credits", "image_credits"]) {
    await assert.rejects(requireEntitlement(db, "org", meter, 1), { code: "quota_exceeded" });
  }
});

test("missing plan cannot silently grant paid generation; explicit allowances still work", async () => {
  const sub = { id: "subscription", plan_id: "paid", status: "active", current_period_end: null };
  await assert.rejects(requireEntitlement(database(sub), "org", "ai_credits", 1), { code: "quota_exceeded" });
  const db = database(sub, { id: "paid", name: "Paid", entitlements_json: { ai_credits_monthly: 10, image_credits_monthly: 2 } });
  await requireEntitlement(db, "org", "ai_credits", 1);
  await requireEntitlement(db, "org", "image_credits", 1);
});
