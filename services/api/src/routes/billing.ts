import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { planPriceIds, verifyWebhookSignature, retrieveStripeSubscription, type StripeFactory, defaultStripeFactory } from "../lib/stripe.js";
import { boundedSupabaseFetch } from "../lib/supabase.js";
import { deductCredits } from "../lib/credits.js";
import { currentEntitlements, monthUsage } from "../lib/entitlements.js";

const checkoutSchema = z.object({
  organizationId: z.string().uuid(),
  planId: z.string().uuid(),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
}).strict();

const portalSchema = z.object({ organizationId: z.string().uuid(), returnUrl: z.string().url() }).strict();

const deductSchema = z.object({
  userId: z.string().uuid(),
  workspaceId: z.string().uuid().nullish(),
  organizationId: z.string().uuid().nullish(),
  meter: z.string().min(1),
  amount: z.number().int().positive(),
  jobId: z.string().uuid(),
});

// Org admin check (organization_members roles: owner/admin/member).
async function requireOrgAdmin(sb: SupabaseClient, organizationId: string, userId: string) {
  const { data } = await sb
    .from("organization_members")
    .select("role")
    .eq("organization_id", organizationId)
    .eq("user_id", userId)
    .maybeSingle();
  const role = (data as { role?: string } | null)?.role;
  if (role !== "owner" && role !== "admin") throw new AppError(403, "org admin required");
}

