/** Internal service adapter. Inputs must come from the server rate catalog and
 * authenticated provider response path, NEVER a public request's prices/debit.
 * No provider call or live activation happens here.
 */
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { AppError } from "../errors.js";
import type { SupabaseClient } from "./supabase.js";
import { assertQuoteDispatchable, quoteUsage, reconcileUsage, type UsageQuote } from "./usage-pricing.js";

const rowSchema = z.object({
  job_id: z.string().uuid(), user_id: z.string().uuid(), workspace_id: z.string().uuid(),
  quote_json: z.unknown(), reserved_credits: z.number().int().positive().max(2147483647),
  status: z.enum(["held", "settled", "requires_review"]), settlement_json: z.unknown().nullable(),
});
function validatedQuote(value: unknown): UsageQuote {
  try {
    const raw = value as UsageQuote;
    const canonical = quoteUsage(raw);
    if (!isDeepStrictEqual(raw, canonical)) throw new Error("noncanonical quote");
    return canonical;
  } catch { throw new AppError(500, "invalid saved usage quote"); }
}
function fundedRow(data: unknown, jobId: string) {
  const parsed = rowSchema.safeParse(data);
  if (!parsed.success) throw new AppError(500, "invalid funded quote response");
  const row = parsed.data; const quote = validatedQuote(row.quote_json);
  if (row.job_id !== jobId || quote.scope.jobId !== jobId || quote.scope.userId !== row.user_id
    || quote.scope.workspaceId !== row.workspace_id || quote.reservedCredits !== String(row.reserved_credits)
    || (row.status === "held" && row.settlement_json !== null)
    || (row.status !== "held" && row.settlement_json == null)) {
    throw new AppError(500, "funded quote identity mismatch");
  }
  return { ...row, quote_json: quote };
}
function databaseError(error: { code?: string }) {
  if (error.code === "23505") return new AppError(409, "funded quote request conflict");
  if (error.code === "23514") return new AppError(422, "quote could not be funded or settled");
  if (error.code === "42501") return new AppError(403, "quote access denied");
  if (error.code === "22023" || error.code === "22003") return new AppError(422, "invalid or expired usage quote");
  return new AppError(503, "usage quote storage unavailable");
}
export async function loadFundedUsage(supabase: SupabaseClient, jobId: string) {
  z.string().uuid().parse(jobId);
  const { data, error } = await supabase.from("funded_usage_quotes")
    .select("job_id,user_id,workspace_id,quote_json,reserved_credits,status,settlement_json")
    .eq("job_id", jobId).maybeSingle();
  if (error) throw databaseError(error);
  return data ? fundedRow(data, jobId) : null;
}

export async function reservePricedUsage(supabase: SupabaseClient, quote: UsageQuote, now: string) {
  const canonical = validatedQuote(quote);
  if (BigInt(canonical.reservedCredits) > 2147483647n) throw new AppError(422, "quote exceeds ledger capacity");
  // Recovery can replay an expired saved quote, but may NOT dispatch again.
  const existing = await loadFundedUsage(supabase, canonical.scope.jobId);
  if (existing) {
    if (!isDeepStrictEqual(existing.quote_json, canonical)) throw new AppError(409, "funded quote request conflict");
    return existing;
  }
  assertQuoteDispatchable(canonical, now);
  const { data, error } = await supabase.rpc("reserve_funded_usage_quote", { p_quote: canonical });
  if (error) throw databaseError(error);
  const row = fundedRow(data, canonical.scope.jobId);
  if (!isDeepStrictEqual(row.quote_json, canonical)) throw new AppError(500, "reserved quote does not match request");
  return row;
}

export async function settlePricedUsage(
  supabase: SupabaseClient, jobId: string, receipt: Parameters<typeof reconcileUsage>[1],
) {
  const saved = await loadFundedUsage(supabase, jobId);
  if (!saved) throw new AppError(409, "generation has no funded quote");
  // Always compute from saved prices. No debit amount or updated rate catalog is
  // accepted from the caller; estimated/unscoped usage cannot reach the RPC.
  const settlement = reconcileUsage(saved.quote_json, receipt);
  if (saved.settlement_json !== null) {
    if (!isDeepStrictEqual(saved.settlement_json, settlement)) throw new AppError(409, "quote settlement conflict");
    return saved;
  }
  const { data, error } = await supabase.rpc("settle_funded_usage_quote", { p_job_id: jobId, p_settlement: settlement });
  if (error) throw databaseError(error);
  const result = fundedRow(data, jobId);
  if (!isDeepStrictEqual(result.quote_json, saved.quote_json) || !isDeepStrictEqual(result.settlement_json, settlement)
    || result.status !== (settlement.status === "settle" ? "settled" : "requires_review")) {
    throw new AppError(500, "settlement response does not match request");
  }
  return result;
}
