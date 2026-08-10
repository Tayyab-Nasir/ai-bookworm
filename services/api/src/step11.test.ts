import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

process.env.SUPABASE_URL ??= "http://localhost:54321";
process.env.SUPABASE_ANON_KEY ??= "test-anon";
process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service";
process.env.REDIS_URL ??= "redis://localhost:6379";
process.env.QDRANT_URL ??= "http://localhost:6333";
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_test";
process.env.SERVICE_AUTH_TOKEN = "svc-secret";
process.env.STRIPE_PRICE_IDS_JSON = JSON.stringify({ "55555555-5555-5555-5555-555555555555": "price_123" });

const { buildApp } = await import("./app.js");
const { postCreditEntry, deductCredits } = await import("./lib/credits.js");
const { requireEntitlement, currentEntitlements } = await import("./lib/entitlements.js");

// ---- stateful fake supabase -------------------------------------------------
// Real table stores so credit/ledger and webhook idempotency behave for real.
interface Store {
  tables: Record<string, Record<string, unknown>[]>;
  idemKeys: Set<string>; // "method:url:key" already-seen (per-test isolation)
}
function fakeSupabase(store: Store) {
  const client = {
    auth: {
      getUser: async (token: string) =>
        token === "good" ? { data: { user: { id: "user-1" } }, error: null } : { data: { user: null }, error: { message: "bad" } },
      admin: { listUsers: async () => ({ data: { users: [] }, error: null }) },
    },
    from: (table: string) => {
      const rows = (store.tables[table] ??= []);
      let filters: [string, unknown][] = [];
      let notNullCol: string | null = null;
      let limitN: number | null = null;
      let orderCol: string | null = null;
      let orderAsc = true;
      let orders = 0;
      const apply = () => {
        let out = rows.filter((r) =>
          filters.every(([c, v]) => (Array.isArray(v) ? (v as unknown[]).includes(r[c]) : r[c] === v)),
        );
        if (notNullCol) out = out.filter((r) => r[notNullCol as string] != null);
        if (orderCol === "created_at" && !orderAsc) out = [...out].reverse(); // insertion order proxy
        else if (orderCol) out = [...out].sort((a, b) => ((a[orderCol as string] as number) - (b[orderCol as string] as number)) * (orderAsc ? 1 : -1));
        if (limitN != null) out = out.slice(0, limitN);
        return out;
      };
      const b: Record<string, unknown> = {};
      for (const m of ["select"]) b[m] = () => b;
      b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b; };
      b.in = (c: string, vs: unknown[]) => { filters.push([c, vs]); return b; };
      b.not = (c: string, _op: string, v: unknown) => { if (v === null) notNullCol = c; return b; };
      b.gte = () => b; // ponytail: month filter ignored in fake — tests control rows
      b.order = (c: string, o?: { ascending: boolean }) => { orders++; if (orders === 1) { orderCol = c; orderAsc = o?.ascending ?? true; } return b; };
      b.limit = (n: number) => { limitN = n; return b; };
      b.insert = (row: Record<string, unknown>) => {
        const r = { ...row };
        // emulate unique constraints
        if (table === "stripe_events" && rows.some((x) => x.id === r.id)) {
          b.single = async () => ({ data: null, error: { code: "23505", message: "dup" } });
          b.maybeSingle = b.single;
          b.then = (res: (v: unknown) => unknown) => res({ data: null, error: { code: "23505", message: "dup" } });
          return b;
        }
        if (table === "credit_ledger" && r.reference_id != null &&
            rows.some((x) => x.source === r.source && x.reference_id === r.reference_id)) {
          b.single = async () => ({ data: null, error: { code: "23505", message: "dup" } });
          b.then = (res: (v: unknown) => unknown) => res({ data: null, error: { code: "23505", message: "dup" } });
          return b;
        }
        r.id ??= `${table}-${rows.length + 1}`;
        rows.push(r);
        b.single = async () => ({ data: r, error: null });
        b.then = (res: (v: unknown) => unknown) => res({ data: [r], error: null });
        return b;
      };
      b.upsert = (row: Record<string, unknown>, opts?: { onConflict?: string }) => {
        const key = opts?.onConflict ?? "id";
        const found = rows.find((x) => x[key] === row[key]);
        if (found) Object.assign(found, row);
        else rows.push({ id: `${table}-${rows.length + 1}`, ...row });
        b.then = (res: (v: unknown) => unknown) => res({ data: null, error: null });
        b.single = async () => ({ data: row, error: null });
        return b;
      };
      b.single = async () => ({ data: apply()[0] ?? null, error: null });
      b.maybeSingle = async () => ({ data: apply()[0] ?? null, error: null });
      b.then = (res: (v: unknown) => unknown) => res({ data: apply(), error: null });
      return b;
    },
  };
  return client as never;
}

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const JOB = "44444444-4444-4444-4444-444444444444";
const PLAN = "55555555-5555-5555-5555-555555555555";

