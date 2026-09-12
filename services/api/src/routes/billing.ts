import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { timingSafeEqual } from "node:crypto";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "../lib/supabase.js";
import { planPriceIds, verifyWebhookSignature, type StripeFactory, defaultStripeFactory } from "../lib/stripe.js";
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

// Stripe subscription status -> our subscriptions.status (column is free text).
function mapStatus(s: string): string {
  return ["active", "trialing", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused"].includes(s) ? s : "incomplete";
}

interface StripeSub {
  id: string;
  customer: string;
  status: string;
  current_period_end?: number;
  metadata?: { organizationId?: string; planId?: string };
}

async function upsertSubscription(svc: SupabaseClient, sub: StripeSub) {
  const row = {
    organization_id: sub.metadata?.organizationId ?? null,
    provider_customer_id: sub.customer,
    provider_subscription_id: sub.id,
    plan_id: sub.metadata?.planId ?? null,
    status: mapStatus(sub.status),
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
  };
  // Upsert keyed on provider_subscription_id (unique) — idempotent on replay.
  const { error } = await svc.from("subscriptions").upsert(row, { onConflict: "provider_subscription_id" });
  if (error) throw new AppError(500, error.message);
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
    const meters = ["ai_credits", "image_credits", "audio_credits", "storage_gb", "seats", "rendering", "publishing"];
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
export function stripeWebhookRoutes(app: FastifyInstance) {
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
    const event = req.body as {
      id: string;
      type: string;
      data: { object: Record<string, unknown> & { metadata?: { organizationId?: string; planId?: string }; subscription?: string; customer?: string } };
    };
    const svc = app.supabaseFactory();

    // Idempotent processing: event ids recorded in stripe_events; duplicates
    // are a 200 no-op (Stripe retries on any non-2xx).
    const { data: existing } = await svc.from("stripe_events").select("id").eq("id", event.id).maybeSingle();
    if (existing) return reply.status(200).send({ received: true, duplicate: true });
    const { error: insErr } = await svc.from("stripe_events").insert({ id: event.id, type: event.type });
    if (insErr) {
      if ((insErr as { code?: string }).code === "23505") return reply.status(200).send({ received: true, duplicate: true });
      throw new AppError(500, (insErr as { message: string }).message);
    }

    const obj = event.data.object;
    if (event.type === "checkout.session.completed") {
      if (typeof obj.subscription === "string") {
        await upsertSubscription(svc, {
          id: obj.subscription,
          customer: (obj.customer as string) ?? "",
          status: "active",
          metadata: obj.metadata,
        });
      }
    } else if (event.type === "customer.subscription.updated" || event.type === "customer.subscription.deleted") {
      const sub = obj as unknown as StripeSub;
      if (event.type === "customer.subscription.deleted") sub.status = "canceled";
      await upsertSubscription(svc, sub);
    }
    return reply.status(200).send({ received: true });
  });
}
