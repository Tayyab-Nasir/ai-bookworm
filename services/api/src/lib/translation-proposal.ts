import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { quoteUsage, type UsageQuote } from "./usage-pricing.js";
import { AppError } from "../errors.js";

const schema=z.object({id:z.string().uuid(),book_id:z.string().uuid(),workspace_id:z.string().uuid(),user_id:z.string().uuid(),
  source_language:z.string(),target_language:z.string(),reserved_credits:z.number().int().positive().max(2147483647),
  expires_at:z.string(),accepted_project_id:z.string().uuid().nullable(),
  chapters_json:z.array(z.object({jobId:z.string().uuid(),chapterId:z.string().uuid(),documentVersionId:z.string().uuid(),
    chapterOrder:z.number().int().nonnegative(),quote:z.unknown()})).min(1).max(500)});
export function publicTranslationProposal(value:unknown,now=Date.now()) {
  try {
    const proposal=schema.parse(value); const expiry=Date.parse(proposal.expires_at);
    if (!Number.isFinite(expiry) || !Number.isFinite(now)) throw new Error("invalid expiry");
    let total=0n;
    const chapters=proposal.chapters_json.map((chapter)=>{
      const raw=chapter.quote as UsageQuote; const quote=quoteUsage(raw);
      if (!isDeepStrictEqual(raw,quote) || quote.scope.jobId!==chapter.jobId || quote.scope.userId!==proposal.user_id
        || quote.scope.workspaceId!==proposal.workspace_id || Date.parse(quote.expiresAt)<expiry) throw new Error("quote mismatch");
      total+=BigInt(quote.reservedCredits);
      return {chapterId:chapter.chapterId,documentVersionId:chapter.documentVersionId,chapterOrder:chapter.chapterOrder,
        reservedCredits:quote.reservedCredits,model:quote.price.model};
    });
    if (total!==BigInt(proposal.reserved_credits) || new Set(chapters.map((c)=>c.chapterId)).size!==chapters.length) throw new Error("proposal total mismatch");
    return {id:proposal.id,bookId:proposal.book_id,sourceLanguage:proposal.source_language,targetLanguage:proposal.target_language,
      reservedCredits:proposal.reserved_credits,expiresAt:new Date(expiry).toISOString(),
      status:proposal.accepted_project_id?"accepted" as const:expiry<=now?"expired" as const:"ready" as const,
      acceptedProjectId:proposal.accepted_project_id,chapters};
  } catch { throw new AppError(503,"Could not verify this quote. Refresh before confirming credits."); }
}
