import { createHash } from "node:crypto";
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import { prepareTranslationQuote, type TranslationTokenCounter } from "./translation-quote.js";
import { quoteCatalogTranslation, readTranslationCatalog } from "./translation-catalog.js";

const chapterSchema=z.object({jobId:z.string().uuid(),chapterId:z.string().uuid(),documentVersionId:z.string().uuid(),
  chapterOrder:z.number().int().nonnegative(),sourceSha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const countSchema=z.object({inputTokens:z.number().int().positive().max(2000000),inputSha256:z.string().regex(/^[a-f0-9]{64}$/),model:z.string().min(1)}).strict();
const requestSchema=z.object({id:z.string().uuid(),user_id:z.string().uuid(),workspace_id:z.string().uuid(),
  source_language:z.string(),target_language:z.string(),model_id:z.string(),catalog_json:z.unknown(),
  chapters_json:z.array(chapterSchema).min(1).max(500),counts_json:z.record(countSchema),lease_token:z.string().uuid()});

/** One leased chapter per step bounds runtime for a 500-chapter book. Saved
 * counts survive process restarts; abandoned running steps fail, never recount. */
export async function runOneTranslationQuoteStep(sb: SupabaseClient, options:{counter?:TranslationTokenCounter;clock?:()=>string}={}) {
  const claim=await sb.rpc("claim_translation_quote_request");
  if (claim.error) throw new Error("quote request claim unavailable");
  const raw=Array.isArray(claim.data)?claim.data[0]:claim.data;
  if (!raw) return {status:"idle"};
  const parsed=requestSchema.safeParse(raw);
  if (!parsed.success) return {status:"completion_unknown"};
  const request=parsed.data; const clock=options.clock??(()=>new Date().toISOString());
  try {
    const catalogJson=JSON.stringify(request.catalog_json);
    const catalog=readTranslationCatalog(catalogJson,clock());
    const entry=catalog.entries.find((item)=>item.id===request.model_id);
    if (!entry || new Set(request.chapters_json.map((c)=>c.jobId)).size!==request.chapters_json.length
      || Object.keys(request.counts_json).some((id)=>!request.chapters_json.some((c)=>c.jobId===id))) throw new Error("invalid request counts");
    const pending=request.chapters_json.find((chapter)=>!request.counts_json[chapter.jobId]);
    if (pending) {
      const doc=await sb.from("document_versions").select("plain_text").eq("id",pending.documentVersionId).eq("chapter_id",pending.chapterId).maybeSingle();
      if (doc.error || typeof doc.data?.plain_text!=="string" || createHash("sha256").update(doc.data.plain_text).digest("hex")!==pending.sourceSha256) throw new Error("source changed");
      const counted=await prepareTranslationQuote(catalogJson,{modelId:request.model_id,text:doc.data.plain_text,
        sourceLanguage:request.source_language,targetLanguage:request.target_language,
        scope:{jobId:pending.jobId,userId:request.user_id,workspaceId:request.workspace_id}},options);
      const recorded=await sb.rpc("record_translation_quote_count",{p_request_id:request.id,p_lease_token:request.lease_token,p_job_id:pending.jobId,
        p_count:{inputTokens:counted.countedInputTokens,inputSha256:counted.quote.scope.inputSha256,model:counted.quote.price.model}});
      if (recorded.error || recorded.data!==true) throw new Error("count persistence unknown");
      return {status:"counted",requestId:request.id};
    }
    const now=clock();
    const chapters=request.chapters_json.map((chapter)=>{
      const count=request.counts_json[chapter.jobId];
      if (count.model!==entry.price.model) throw new Error("count model changed");
      const priced=quoteCatalogTranslation(catalogJson,{modelId:request.model_id,
        scope:{jobId:chapter.jobId,userId:request.user_id,workspaceId:request.workspace_id,inputSha256:count.inputSha256},
        maximumInputTokens:count.inputTokens,now});
      return {...chapter,quote:priced.quote};
    });
    const completed=await sb.rpc("complete_translation_quote_request",{p_request_id:request.id,p_lease_token:request.lease_token,p_chapters:chapters});
    if (completed.error || completed.data!==request.id) throw new Error("proposal persistence unknown");
    return {status:"ready",requestId:request.id};
  } catch {
    // CAS cannot overwrite a committed checkpoint or completed proposal. If this
    // write is uncertain too, the expired lease is terminalized by the next claim.
    try { await sb.rpc("fail_translation_quote_request",{p_request_id:request.id,p_lease_token:request.lease_token}); } catch { /* leave lease for terminal recovery */ }
    return {status:"completion_unknown",requestId:request.id};
  }
}
