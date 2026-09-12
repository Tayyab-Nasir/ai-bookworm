import type { SupabaseClient } from "./supabase.js";
import { AppError } from "../errors.js";

// Plan entitlements (plans.entitlements_json, seeded in supabase/seed/001_plans.sql).
export interface Entitlements {
  seats: number;
  workspaces: number;
  books: number;
  ai_credits_monthly: number;
  image_credits_monthly: number;
  audio_credits_monthly: number;
  storage_gb: number;
  rendering: boolean;
  publishing_channels: string[];
  [k: string]: unknown;
}

const FREE_DEFAULTS: Entitlements = {
  seats: 1,
  workspaces: 1,
  books: 3,
  ai_credits_monthly: 0,
  image_credits_monthly: 0,
  audio_credits_monthly: 0,
  storage_gb: 1,
  rendering: true,
  publishing_channels: ["export"],
};

export interface CurrentEntitlements {
  plan: { id: string | null; name: string };
  subscription: { id: string; status: string; current_period_end: string | null } | null;
  entitlements: Entitlements;
}

// Active/trialing subscription -> plan. No subscription -> free-tier defaults
// (every org implicitly has the free plan; avoids a lookup when no sub row exists).
export async function currentEntitlements(supabase: SupabaseClient, organizationId: string): Promise<CurrentEntitlements> {
  const { data: sub, error } = await supabase
    .from("subscriptions")
    .select("id,status,current_period_end,plan_id")
    .eq("organization_id", organizationId)
    .in("status", ["active", "trialing"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new AppError(500, error.message);
  if (!sub) return { plan: { id: null, name: "free" }, subscription: null, entitlements: FREE_DEFAULTS };
  const { data: plan, error: pErr } = await supabase.from("plans").select("id,name,entitlements_json").eq("id", sub.plan_id).maybeSingle();
  if (pErr) throw new AppError(500, pErr.message);
  return {
    plan: { id: plan?.id ?? null, name: plan?.name ?? "free" },
    subscription: { id: sub.id, status: sub.status, current_period_end: sub.current_period_end },
    entitlements: { ...FREE_DEFAULTS, ...((plan?.entitlements_json as Partial<Entitlements>) ?? {}) },
  };
}

// Meter name -> entitlement key holding the monthly quota.
const METER_QUOTA: Record<string, keyof Entitlements> = {
  ai_credits: "ai_credits_monthly",
  image_credits: "image_credits_monthly",
  audio_credits: "audio_credits_monthly",
  storage_gb: "storage_gb",
  seats: "seats",
};

// Usage for a meter since the start of the current UTC month.
export async function monthUsage(supabase: SupabaseClient, organizationId: string, meter: string): Promise<number> {
  const since = new Date();
  since.setUTCDate(1);
  since.setUTCHours(0, 0, 0, 0);
  const { data, error } = await supabase
    .from("usage_events")
    .select("quantity")
    .eq("organization_id", organizationId)
    .eq("meter", meter)
    .gte("created_at", since.toISOString());
  if (error) throw new AppError(500, error.message);
  // ponytail: JS-side sum — fine at MVP volume; swap to a sum() RPC later.
  return (data ?? []).reduce((s: number, r: { quantity: number }) => s + Number(r.quantity), 0);
}

// Throws 422 quota_exceeded when the org has consumed this month's quota.
export async function requireEntitlement(supabase: SupabaseClient, organizationId: string, meter: string, extra = 0): Promise<CurrentEntitlements> {
  const ent = await currentEntitlements(supabase, organizationId);
  const quotaKey = METER_QUOTA[meter];
  if (!quotaKey) return ent; // unmetered (e.g. rendering boolean) — no monthly quota
  const quota = Number(ent.entitlements[quotaKey]) || 0;
  const used = await monthUsage(supabase, organizationId, meter);
  if (used + extra > quota) {
    throw new AppError(422, "quota exceeded", { meter, quota, used }, "quota_exceeded");
  }
  return ent;
}
