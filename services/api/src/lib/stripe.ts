import { createRequire } from "node:module";
import { createHmac, timingSafeEqual } from "node:crypto";
import { loadEnv } from "@bookworm/config";
import { AppError } from "../errors.js";
import { boundedSupabaseFetch } from "./supabase.js";

// Injectable seam (same shape as SupabaseFactory): tests pass a fake with
// checkout.sessions.create / billingPortal.sessions.create.
export interface StripeLike {
  checkout: { sessions: { create: (params: unknown) => Promise<{ url?: string | null; id: string }> } };
  billingPortal: { sessions: { create: (params: unknown) => Promise<{ url: string }> } };
  subscriptions?: { retrieve: (id: string, params: Record<string, never>, options: { timeout: number; maxNetworkRetries: number }) => Promise<unknown> };
}
export type StripeFactory = () => StripeLike;

let cached: StripeLike | null = null;
type StripeConstructor = { new(key: string, options?: Record<string, unknown>): StripeLike;
  createFetchHttpClient: (fetcher: typeof fetch) => unknown };
function stripeConstructor(): StripeConstructor {
  // Node's installed CJS SDK exports the constructor itself; wrappers may use
  // named or default exports. Keep resolution lazy for key-free imports/tests.
  const module = createRequire(import.meta.url)("stripe") as unknown;
  const wrapper = module as { Stripe?: unknown; default?: unknown } | null;
  const constructor = typeof module === "function" ? module : wrapper?.Stripe ?? wrapper?.default;
  if (typeof constructor !== "function" || typeof (constructor as unknown as StripeConstructor).createFetchHttpClient !== "function") {
    throw new AppError(503, "billing SDK unavailable");
  }
  return constructor as unknown as StripeConstructor;
}

// Lazy: no Stripe key -> null, callers return 503 dependency_unavailable.
export function getStripe(): StripeLike | null {
  const env = loadEnv();
  if (!env.STRIPE_SECRET_KEY) return null;
  if (!cached) {
    // require() so merely importing this module never loads the SDK in tests.
    const Stripe = stripeConstructor();
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

/** Current-object reads have their own transport; checkout/portal are unchanged. */
export function boundedStripeFetch(signal: AbortSignal, fetcher: typeof fetch = fetch): typeof fetch {
  const bounded = boundedSupabaseFetch(signal, fetcher);
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== "https://api.stripe.com" || !/^\/v1\/subscriptions\/sub_[A-Za-z0-9_]{1,250}$/.test(url.pathname)
      || url.search || url.username || url.password || (init?.method ?? "GET") !== "GET") throw new Error("Unsupported billing read.");
    const response = await bounded(input, init);
    const limit = 256 * 1024;
    const length = response.headers.get("content-length");
    if (length !== null && (!/^[0-9]{1,10}$/.test(length) || Number(length) > limit)) {
      await response.body?.cancel().catch(() => {});
      throw new Error("Billing response exceeds its byte limit.");
    }
    if (!response.body) return response;
    let size = 0;
    const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({ transform(chunk, controller) {
      size += chunk.byteLength;
      if (size > limit) throw new Error("Billing response exceeds its byte limit.");
      controller.enqueue(chunk);
    } }), { signal });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
}

export async function retrieveStripeSubscription(id: string, signal: AbortSignal, factory?: StripeFactory): Promise<unknown> {
  signal.throwIfAborted();
  let client: StripeLike;
  if (factory && factory !== defaultStripeFactory) client = factory();
  else {
    const env = loadEnv();
    if (!env.STRIPE_SECRET_KEY) throw new AppError(503, "billing not configured");
    const Stripe = stripeConstructor();
    client = new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient(boundedStripeFetch(signal)), maxNetworkRetries: 0, timeout: 12000 });
  }
  if (!client.subscriptions) throw new AppError(503, "billing reconciliation unavailable");
  signal.throwIfAborted();
  // The native fetch/body is canceled. This separate fence also prevents a late
  // injected dependency from ever returning a mutation after the request deadline.
  let abort: () => void;
  const deadline = new Promise<never>((_, reject) => { abort = () => reject(new Error("Billing read deadline.")); signal.addEventListener("abort", abort, { once: true }); });
  try {
    return await Promise.race([client.subscriptions.retrieve(id, {}, { timeout: 12000, maxNetworkRetries: 0 }), deadline]);
  } finally { signal.removeEventListener("abort", abort!); }
}

// planId -> Stripe price id, from env JSON e.g. {"<plan-uuid>":"price_123"}.
export function planPriceIds(): Record<string, string> {
  try {
    const mapping: unknown = JSON.parse(process.env.STRIPE_PRICE_IDS_JSON ?? "{}");
    if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)
      || Object.values(mapping).some(value => typeof value !== "string")) return {};
    return mapping as Record<string, string>;
  } catch {
    return {};
  }
}

// Minimal Stripe webhook signature check (v1 scheme): avoids importing the SDK
// at module load and works on raw bodies in tests.
export function verifyWebhookSignature(rawBody: string | Buffer, header: string | undefined, secret: string, toleranceSec = 300): void {
  if (!header) throw new AppError(400, "missing stripe-signature header");
  if (typeof header !== "string" || header.length > 4096 || Buffer.byteLength(rawBody) > 1024 * 1024) throw new AppError(400, "malformed stripe-signature header");
  const parts = header.split(",");
  let ts: string | undefined;
  const signatures: string[] = [];
  if (parts.length > 32) throw new AppError(400, "malformed stripe-signature header");
  for (const part of parts) {
    const match = /^([A-Za-z0-9]+)=([A-Za-z0-9]+)$/.exec(part.trim());
    if (!match) throw new AppError(400, "malformed stripe-signature header");
    if (match[1] === "t") {
      if (ts !== undefined || !/^[0-9]{1,11}$/.test(match[2])) throw new AppError(400, "malformed stripe-signature header");
      ts = match[2];
    } else if (match[1] === "v1") {
      if (!/^[a-fA-F0-9]{64}$/.test(match[2]) || signatures.length >= 8) throw new AppError(400, "malformed stripe-signature header");
      signatures.push(match[2].toLowerCase());
    }
  }
  if (!ts || !signatures.length || !Number.isSafeInteger(Number(ts))) throw new AppError(400, "malformed stripe-signature header");
  if (Math.abs(Date.now() / 1000 - Number(ts)) > toleranceSec) throw new AppError(400, "stale webhook timestamp");
  const expected = createHmac("sha256", secret).update(`${ts}.${typeof rawBody === "string" ? rawBody : rawBody.toString("utf8")}`).digest("hex");
  const a = Buffer.from(expected);
  let valid = false;
  for (const sig of signatures) valid = timingSafeEqual(a, Buffer.from(sig)) || valid;
  if (!valid) throw new AppError(401, "invalid webhook signature");
}
