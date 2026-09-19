import { z } from "zod";
import { AppError } from "../errors.js";

const credits = z.string().regex(/^(0|[1-9][0-9]{0,20})$/);
const rowSchema = z.object({
  job_id: z.string().uuid(), user_id: z.string().uuid(), workspace_id: z.string().uuid(),
  reserved_credits: z.number().int().positive().max(2147483647),
  status: z.enum(["held", "settled", "requires_review", "cancelled"]),
  settlement_json: z.unknown().nullable(),
});

/** Public projection only: never return raw quotes, receipts or provider IDs.
 * Missing or inconsistent accounting is unavailable, not a zero-cost success. */
export function summarizeTranslationBilling(rows: unknown, jobIds: string[], userId: string, workspaceId: string) {
  const parsed = z.array(rowSchema).safeParse(rows);
  const unavailable = () => new AppError(503, "Translation billing is not available yet. Refresh before making another payment.");
  if (!parsed.success || !jobIds.length || new Set(jobIds).size !== jobIds.length
    || parsed.data.length !== jobIds.length || new Set(parsed.data.map((r) => r.job_id)).size !== jobIds.length) throw unavailable();
  let reserved = 0n, held = 0n, charged = 0n, returned = 0n, reviewChapters = 0;
  for (const row of parsed.data) {
    if (!jobIds.includes(row.job_id) || row.user_id !== userId || row.workspace_id !== workspaceId) throw unavailable();
    const amount = BigInt(row.reserved_credits); reserved += amount;
    if (row.status === "held") {
      if (row.settlement_json !== null) throw unavailable();
      held += amount;
    } else if (row.status === "requires_review") {
      const receipt = z.object({ status: z.literal("requires_review"), heldCredits: credits }).safeParse(row.settlement_json);
      if (!receipt.success || BigInt(receipt.data.heldCredits) !== amount) throw unavailable();
      held += amount; reviewChapters += 1;
    } else if (row.status === "cancelled") {
      const receipt = z.object({ status: z.literal("cancelled"), releaseCredits: credits }).safeParse(row.settlement_json);
      if (!receipt.success || BigInt(receipt.data.releaseCredits) !== amount) throw unavailable();
      returned += amount;
    } else {
      const receipt = z.object({ status: z.literal("settle"), debitCredits: credits, releaseCredits: credits }).safeParse(row.settlement_json);
      if (!receipt.success || BigInt(receipt.data.debitCredits) + BigInt(receipt.data.releaseCredits) !== amount) throw unavailable();
      charged += BigInt(receipt.data.debitCredits); returned += BigInt(receipt.data.releaseCredits);
    }
  }
  return { reservedCredits: reserved.toString(), heldCredits: held.toString(), chargedCredits: charged.toString(),
    returnedCredits: returned.toString(), reviewChapters, chapterCount: jobIds.length };
}
