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

// Usage, debit and replay receipt commit together. The database owns balance
// locking; never split these writes or retry with a different request payload.
export async function deductCredits(
  supabase: SupabaseClient,
  e: { userId: string; workspaceId?: string | null; organizationId?: string | null; meter: string; amount: number; jobId: string },
) {
  const { data, error } = await supabase.rpc("deduct_job_credits", {
    p_user_id: e.userId, p_workspace_id: e.workspaceId ?? null,
    p_organization_id: e.organizationId ?? null, p_meter: e.meter,
    p_amount: e.amount, p_job_id: e.jobId,
  });
  if (error) {
    const code = (error as { code?: string }).code;
    if (code === "23514") throw new AppError(422, "insufficient credits", undefined, "insufficient_credits");
    if (code === "23505") throw new AppError(409, "credit deduction request conflict", undefined, "deduction_conflict");
    if (code === "22023") throw new AppError(422, "invalid credit deduction");
    throw new AppError(500, "credit deduction could not be recorded");
  }
  if (!data || typeof data !== "object" || !("usage" in data) || !("entry" in data)) {
    throw new AppError(502, "invalid credit deduction receipt");
  }
  return data as { usage: unknown; entry: unknown };
}
