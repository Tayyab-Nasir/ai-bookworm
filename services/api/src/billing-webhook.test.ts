import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { stripeWebhookRoutes } from "./routes/billing.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { boundedStripeFetch, planPriceIds, retrieveStripeSubscription, verifyWebhookSignature } from "./lib/stripe.js";
import type { SupabaseFactory } from "./lib/supabase.js";

process.env.STRIPE_WEBHOOK_SECRET = "whsec_synthetic_atomic";
process.env.STRIPE_PRICE_IDS_JSON = JSON.stringify({ "11111111-1111-4111-8111-111111111111": "price_synthetic" });
const ORG = "22222222-2222-4222-8222-222222222222";
const PLAN = "11111111-1111-4111-8111-111111111111";
const snapshot = (status = "active") => ({ id: "sub_synthetic", customer: "cus_synthetic", status, livemode: false,
  metadata: { organizationId: ORG, planId: PLAN }, items: { has_more: false,
    data: [{ quantity: 1, price: { id: "price_synthetic" }, current_period_end: 1800000000 }] } });
function sign(body: string, timestamp = String(Math.floor(Date.now() / 1000))) {
  return `t=${timestamp},v1=${createHmac("sha256", "whsec_synthetic_atomic").update(`${timestamp}.${body}`).digest("hex")}`;
}
function fixture() {
  const events = new Map<string, Record<string, unknown>>();
  const subscriptions = new Map<string, Record<string, unknown>>();
  let fail = true;
  let reads = 0;
  let current: unknown = snapshot();
  let binding: { organizationId: string | null; planId: string | null; customerId: string | null } | null = null;
  const calls: string[] = [];
  const sb = {
    from(name: string) {
      let id: string;
      const q = { select() { return q; }, eq(_key: string, value: string) { id = value; return q; },
        async maybeSingle() { return { data: events.get(id) ?? null, error: null }; },
        async insert(row: Record<string, unknown>) { events.set(String(row.id), row); return { error: null }; },
        async upsert(row: Record<string, unknown>) {
          if (fail) { fail = false; return { error: { message: "private database failure" } }; }
          subscriptions.set(String(row.provider_subscription_id), row); return { error: null };
        } };
      assert.equal(name === "stripe_events" || name === "subscriptions", true);
      return q;
    },
    async rpc(name: string, p: Record<string, unknown>) {
      calls.push(name);
      if (name === "claim_stripe_subscription_event") {
        const prior = events.get(String(p.p_event_id));
        if (prior?.state === "processed") return { data: { state: "duplicate" }, error: null };
        const token = randomUUID();
        events.set(String(p.p_event_id), { state: "pending", token });
        return { data: { state: "claimed", leaseToken: token, binding }, error: null };
      }
      assert.equal(name, "complete_stripe_subscription_event");
      if (fail) { fail = false; return { data: null, error: { message: "private database failure", code: "XX000" } }; }
      subscriptions.set("sub_synthetic", p.p_mutation as Record<string, unknown>);
      events.set(String(p.p_event_id), { state: "processed" });
      return { data: { state: "processed" }, error: null };
    },
  };
  return { events, subscriptions, calls, sb, get reads() { return reads; },
    stripe: { subscriptions: { retrieve: async (_id: string, _params: Record<string, never>, _options: { timeout: number; maxNetworkRetries: number }): Promise<unknown> => { reads++; return current; } } },
    setCurrent(value: unknown) { current = value; },
    setBinding(value: typeof binding) { binding = value; },
    setFail(value: boolean) { fail = value; } };
}
async function appFor(f: ReturnType<typeof fixture>, throwingFactory = false) {
  const app = Fastify({ logger: false });
  await app.register(errorHandlerPlugin);
  app.decorate("supabaseFactory", (() => { if (throwingFactory) throw new Error("private factory configuration"); return f.sb; }) as unknown as SupabaseFactory);
  stripeWebhookRoutes(app, { stripeFactory: () => f.stripe as never });
  await app.ready();
  return app;
}
async function deliver(app: Awaited<ReturnType<typeof appFor>>, event: unknown) {
  const body = JSON.stringify(event);
  return app.inject({ method: "POST", url: "/webhooks/stripe", headers: {
    "content-type": "application/json", "stripe-signature": sign(body) }, payload: body });
}
test("failed subscription effect is not acknowledged as a completed duplicate on retry", async () => {
  const f = fixture(), app = await appFor(f);
  try {
    const event = { id: "evt_synthetic", type: "customer.subscription.updated", livemode: false, data: { object: snapshot() } };
    const first = await deliver(app, event);
    assert.equal(first.statusCode >= 500, true);
    assert.equal(f.subscriptions.size, 0);
    const retry = await deliver(app, event);
    assert.equal(retry.statusCode, 200);
    assert.equal(f.subscriptions.size, 1, "receipt cannot suppress its unfinished subscription effect");
    assert.equal(f.events.get(event.id)?.state, "processed");
    assert.equal(first.body.includes("private database failure"), false);
  } finally { await app.close(); }
});