function requireWebReturnUrl(value: string) {
  const configured = process.env.APP_URL ?? (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  if (!configured) throw new AppError(503, "APP_URL is required for billing redirects");
  let appUrl: URL;
  let target: URL;
  try { appUrl = new URL(configured); target = new URL(value); }
  catch { throw new AppError(503, "billing redirect configuration is invalid"); }
  if (!["http:", "https:"].includes(appUrl.protocol) || appUrl.username || appUrl.password
    || target.origin !== appUrl.origin || target.username || target.password) {
    throw new AppError(422, "billing redirects must use the configured application origin");
  }
  return target.toString();
}

const stripeId = (prefix: string) => z.string().regex(new RegExp(`^${prefix}_[A-Za-z0-9_]{1,250}$`));
const eventSchema = z.object({ id: stripeId("evt"), type: z.string().min(1).max(120), livemode: z.boolean(),
  data: z.object({ object: z.record(z.unknown()) }) });
const bindingSchema = z.object({ organizationId: z.string().uuid().nullable(), planId: z.string().uuid().nullable(),
  customerId: stripeId("cus").nullable() }).strict();
const claimSchema = z.discriminatedUnion("state", [z.object({ state: z.literal("duplicate") }).strict(),
  z.object({ state: z.literal("busy") }).strict(), z.object({ state: z.literal("claimed"), leaseToken: z.string().uuid(), binding: bindingSchema.nullable() }).strict()]);
const snapshotSchema = z.object({ id: stripeId("sub"), livemode: z.boolean(),
  customer: z.union([stripeId("cus"), z.object({ id: stripeId("cus") })]),
  status: z.enum(["active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"]),
  metadata: z.record(z.string().max(500)).default({}),
  items: z.object({ has_more: z.boolean(), data: z.array(z.object({ quantity: z.number().int().nonnegative(),
    price: z.object({ id: stripeId("price") }), current_period_end: z.number().int().min(0).max(4102444800) })).max(20) }).optional() });
function subscriptionMutation(value: unknown, id: string, livemode: boolean, binding: z.infer<typeof bindingSchema> | null) {
  const sub = snapshotSchema.parse(value);
  const customerId = typeof sub.customer === "string" ? sub.customer : sub.customer.id;
  if (sub.id !== id || sub.livemode !== livemode || (binding?.customerId && binding.customerId !== customerId)) throw new Error("Billing identity conflict.");
  const granting = sub.status === "active" || sub.status === "trialing";
  const organizationId = binding && !granting ? binding.organizationId : binding?.organizationId ?? z.string().uuid().parse(sub.metadata.organizationId);
  if (granting && sub.metadata.organizationId !== organizationId) throw new Error("Billing organization conflict.");
  const planId = binding && !granting ? binding.planId : z.string().uuid().parse(sub.metadata.planId);
  const item = sub.items?.data[0];
  // Revocation of a bound subscription must not depend on today's price map.
  const expectedPriceId = granting && planId ? planPriceIds()[planId] ?? null : null;
  if (granting && (!item || sub.items!.has_more || sub.items!.data.length !== 1 || item.quantity !== 1
    || typeof expectedPriceId !== "string" || !/^price_[A-Za-z0-9_]{1,250}$/.test(expectedPriceId) || item.price.id !== expectedPriceId)) {
    throw new Error("Billing plan price conflict.");
  }
  return { organizationId, planId, customerId, subscriptionId: id, status: sub.status,
    periodEnd: item?.current_period_end ?? null, priceId: item?.price.id ?? null, expectedPriceId: typeof expectedPriceId === "string" ? expectedPriceId : null };
}

// opts.stripeFactory is the test seam; default reads env lazily (503 when unset).
export function billingRoutes(app: FastifyInstance, opts: { stripeFactory?: StripeFactory } = {}) {
  const stripeFactory = opts.stripeFactory ?? defaultStripeFactory;

  app.get("/plans", async () => {
    const svc = app.supabaseFactory();
    const { data, error } = await svc.from("plans").select("*").eq("is_active", true);
    if (error) throw new AppError(500, (error as { message: string }).message);
    return { plans: data };
  });

  app.post("/billing/checkout", async (req, reply) => {
    const parsed = checkoutSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid checkout request", { issues: parsed.error.issues });
    const { organizationId, planId, successUrl, cancelUrl } = parsed.data;
    await requireOrgAdmin(app.supabaseFactory(req.userToken), organizationId, req.userId);
    const safeSuccessUrl = requireWebReturnUrl(successUrl);
    const safeCancelUrl = requireWebReturnUrl(cancelUrl);
    const svc = app.supabaseFactory();
    const { data: plan, error: planError } = await svc
      .from("plans")
      .select("id,is_active,price_cents")
      .eq("id", planId)
      .eq("is_active", true)
      .maybeSingle();
    if (planError) throw new AppError(500, (planError as { message: string }).message);
    if (!plan || Number((plan as { price_cents?: number }).price_cents) <= 0) {
      throw new AppError(422, "plan is not available for checkout", { planId });
    }
    const price = planPriceIds()[planId];
    if (!price) throw new AppError(422, "no Stripe price configured for plan", { planId });
    const stripe = stripeFactory();
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price, quantity: 1 }],
      success_url: safeSuccessUrl,
      cancel_url: safeCancelUrl,
      metadata: { organizationId, planId },
      subscription_data: { metadata: { organizationId, planId } },
    });
    if (!session.url) throw new AppError(503, "stripe returned no checkout url");
    return reply.status(201).send({ checkoutUrl: session.url, sessionId: session.id });
  });

  app.post("/billing/portal", async (req) => {
    const parsed = portalSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid portal request", { issues: parsed.error.issues });
    await requireOrgAdmin(app.supabaseFactory(req.userToken), parsed.data.organizationId, req.userId);
    const safeReturnUrl = requireWebReturnUrl(parsed.data.returnUrl);
    const svc = app.supabaseFactory();
    const { data: sub } = await svc
      .from("subscriptions")
      .select("provider_customer_id")
      .eq("organization_id", parsed.data.organizationId)
      .not("provider_customer_id", "is", null)
      .limit(1)
      .maybeSingle();
    const customerId = (sub as { provider_customer_id?: string } | null)?.provider_customer_id;
    if (!customerId) throw new AppError(404, "no billing customer for organization");
    const stripe = stripeFactory();
    const session = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: safeReturnUrl });
    return { portalUrl: session.url };
  });

  // Service-to-service credit deduction for the Python AI/document/render
  // services: they call POST /v1/credits/deduct with header
  // x-service-token: $SERVICE_AUTH_TOKEN (shared secret, constant-time
  // compared). Uses the service-role client — no user JWT involved.
  app.post("/credits/deduct", { config: { serviceAuth: true } }, async (req, reply) => {
    const expected = process.env.SERVICE_AUTH_TOKEN ?? "";
    const token = req.headers["x-service-token"];
    const ok =
      typeof token === "string" &&
      expected.length > 0 &&
      token.length === expected.length &&
      timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!ok) throw new AppError(401, "invalid service token");
    const parsed = deductSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(422, "invalid deduct request", { issues: parsed.error.issues });
    const result = await deductCredits(app.supabaseFactory(), {
      userId: parsed.data.userId,
      workspaceId: parsed.data.workspaceId,
      organizationId: parsed.data.organizationId,
      meter: parsed.data.meter,
      amount: parsed.data.amount,
      jobId: parsed.data.jobId,
    });
    return reply.status(201).send(result);
  });

  app.get("/usage", async (req) => {
    const { organizationId } = req.query as { organizationId?: string };
    if (!organizationId) throw new AppError(400, "organizationId required");
    const sb = app.supabaseFactory(req.userToken);
    const { data: member } = await sb
      .from("organization_members")
      .select("role")
      .eq("organization_id", organizationId)
      .eq("user_id", req.userId)
      .maybeSingle();
    if (!member) throw new AppError(403, "not an organization member");
    const svc = app.supabaseFactory();
    const ent = await currentEntitlements(svc, organizationId);
    const meters = ["ai_credits", "image_credits", "audio_credits", "translation_credits", "storage_gb", "seats", "rendering", "publishing"];
    const usage: Record<string, number> = {};
    for (const m of meters) usage[m] = await monthUsage(svc, organizationId, m);
    const { data: last } = await svc
      .from("credit_ledger")
      .select("balance_after")
      .eq("user_id", req.userId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle();
    return { entitlements: ent, usage, creditBalance: (last as { balance_after?: number } | null)?.balance_after ?? 0 };
  });
}

