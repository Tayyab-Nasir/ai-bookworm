import { createRequire } from "node:module";
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadEnv } from "@bookworm/config";
import { AppError } from "../errors.js";

// Injectable seam (same shape as SupabaseFactory): tests pass a fake with
// checkout.sessions.create / billingPortal.sessions.create.
export interface StripeLike {
  checkout: { sessions: { create: (params: unknown) => Promise<{ url?: string | null; id: string }> } };
  billingPortal: { sessions: { create: (params: unknown) => Promise<{ url: string }> } };
}
export type StripeFactory = () => StripeLike;

let cached: StripeLike | null = null;

// Lazy: no Stripe key -> null, callers return 503 dependency_unavailable.
export function getStripe(): StripeLike | null {
  const env = loadEnv();
  if (!env.STRIPE_SECRET_KEY) return null;
  if (!cached) {
    // require() so merely importing this module never loads the SDK in tests.
    const Stripe = (createRequire(import.meta.url)("stripe") as { default: new (k: string) => StripeLike }).default;
    cached = new Stripe(env.STRIPE_SECRET_KEY);
  }
  return cached;
}

export function requireStripe(): StripeLike {
  const stripe = getStripe();
  if (!stripe) throw new AppError(503, "billing not configured");
  return stripe;
}

export const defaultStripeFactory: StripeFactory = requireStripe;

// planId -> Stripe price id, from env JSON e.g. {"<plan-uuid>":"price_123"}.
export function planPriceIds(): Record<string, string> {
  try {
    return JSON.parse(process.env.STRIPE_PRICE_IDS_JSON ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

// Minimal Stripe webhook signature check (v1 scheme): avoids importing the SDK
// at module load and works on raw bodies in tests.
export function verifyWebhookSignature(rawBody: string | Buffer, header: string | undefined, secret: string, toleranceSec = 300): void {
  if (!header) throw new AppError(400, "missing stripe-signature header");
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const ts = parts.t;
  const sig = parts.v1;
  if (!ts || !sig) throw new AppError(400, "malformed stripe-signature header");
  if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) throw new AppError(400, "stale webhook timestamp");
  const expected = createHmac("sha256", secret).update(`${ts}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(sig);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new AppError(401, "invalid webhook signature");
}