const update = (id = "evt_synthetic", object: unknown = snapshot(), created = 1800000000) =>
  ({ id, type: "customer.subscription.updated", livemode: false, created, data: { object } });
test("reverse and same-second deliveries reconcile current state; processed duplicates do not read again", async () => {
  const f = fixture(), app = await appFor(f); f.setFail(false);
  try {
    f.setCurrent(snapshot("past_due"));
    assert.equal((await deliver(app, update("evt_newer", snapshot("active"), 100))).statusCode, 200);
    assert.equal(f.subscriptions.get("sub_synthetic")?.status, "past_due");
    f.setCurrent(snapshot("canceled"));
    assert.equal((await deliver(app, update("evt_older", snapshot("active"), 99))).statusCode, 200);
    assert.equal(f.subscriptions.get("sub_synthetic")?.status, "canceled");
    assert.equal((await deliver(app, update("evt_same_second", snapshot("active"), 99))).statusCode, 200);
    const before = f.reads;
    assert.equal((await deliver(app, update("evt_older"))).json().duplicate, true);
    assert.equal(f.reads, before);
  } finally { await app.close(); }
});
test("checkout completion is not evidence of active entitlement", async () => {
  const f = fixture(), app = await appFor(f); f.setFail(false); f.setCurrent(snapshot("incomplete"));
  try {
    assert.equal((await deliver(app, { ...update(), type: "checkout.session.completed", data: { object: { subscription: "sub_synthetic", status: "complete" } } })).statusCode, 200);
    assert.equal(f.subscriptions.get("sub_synthetic")?.status, "incomplete");
  } finally { await app.close(); }
});
test("legacy receipt is reconciled, never assumed completed", async () => {
  const f = fixture(), app = await appFor(f); f.setFail(false); f.events.set("evt_synthetic", { state: "legacy_unverified" });
  try {
    assert.equal((await deliver(app, update())).statusCode, 200);
    assert.equal(f.reads, 1); assert.equal(f.subscriptions.size, 1);
  } finally { await app.close(); }
});
test("busy, claim failure, expired completion and malformed completion are generic retryable503", async t => {
  for (const mode of ["busy", "claim-error", "lease-error", "malformed-completion"] as const) await t.test(mode, async () => {
    const f = fixture(), app = await appFor(f); f.setFail(false);
    const original = f.sb.rpc;
    f.sb.rpc = async (name, p) => {
      if (name === "claim_stripe_subscription_event" && mode === "busy") return { data: { state: "busy" }, error: null } as never;
      if (name === "claim_stripe_subscription_event" && mode === "claim-error") return { data: null, error: { code: "XX000", message: "secret operator connection" } } as never;
      if (name === "complete_stripe_subscription_event") return mode === "lease-error"
        ? { data: null, error: { code: "40001", message: "secret lease values" } } as never
        : { data: { state: "wrong" }, error: null } as never;
      return original(name, p);
    };
    try {
      const response = await deliver(app, update());
      assert.equal(response.statusCode, 503); assert.equal(response.body.includes("secret"), false);
      assert.equal(f.subscriptions.size, 0);
      if (mode === "busy" || mode === "claim-error") assert.equal(f.reads, 0);
    } finally { await app.close(); }
  });
});
test("invalid event envelopes are rejected before any claim or current-object read", async t => {
  for (const event of [{ ...update(), id: "evt_/../../bad" }, { ...update(), livemode: undefined }, { ...update(), data: { object: { id: "http://internal" } } }, null]) {
    await t.test(JSON.stringify(event), async () => {
      const f = fixture(), app = await appFor(f);
      try { assert.equal((await deliver(app, event)).statusCode, 400); assert.equal(f.calls.length, 0); assert.equal(f.reads, 0); }
      finally { await app.close(); }
    });
  }
});
test("unrelated signed events are ignored without financial side effects", async () => {
  const f = fixture(), app = await appFor(f);
  try { assert.equal((await deliver(app, { ...update(), type: "invoice.created" })).json().ignored, true); assert.equal(f.calls.length, 0); }
  finally { await app.close(); }
});
test("current identity, tenant, price, status and one-item period contracts fail closed", async t => {
  const bad = [
    { ...snapshot(), id: "sub_foreign" }, { ...snapshot(), livemode: true }, { ...snapshot(), customer: "cus_foreign" },
    { ...snapshot(), metadata: { organizationId: "33333333-3333-4333-8333-333333333333", planId: PLAN } },
    { ...snapshot(), status: "invented" }, { ...snapshot(), metadata: { organizationId: ORG, planId: "not-uuid" } },
    { ...snapshot(), items: { has_more: true, data: snapshot().items.data } },
    { ...snapshot(), items: { has_more: false, data: [...snapshot().items.data, ...snapshot().items.data] } },
    { ...snapshot(), items: { has_more: false, data: [{ ...snapshot().items.data[0], quantity: 2 }] } },
    { ...snapshot(), items: { has_more: false, data: [{ ...snapshot().items.data[0], current_period_end: Infinity }] } },
    { ...snapshot(), items: { has_more: false, data: [{ ...snapshot().items.data[0], price: { id: "price_wrong" } }] } },
  ];
  for (const [index, current] of bad.entries()) await t.test(String(index), async () => {
    const f = fixture(), app = await appFor(f); f.setFail(false); f.setCurrent(current);
    f.setBinding({ organizationId: ORG, planId: PLAN, customerId: "cus_synthetic" });
    try {
      const response = await deliver(app, update());
      assert.equal(response.statusCode, 503); assert.equal(f.subscriptions.size, 0);
      assert.deepEqual(f.calls, ["claim_stripe_subscription_event"]);
    } finally { await app.close(); }
  });
});
test("cancellation revokes using existing binding despite removed price map and empty metadata", async () => {
  const f = fixture(), app = await appFor(f); f.setFail(false);
  f.setCurrent({ ...snapshot("canceled"), metadata: {} });
  f.setBinding({ organizationId: ORG, planId: PLAN, customerId: "cus_synthetic" });
  const prior = process.env.STRIPE_PRICE_IDS_JSON; process.env.STRIPE_PRICE_IDS_JSON = "{}";
  try {
    assert.equal((await deliver(app, update())).statusCode, 200);
    assert.equal(f.subscriptions.get("sub_synthetic")?.status, "canceled");
    assert.equal(f.subscriptions.get("sub_synthetic")?.planId, PLAN);
  } finally { process.env.STRIPE_PRICE_IDS_JSON = prior; await app.close(); }
});
test("bound canceled and past_due states revoke despite malformed price-map configuration", async t => {
  const prior = process.env.STRIPE_PRICE_IDS_JSON;
  try {
    for (const status of ["canceled", "past_due"]) for (const map of ["null", '"price_synthetic"', "[]", "42", "{", JSON.stringify({ [PLAN]: 42 })]) {
      await t.test(`${status}/${map}`, async () => {
        process.env.STRIPE_PRICE_IDS_JSON = map;
        assert.deepEqual(planPriceIds(), {}, "non-record or non-string mapping must fail closed");
        const f = fixture(), app = await appFor(f); f.setFail(false);
        f.setCurrent({ ...snapshot(status), metadata: {} });
        f.setBinding({ organizationId: ORG, planId: PLAN, customerId: "cus_synthetic" });
        try {
          assert.equal((await deliver(app, update())).statusCode, 200);
          const saved = f.subscriptions.get("sub_synthetic");
          assert.equal(saved?.status, status); assert.equal(saved?.organizationId, ORG);
          assert.equal(saved?.planId, PLAN); assert.equal(saved?.customerId, "cus_synthetic");
          assert.equal(saved?.expectedPriceId, null);
        } finally { await app.close(); }
      });
    }
  } finally { process.env.STRIPE_PRICE_IDS_JSON = prior; }
});
test("bound revocation does not reuse even a valid obsolete granting price mapping", async t => {
  const prior = process.env.STRIPE_PRICE_IDS_JSON;
  process.env.STRIPE_PRICE_IDS_JSON = JSON.stringify({ [PLAN]: "price_obsolete" });
  try {
    for (const status of ["canceled", "past_due"]) await t.test(status, async () => {
      const f = fixture(), app = await appFor(f); f.setFail(false);
      f.setCurrent({ ...snapshot(status), metadata: {} });
      f.setBinding({ organizationId: ORG, planId: PLAN, customerId: "cus_synthetic" });
      try {
        assert.equal((await deliver(app, update())).statusCode, 200);
        assert.equal(f.subscriptions.get("sub_synthetic")?.expectedPriceId, null);
        assert.equal(f.subscriptions.get("sub_synthetic")?.planId, PLAN);
      } finally { await app.close(); }
    });
  } finally { process.env.STRIPE_PRICE_IDS_JSON = prior; }
});
test("signature parser bounds timestamps and accepts any valid v1 rotation signature", () => {
  const body = JSON.stringify(update()); const valid = sign(body);
  assert.doesNotThrow(() => verifyWebhookSignature(body, `${valid},v1=${"0".repeat(64)}`, "whsec_synthetic_atomic"));
  assert.doesNotThrow(() => verifyWebhookSignature(body, `v1=${"0".repeat(64)},${valid}`, "whsec_synthetic_atomic"));
  for (const header of [sign(body, "NaN"), sign(body, "Infinity"), sign(body, "1e10"), `${valid},t=1`, "x".repeat(4097), `t=1,v1=${"0".repeat(64)}`]) {
    assert.throws(() => verifyWebhookSignature(body, header, "whsec_synthetic_atomic"));
  }
});
test("bounded Stripe transport rejects nonallowlisted destinations before fetch", async () => {
  let calls = 0;
  const fetcher = boundedStripeFetch(new AbortController().signal, (async () => { calls++; return new Response("{}"); }) as typeof fetch);
  for (const url of ["http://api.stripe.com/v1/subscriptions/sub_test", "https://evil.test/v1/subscriptions/sub_test", "https://api.stripe.com/v1/subscriptions/sub_test?expand[]=customer"]) {
    await assert.rejects(fetcher(url));
  }
  assert.equal(calls, 0);
});
test("bounded Stripe transport caps streamed bytes and aborts stalled headers/body once", async t => {
  await t.test("stream byte cap", async () => {
    let calls = 0;
    const fetcher = boundedStripeFetch(new AbortController().signal, (async () => { calls++; return new Response(new Uint8Array(256 * 1024 + 1)); }) as typeof fetch);
    await assert.rejects((await fetcher("https://api.stripe.com/v1/subscriptions/sub_test")).text());
    assert.equal(calls, 1);
  });
  for (const phase of ["headers", "body"] as const) await t.test(phase, async () => {
    const controller = new AbortController(); let calls = 0, canceled = false;
    const fetcher = boundedStripeFetch(controller.signal, (async (_input, init) => {
      calls++;
      if (phase === "headers") return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => { canceled = true; reject(new Error("synthetic abort")); }, { once: true }));
      return new Response(new ReadableStream({ cancel() { canceled = true; } }));
    }) as typeof fetch);
    const pending = fetcher("https://api.stripe.com/v1/subscriptions/sub_test").then(response => response.text());
    const rejection = assert.rejects(pending);
    await new Promise(resolve => setTimeout(resolve, 30)); controller.abort(); await rejection;
    await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(calls, 1); assert.equal(canceled, true);
  });
});
test("retrieval checks one-attempt options and fences a late abort-ignoring dependency", async () => {
  const controller = new AbortController(); let resolve!: (value: unknown) => void; let calls = 0;
  const pending = retrieveStripeSubscription("sub_synthetic", controller.signal, () => ({ subscriptions: { retrieve: async (id: string, params: unknown, options: unknown) => {
    calls++; assert.equal(id, "sub_synthetic"); assert.deepEqual(params, {}); assert.deepEqual(options, { timeout: 12000, maxNetworkRetries: 0 });
    return new Promise(value => { resolve = value; });
  } } } as never));
  const rejection = assert.rejects(pending); controller.abort(); await rejection;
  resolve(snapshot()); await new Promise(value => setTimeout(value, 5)); assert.equal(calls, 1);
});
test("factory failure remains generic retryable503 before any claim or read", async () => {
  const f = fixture(), app = await appFor(f, true);
  try {
    const response = await deliver(app, update());
    assert.equal(response.statusCode, 503); assert.equal(response.body.includes("private factory"), false);
    assert.equal(f.calls.length, 0); assert.equal(f.reads, 0); assert.equal(f.subscriptions.size, 0);
  } finally { await app.close(); }
});
test("installed SDK default retrieval uses only the bounded intercepted subscription GET", async t => {
  const keys = ["NODE_ENV", "SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "REDIS_URL", "QDRANT_URL", "STRIPE_SECRET_KEY"] as const;
  const prior = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { NODE_ENV: "production", SUPABASE_URL: "http://synthetic.invalid", SUPABASE_ANON_KEY: "synthetic-anon",
    SUPABASE_SERVICE_ROLE_KEY: "synthetic-service", REDIS_URL: "redis://synthetic.invalid", QDRANT_URL: "http://synthetic.invalid", STRIPE_SECRET_KEY: "sk_test_synthetic_fixture_only" });
  const originalFetch = globalThis.fetch; let calls = 0, unexpectedRequests = 0;
  let phase: "healthy" | "headers" | "body" = "healthy", canceled = false;
  let requestSignal: AbortSignal | null = null, started = () => {};
  globalThis.fetch = (async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    try {
      assert.equal(url, "https://api.stripe.com/v1/subscriptions/sub_synthetic");
      assert.equal(init?.method, "GET"); assert.equal(init?.redirect, "error"); assert.equal(init?.signal instanceof AbortSignal, true);
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk_test_synthetic_fixture_only");
    } catch (error) { unexpectedRequests++; throw error; }
    calls++; requestSignal = init!.signal!;
    if (phase !== "body") started();
    if (phase === "headers") return new Promise<Response>((_, reject) => {
      init!.signal!.addEventListener("abort", () => { canceled = true; reject(new Error("synthetic SDK header abort")); }, { once: true });
    });
    if (phase === "body") return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"id":"sub_synthetic",')); },
      // Wait for actual body consumption, not just the SDK's header fetch.
      pull() { started(); },
      cancel() { canceled = true; },
    }), { headers: { "content-type": "application/json", "request-id": "req_synthetic" } });
    return new Response(JSON.stringify(snapshot()), { headers: { "content-type": "application/json", "request-id": "req_synthetic" } });
  }) as typeof fetch;
  try {
    await t.test("healthy", async () => {
      const current = await retrieveStripeSubscription("sub_synthetic", AbortSignal.timeout(12000));
      assert.equal((current as { id: string }).id, "sub_synthetic"); assert.equal(calls, 1);
    });
    for (const stalled of ["headers", "body"] as const) await t.test(`stalled ${stalled}`, async () => {
      phase = stalled; canceled = false;
      const controller = new AbortController(), before = calls;
      const began = new Promise<void>(resolve => { started = resolve; });
      const pending = retrieveStripeSubscription("sub_synthetic", AbortSignal.any([controller.signal, AbortSignal.timeout(12000)]));
      const rejected = assert.rejects(pending);
      await Promise.race([began, pending.then(() => { throw new Error("Expected stalled SDK read"); }, () => { throw new Error("SDK did not reach the intercepted fetch"); })]);
      controller.abort(); await rejected;
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal(requestSignal?.aborted, true); assert.equal(canceled, true);
      assert.equal(calls, before + 1, "native SDK must not redispatch aborted reads");
    });
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    assert.equal(unexpectedRequests, 0, "all native requests must stay within the synthetic fixture");
  }
});