// Webhook is registered OUTSIDE the auth plugin scope: Stripe calls it, no JWT.
// Raw body required for signature verification, so this parser captures the
// unparsed payload before JSON.parse.
export function stripeWebhookRoutes(app: FastifyInstance, opts: { stripeFactory?: StripeFactory } = {}) {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (req, body, done) => {
    (req as unknown as { rawBody: string }).rawBody = body as string;
    try {
      done(null, JSON.parse(body as string));
    } catch {
      done(new AppError(400, "invalid json"));
    }
  });

  app.post("/webhooks/stripe", async (req, reply) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET ?? "";
    if (!secret) throw new AppError(503, "webhook not configured");
    verifyWebhookSignature((req as unknown as { rawBody: string }).rawBody, req.headers["stripe-signature"] as string | undefined, secret);
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) throw new AppError(400, "invalid Stripe event");
    const event = parsed.data;
    if (!["checkout.session.completed", "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
      return reply.status(200).send({ received: true, ignored: true });
    }
    const target = stripeId("sub").safeParse(event.type === "checkout.session.completed" ? event.data.object.subscription : event.data.object.id);
    if (!target.success) throw new AppError(400, "invalid Stripe subscription identity");
    // Database lease is acquired BEFORE the current-object read. Event timestamps
    // are audit data, never a delivery-order or duplicate-processing oracle.
    const deadline = AbortSignal.timeout(20_000);
    try {
      const svc = app.supabaseFactory(undefined, boundedSupabaseFetch(deadline));
      const claim = await svc.rpc("claim_stripe_subscription_event", { p_event_id: event.id, p_event_type: event.type,
        p_subscription_id: target.data, p_livemode: event.livemode });
      deadline.throwIfAborted();
      if (claim.error) throw new Error("Billing claim unavailable.");
      const receipt = claimSchema.parse(claim.data);
      if (receipt.state === "duplicate") return reply.status(200).send({ received: true, duplicate: true });
      if (receipt.state === "busy") throw new Error("Billing reconciliation busy.");
      const signal = AbortSignal.any([deadline, AbortSignal.timeout(12_000)]);
      const current = await retrieveStripeSubscription(target.data, signal, opts.stripeFactory);
      signal.throwIfAborted();
      const mutation = subscriptionMutation(current, target.data, event.livemode, receipt.binding);
      deadline.throwIfAborted();
      const completion = await svc.rpc("complete_stripe_subscription_event", { p_event_id: event.id,
        p_lease_token: receipt.leaseToken, p_mutation: mutation });
      deadline.throwIfAborted();
      if (completion.error || !z.object({ state: z.literal("processed") }).strict().safeParse(completion.data).success) throw new Error("Billing completion unavailable.");
      return reply.status(200).send({ received: true });
    } catch {
      // Never acknowledge uncertain completion. Stripe retries the original event;
      // the database receipt/lease decides whether to reconcile or return once.
      throw new AppError(503, "Billing reconciliation unavailable. Retry the original event.");
    }
  });
}
