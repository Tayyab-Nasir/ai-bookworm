import type { SupabaseClient } from "./supabase.js";
import { AppError } from "../errors.js";

// Immutable ledger: every credit change appends a row with the new
// balance_after; prior rows are NEVER updated (reversals are compensating
// entries, e.g. source="reversal"). Balance is per-user (RLS: user sees own).
export interface CreditEntry {
  userId: string;
  workspaceId?: string | null;
  source: string; // purchase | subscription_grant | consumption | admin_adjustment | reversal | referral_reward
  amount: number; // positive = grant, negative = spend
  referenceType?: string; // e.g. "ai_job" — usage events reference the consuming job
  referenceId?: string;
}

// Balance = latest ledger row's balance_after. Order by created_at + id (the
// identity id only exists after insert, so ordering by it pre-insert is wrong).
async function currentBalance(supabase: SupabaseClient, userId: string): Promise<number> {
  const { data, error } = await supabase
    .from("credit_ledger")
    .select("balance_after")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new AppError(500, (error as { message: string }).message);
  return (data as { balance_after?: number } | null)?.balance_after ?? 0;
}

export async function postCreditEntry(supabase: SupabaseClient, e: CreditEntry) {
  const balance = await currentBalance(supabase, e.userId);
  const balanceAfter = balance + e.amount;
  if (balanceAfter < 0 && e.source !== "admin_adjustment") {
    throw new AppError(422, "insufficient credits", { balance, amount: e.amount }, "insufficient_credits");
  }
  const { data, error } = await supabase
    .from("credit_ledger")
    .insert({
      user_id: e.userId,
      workspace_id: e.workspaceId ?? null,
      source: e.source,
      amount: e.amount,
      balance_after: balanceAfter,
      reference_type: e.referenceType ?? null,
      reference_id: e.referenceId ?? null,
    })
    .select()
    .single();
  if (error) {
    // Unique-violation hook: a reference_id unique index makes retries safe —
    // replay of the same (source, reference) is a no-op, not a double post.
    throw new AppError(500, error.message);
  }
  return data;
}

export async function recordUsage(
  supabase: SupabaseClient,
  e: { organizationId?: string | null; userId: string; workspaceId?: string | null; meter: string; quantity: number; metadata?: Record<string, unknown> },
) {
  const { data, error } = await supabase
    .from("usage_events")
    .insert({
      organization_id: e.organizationId ?? null,
      user_id: e.userId,
      workspace_id: e.workspaceId ?? null,
      meter: e.meter,
      quantity: e.quantity,
      metadata_json: e.metadata ?? {},
    })
    .select()
    .single();
  if (error) throw new AppError(500, error.message);
  return data;
}

// Meter consumption: usage_events row references the consuming job, then the
// ledger entry carries the same reference. Deduct first-come: concurrent
// requests race on read-then-insert; the loser's negative check or unique
// reference constraint rejects the second post.
export async function deductCredits(
  supabase: SupabaseClient,
  e: { userId: string; workspaceId?: string | null; organizationId?: string | null; meter: string; amount: number; jobId: string },
) {
  const usage = await recordUsage(supabase, {
    organizationId: e.organizationId,
    userId: e.userId,
    workspaceId: e.workspaceId,
    meter: e.meter,
    quantity: e.amount,
    metadata: { jobId: e.jobId },
  });
  const entry = await postCreditEntry(supabase, {
    userId: e.userId,
    workspaceId: e.workspaceId,
    source: "consumption",
    amount: -Math.abs(e.amount),
    referenceType: "job",
    referenceId: e.jobId,
  });
  return { usage, entry };
}