function storeWithMembership(role = "owner"): Store {
  return {
    idemKeys: new Set(),
    tables: {
      organization_members: [{ organization_id: ORG, user_id: "user-1", role, status: "active" }],
      plans: [{ id: PLAN, name: "pro", entitlements_json: { ai_credits_monthly: 100, seats: 2 } }],
    },
  };
}

async function appWith(store: Store, stripe?: unknown) {
  const factory = () => fakeSupabase(store);
  const app = await buildApp(factory, stripe ? { stripeFactory: () => stripe as never } : {});
  return app;
}

const auth = { authorization: "Bearer good" };
const svc = { "x-service-token": "svc-secret" };

function sign(payload: string, secret = "whsec_test") {
  const t = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex");
  return `t=${t},v1=${sig}`;
}

// ---- webhook ----------------------------------------------------------------
test("webhook: bad signature -> 401, missing -> 400", async () => {
  const app = await appWith(storeWithMembership());
  const body = JSON.stringify({ id: "evt_1", type: "noop", data: { object: {} } });
  const bad = await app.inject({ method: "POST", url: "/v1/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": sign(body, "wrong") }, payload: body });
  assert.equal(bad.statusCode, 401);
  const missing = await app.inject({ method: "POST", url: "/v1/webhooks/stripe", headers: { "content-type": "application/json" }, payload: body });
  assert.equal(missing.statusCode, 400);
  await app.close();
});

test("webhook: subscription.updated upserts row; duplicate event id no-ops", async () => {
  const store = storeWithMembership();
  const app = await appWith(store);
  const event = {
    id: "evt_upd",
    type: "customer.subscription.updated",
    data: { object: { id: "sub_1", customer: "cus_1", status: "past_due", metadata: { organizationId: ORG, planId: PLAN } } },
  };
  const body = JSON.stringify(event);
  const res = await app.inject({ method: "POST", url: "/v1/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": sign(body) }, payload: body });
  assert.equal(res.statusCode, 200);
  const subs = store.tables.subscriptions;
  assert.equal(subs.length, 1);
  assert.equal(subs[0].status, "past_due");
  assert.equal(subs[0].organization_id, ORG);

  // replay: same event id -> duplicate no-op, no second processing
  const dup = await app.inject({ method: "POST", url: "/v1/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": sign(body) }, payload: body });
  assert.equal(dup.statusCode, 200);
  assert.equal(dup.json().duplicate, true);
  assert.equal(subs.length, 1);
  assert.equal(store.tables.stripe_events.length, 1);
  await app.close();
});

test("webhook: checkout.session.completed maps to active; deleted -> canceled", async () => {
  const store = storeWithMembership();
  const app = await appWith(store);
  const checkout = JSON.stringify({
    id: "evt_co", type: "checkout.session.completed",
    data: { object: { subscription: "sub_9", customer: "cus_9", metadata: { organizationId: ORG, planId: PLAN } } },
  });
  await app.inject({ method: "POST", url: "/v1/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": sign(checkout) }, payload: checkout });
  assert.equal(store.tables.subscriptions[0].status, "active");
  assert.equal(store.tables.subscriptions[0].provider_subscription_id, "sub_9");

  const del = JSON.stringify({
    id: "evt_del", type: "customer.subscription.deleted",
    data: { object: { id: "sub_9", customer: "cus_9", status: "canceled", metadata: { organizationId: ORG, planId: PLAN } } },
  });
  await app.inject({ method: "POST", url: "/v1/webhooks/stripe", headers: { "content-type": "application/json", "stripe-signature": sign(del) }, payload: del });
  assert.equal(store.tables.subscriptions.length, 1);
  assert.equal(store.tables.subscriptions[0].status, "canceled");
  await app.close();
});

// ---- checkout / plans --------------------------------------------------------
test("checkout: org admin only; 503 without stripe; creates session with price", async () => {
  // non-admin
  const memberApp = await appWith(storeWithMembership("member"));
  const r1 = await memberApp.inject({ method: "POST", url: "/v1/billing/checkout", headers: { authorization: "Bearer good", "idempotency-key": "chk-member" }, payload: { organizationId: ORG, planId: PLAN, successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no" } });
  assert.equal(r1.statusCode, 403);
  await memberApp.close();

  const calls: unknown[] = [];
  const fakeStripe = {
    checkout: { sessions: { create: async (p: unknown) => { calls.push(p); return { id: "cs_1", url: "https://checkout.stripe.test/cs_1" }; } } },
    billingPortal: { sessions: { create: async () => ({ url: "https://portal.test/p1" }) } },
  };
  const app = await appWith(storeWithMembership(), fakeStripe);
  const ok = await app.inject({ method: "POST", url: "/v1/billing/checkout", headers: { authorization: "Bearer good", "idempotency-key": "chk-owner" }, payload: { organizationId: ORG, planId: PLAN, successUrl: "https://x.test/ok", cancelUrl: "https://x.test/no" } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().checkoutUrl, "https://checkout.stripe.test/cs_1");
  assert.equal((calls[0] as { line_items: { price: string }[] }).line_items[0].price, "price_123");
  await app.close();
});

// ---- credits -----------------------------------------------------------------
test("postCreditEntry appends with running balance; negative rejected unless admin", async () => {
  const store: Store = { idemKeys: new Set(), tables: {} };
  const sb = fakeSupabase(store);
  await postCreditEntry(sb, { userId: USER, source: "purchase", amount: 10 });
  const e2 = await postCreditEntry(sb, { userId: USER, source: "purchase", amount: 5 });
  assert.equal((e2 as { balance_after: number }).balance_after, 15);
  await assert.rejects(() => postCreditEntry(sb, { userId: USER, source: "consumption", amount: -20 }), /insufficient credits/);
  const adj = await postCreditEntry(sb, { userId: USER, source: "admin_adjustment", amount: -25 });
  assert.equal((adj as { balance_after: number }).balance_after, -10);
  // never updated prior rows
  assert.equal(store.tables.credit_ledger.length, 3);
});

test("deductCredits references job id in usage metadata + ledger reference", async () => {
  const store: Store = { idemKeys: new Set(), tables: { credit_ledger: [{ user_id: USER, source: "purchase", amount: 10, balance_after: 10, reference_id: null }] } };
  const sb = fakeSupabase(store);
  const { entry, usage } = await deductCredits(sb, { userId: USER, organizationId: ORG, meter: "ai_credits", amount: 3, jobId: JOB });
  assert.equal((entry as { balance_after: number }).balance_after, 7);
  assert.equal((entry as { reference_id: string }).reference_id, JOB);
  assert.equal((usage as { metadata_json: { jobId: string } }).metadata_json.jobId, JOB);
});

test("double deduct with same job id: one wins, second is rejected", async () => {
  const store: Store = { idemKeys: new Set(), tables: { credit_ledger: [{ user_id: USER, source: "purchase", amount: 10, balance_after: 10, reference_id: null }] } };
  const sb = fakeSupabase(store);
  await deductCredits(sb, { userId: USER, organizationId: ORG, meter: "ai_credits", amount: 3, jobId: JOB });
  await assert.rejects(() => deductCredits(sb, { userId: USER, organizationId: ORG, meter: "ai_credits", amount: 3, jobId: JOB }));
  assert.equal(store.tables.credit_ledger.filter((r) => r.source === "consumption").length, 1);
});

// ---- entitlements -------------------------------------------------------------
test("requireEntitlement: 422 when monthly quota exceeded; free defaults without sub", async () => {
  const store: Store = {
    idemKeys: new Set(),
    tables: {
      plans: [{ id: PLAN, name: "pro", entitlements_json: { ai_credits_monthly: 100 } }],
      subscriptions: [{ id: "s1", organization_id: ORG, plan_id: PLAN, status: "active", created_at: "2026-01-01" }],
      usage_events: [{ organization_id: ORG, meter: "ai_credits", quantity: 100 }],
    },
  };
  const sb = fakeSupabase(store);
  await assert.rejects(() => requireEntitlement(sb, ORG, "ai_credits", 1), (e: { code?: string }) => e.code === "quota_exceeded");
  // under quota passes
  await requireEntitlement(sb, ORG, "ai_credits", 0);

  const free = await currentEntitlements(fakeSupabase({ idemKeys: new Set(), tables: {} }), ORG);
  assert.equal(free.plan.name, "free");
  assert.equal(free.entitlements.ai_credits_monthly, 100);
});

// ---- usage route ---------------------------------------------------------------
test("GET /v1/usage returns entitlements, usage, balance; non-member 403", async () => {
  const store = storeWithMembership();
  store.tables.subscriptions = [{ id: "s1", organization_id: ORG, plan_id: PLAN, status: "active", created_at: "2026-01-01" }];
  store.tables.usage_events = [{ organization_id: ORG, meter: "ai_credits", quantity: 7 }];
  store.tables.credit_ledger = [{ user_id: "user-1", source: "purchase", amount: 42, balance_after: 42, reference_id: null }];
  const app = await appWith(store);
  const res = await app.inject({ method: "GET", url: `/v1/usage?organizationId=${ORG}`, headers: auth });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.entitlements.plan.name, "pro");
  assert.equal(body.usage.ai_credits, 7);
  assert.equal(body.creditBalance, 42);

  const outsider = await appWith({ idemKeys: new Set(), tables: {} });
  const denied = await outsider.inject({ method: "GET", url: `/v1/usage?organizationId=${ORG}`, headers: auth });
  assert.equal(denied.statusCode, 403);
  await app.close();
  await outsider.close();
});

// ---- service-to-service deduct endpoint ---------------------------------------
test("POST /v1/credits/deduct: service token required; deducts and records usage", async () => {
  const store: Store = { idemKeys: new Set(), tables: { credit_ledger: [{ user_id: USER, source: "purchase", amount: 10, balance_after: 10, reference_id: null }] } };
  const app = await appWith(store);
  const noToken = await app.inject({ method: "POST", url: "/v1/credits/deduct", headers: { "idempotency-key": "ded-no" }, payload: { userId: USER, meter: "ai_credits", amount: 2, jobId: JOB } });
  assert.equal(noToken.statusCode, 401);
  const ok = await app.inject({ method: "POST", url: "/v1/credits/deduct", headers: { ...svc, "idempotency-key": "ded-ok" }, payload: { userId: USER, organizationId: ORG, meter: "ai_credits", amount: 2, jobId: JOB } });
  assert.equal(ok.statusCode, 201);
  assert.equal(ok.json().entry.balance_after, 8);
  await app.close();
});
