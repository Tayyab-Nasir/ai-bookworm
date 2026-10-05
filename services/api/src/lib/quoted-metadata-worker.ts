/** Leased funded metadata generation. Unknown OpenAI outcomes are held for
 * review; only the AI service's durable receipt can recover dispatched work. */
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import type { SupabaseClient } from "./supabase.js";
import { loadFundedUsage, claimPricedDispatch } from "./funded-usage.js";
import { reconcileUsage, type UsageQuote } from "./usage-pricing.js";

const id=z.string().uuid();
const measuredTokens=z.array(z.object({dimension:z.enum(["text_input","text_cached_input","text_output"]),tokens:z.string().regex(/^(0|[1-9][0-9]*)$/)}).strict()).length(3);
const usage=z.object({inputTokens:z.number().int().nonnegative(),outputTokens:z.number().int().nonnegative(),
  estimatedCostUsd:z.number().finite().nonnegative(),latencyMs:z.number().int().nonnegative().optional(),measuredTokens}).strict();
const candidate=z.object({suggestionKind:z.literal("metadata_candidate"),status:z.literal("pending"),
  description:z.string().trim().min(40).max(4000),keywords:z.array(z.string().trim().min(1).max(100)).min(1).max(30),
  categories:z.array(z.string().trim().min(1).max(180)).min(1).max(20),audience:z.string().trim().min(1).max(500),
  rationale:z.string().trim().min(1).max(2000),confidence:z.number().min(0).max(1).nullable(),
  sourceRefs:z.array(z.object({chapterId:id,documentVersionId:id.optional(),nodeId:z.string().trim().min(1).max(200),
    textHash:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict()).min(1).max(30)}).strict();
const request=z.object({jobId:id,workspaceId:id,bookId:id,agentType:z.literal("metadata"),model:z.string().min(1).max(128),
  maxOutputTokens:z.number().int().positive().max(128000),contextPolicy:z.record(z.string(),z.unknown()),
  input:z.object({chapterIds:z.array(id).min(1).max(5),chapters:z.record(id,z.object({id,documentVersionId:id,version:z.number().int().positive(),
    title:z.string().max(500),order:z.number().int().nonnegative(),nodes:z.array(z.object({id:z.string().min(1).max(200),
      text:z.string().min(1).max(30000),textHash:z.string().regex(/^[a-f0-9]{64}$/),truncated:z.boolean()}).strict()).min(1).max(200)}).strict()),
    book:z.record(z.string(),z.unknown()),styleGuide:z.record(z.string(),z.unknown()),bookBible:z.array(z.record(z.string(),z.unknown())).max(50),
    relatedContext:z.array(z.never()).max(0),userInstruction:z.string().min(1).max(2000)}).strict()}).strict();
const quoteRow=z.object({id,user_id:id,workspace_id:id,book_id:id,generation_job_id:id,status:z.enum(["counting","ready","failed"]),
  generation_request_json:z.unknown(),generation_request_sha256:z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  source_sha256:z.string().regex(/^[a-f0-9]{64}$/),accepted_job_id:id.nullable()}).passthrough();
const jobSchema=z.object({id,workspace_id:id,book_id:id,created_by:id,billing_mode:z.literal("quoted"),lease_token:id,
  input_ref:z.object({metadataQuoteRequestId:id,sourceSha256:z.string().regex(/^[a-f0-9]{64}$/),
    generationRequestSha256:z.string().regex(/^[a-f0-9]{64}$/),contextSources:z.array(z.object({chapterId:id,documentVersionId:id,
      nodeId:z.string().min(1).max(200),textHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()).min(1).max(200)}).strict()}).passthrough();
const serviceResult=z.object({status:z.literal("succeeded"),provider:z.literal("openai"),model:z.string().min(1).max(128),
  requestId:z.string().trim().min(1).max(256),suggestions:z.array(z.unknown()).length(1),diagnostics:z.array(z.object({
    severity:z.enum(["error","warning","info"]),code:z.string().min(1).max(200),message:z.string().min(1).max(2000),location:z.record(z.string(),z.unknown()),
  }).strict()).max(500),usage}).passthrough();
const requestHash=z.object({inputSha256:z.string().regex(/^[a-f0-9]{64}$/),model:z.string().min(1).max(128),
  maxOutputTokens:z.number().int().positive(),agentType:z.literal("metadata")}).strict();
type Job=z.output<typeof jobSchema>;
type Completion=z.output<typeof serviceResult> & {candidate:z.output<typeof candidate>};
export type QuotedMetadataOutcome={status:"idle"|"succeeded"|"completion_unknown"|"requires_review";jobId?:string};
const first=(value:unknown)=>Array.isArray(value)?value[0]:value;
const serviceUrl=()=> (process.env.AI_SERVICE_URL??`http://127.0.0.1:${process.env.AI_SERVICE_PORT??"8000"}`).replace(/\/$/u,"");
const headers=()=>({"content-type":"application/json",...(process.env.AI_SERVICE_TOKEN?{"x-service-token":process.env.AI_SERVICE_TOKEN}:{})});

async function savedQuote(sb:SupabaseClient,job:Job){
  const {data,error}=await sb.from("metadata_token_quote_requests").select("*").eq("id",job.input_ref.metadataQuoteRequestId).maybeSingle();
  if(error||!data)throw new Error("metadata quote unavailable");
  const row=quoteRow.parse(data);const saved=request.parse(row.generation_request_json);
  if(row.status!=="ready"||row.accepted_job_id!==job.id||row.generation_job_id!==job.id||row.user_id!==job.created_by
    ||row.workspace_id!==job.workspace_id||row.book_id!==job.book_id||row.source_sha256!==job.input_ref.sourceSha256
    ||row.generation_request_sha256!==job.input_ref.generationRequestSha256||saved.jobId!==job.id
    ||saved.workspaceId!==job.workspace_id||saved.bookId!==job.book_id||saved.agentType!=="metadata") throw new Error("metadata quote/job mismatch");
  const refs=saved.input.chapterIds.flatMap((chapterId)=>saved.input.chapters[chapterId]!.nodes.map((node)=>({chapterId,
    documentVersionId:saved.input.chapters[chapterId]!.documentVersionId,nodeId:node.id,textHash:node.textHash})));
  const ordered=(items:typeof refs)=>[...items].sort((a,b)=>a.chapterId.localeCompare(b.chapterId)||a.nodeId.localeCompare(b.nodeId));
  if(!isDeepStrictEqual(ordered(refs),ordered(job.input_ref.contextSources))) throw new Error("metadata source refs changed");
  return {row,request:saved};
}

async function sourcesCurrent(sb:SupabaseClient,job:Job,gen:z.output<typeof request>){
  const chapterIds=gen.input.chapterIds;
  const {data,error}=await sb.from("chapters").select("id,current_document_version_id").eq("book_id",job.book_id).in("id",chapterIds);
  if(error||!data||data.length!==chapterIds.length)return false;
  const current=new Map(data.map((item)=>[item.id,item.current_document_version_id]));
  return chapterIds.every((chapterId)=>current.get(chapterId)===gen.input.chapters[chapterId]?.documentVersionId);
}

function validateResult(raw:unknown,job:Job,gen:z.output<typeof request>,expectedModel:string):Completion{
  const parsed=serviceResult.parse(raw);if(parsed.model!==expectedModel||parsed.suggestions.length!==1)throw new Error("metadata receipt identity mismatch");
  const result=candidate.parse(parsed.suggestions[0]);
  for(const source of result.sourceRefs){
    const chapter=gen.input.chapters[source.chapterId];if(!chapter|| (source.documentVersionId&&source.documentVersionId!==chapter.documentVersionId))throw new Error("metadata citation outside saved source");
    const node=chapter.nodes.find((item)=>item.id===source.nodeId&&(!source.textHash||source.textHash===item.textHash));
    if(!node)throw new Error("metadata citation hash mismatch");
  }
  if(parsed.jobId!==job.id||parsed.bookId!==job.book_id||parsed.workspaceId!==job.workspace_id||parsed.agentType!=="metadata")throw new Error("metadata receipt scope mismatch");
  const counts=new Map(parsed.usage.measuredTokens.map((item)=>[item.dimension,BigInt(item.tokens)]));
  if(counts.size!==3||counts.get("text_input")!+counts.get("text_cached_input")!!==BigInt(parsed.usage.inputTokens)
    ||counts.get("text_output")!==BigInt(parsed.usage.outputTokens))throw new Error("invalid measured metadata usage");
  return {...parsed,candidate:result};
}

async function readSavedResult(fetcher:typeof fetch,jobId:string){
  const response=await fetcher(`${serviceUrl()}/v1/ai/jobs/${jobId}`,{method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),headers:headers()});
  const text=await response.text();if(!response.ok||Buffer.byteLength(text)>2_000_000)throw new Error("metadata result unavailable");
  return JSON.parse(text) as unknown;
}

async function review(sb:SupabaseClient,job:Job,reason:"provider_outcome_unknown"|"invalid_result"|"unreconciled_receipt",requestId:string){
  const result=await sb.rpc("mark_quoted_metadata_requires_review",{p_job_id:job.id,p_lease_token:job.lease_token,p_reason:reason,p_request_id:requestId});
  if(result.error||result.data!==true)throw new Error("metadata review hold uncertain");
  return {status:"requires_review" as const,jobId:job.id};
}

export async function runOneQuotedMetadataJob(sb:SupabaseClient,options:{leaseSeconds?:number;fetcher?:typeof fetch}={}):Promise<QuotedMetadataOutcome>{
  const leaseSeconds=options.leaseSeconds??180;
  const claimed=await sb.rpc("claim_quoted_metadata_job",{p_lease_seconds:leaseSeconds});if(claimed.error)throw new Error("metadata job claim unavailable");
  const parsed=jobSchema.safeParse(first(claimed.data));if(!parsed.success)return first(claimed.data)?{status:"completion_unknown"}:{status:"idle"};
  const job=parsed.data,fetcher=options.fetcher??fetch,abort=new AbortController();let renewal:Promise<void>|undefined;
  let dispatchAttempted=false,completionAttempted=false;
  const heartbeat=setInterval(()=>{if(renewal)return;renewal=Promise.resolve(sb.rpc("renew_quoted_metadata_lease",{
    p_job_id:job.id,p_lease_token:job.lease_token,p_lease_seconds:leaseSeconds,
  })).then((result)=>{if(result.error||result.data!==true)abort.abort();}).catch(()=>abort.abort()).finally(()=>{renewal=undefined;});},Math.floor(leaseSeconds*1000/3));
  heartbeat.unref();
  const waitRenewal=async()=>{if(renewal)await renewal;abort.signal.throwIfAborted();};
  const holdForReview=async(reason:Parameters<typeof review>[2],requestId:string)=>{
    if(renewal)await renewal;
    if(abort.signal.aborted)return {status:"completion_unknown" as const,jobId:job.id};
    return review(sb,job,reason,requestId);
  };
  const savedCompletion=async()=>{
    const saved=await sb.from("ai_jobs").select("id,status").eq("id",job.id).eq("workspace_id",job.workspace_id)
      .eq("book_id",job.book_id).eq("created_by",job.created_by).eq("billing_mode","quoted").maybeSingle();
    return !saved.error&&saved.data?.id===job.id&&saved.data.status==="succeeded";
  };
  try{
    const {row,request:gen}=await savedQuote(sb,job);
    const funded=await loadFundedUsage(sb,job.id);if(!funded||funded.user_id!==job.created_by||funded.workspace_id!==job.workspace_id
      ||funded.status!="held"&&funded.status!="settled"||funded.quote_json.scope.inputSha256!==job.input_ref.generationRequestSha256
      ||funded.quote_json.price.model!==gen.model||funded.quote_json.maximumTokens.find((item)=>item.dimension==="text_output")?.tokens!==String(gen.maxOutputTokens))
      throw new Error("metadata funded quote mismatch");
    const quote=funded.quote_json as UsageQuote;let raw:unknown;
    const {data:dispatch,error:dispatchError}=await sb.from("funded_usage_quotes").select("dispatched_at").eq("job_id",job.id).maybeSingle();
    if(dispatchError||!dispatch)throw new Error("metadata dispatch state unavailable");
    if(funded.status==="held"&&!dispatch.dispatched_at&&!await sourcesCurrent(sb,job,gen)){
      await waitRenewal();
      const cancelled=await sb.rpc("fail_quoted_metadata_before_dispatch",{p_job_id:job.id,p_lease_token:job.lease_token,p_reason:"source_changed"});
      if(cancelled.error||cancelled.data!==true)throw new Error("metadata stale-source release uncertain");
      return {status:"requires_review",jobId:job.id};
    }
    if(dispatch?.dispatched_at){
      try{raw=await readSavedResult(fetcher,job.id);}catch{return await holdForReview("provider_outcome_unknown",`metadata-dispatch-unknown:${job.id}`);}
    }else{
      const hashResponse=await fetcher(`${serviceUrl()}/v1/ai/text/request-hash`,{method:"POST",redirect:"error",signal:AbortSignal.timeout(30000),
        headers:headers(),body:JSON.stringify(gen)});
      const hashText=await hashResponse.text();if(!hashResponse.ok||Buffer.byteLength(hashText)>65536)throw new Error("metadata request hash unavailable");
      const checked=requestHash.parse(JSON.parse(hashText));
      if(checked.inputSha256!==quote.scope.inputSha256||checked.model!==quote.price.model||checked.maxOutputTokens!==gen.maxOutputTokens){
        await waitRenewal();
        const failed=await sb.rpc("fail_quoted_metadata_before_dispatch",{p_job_id:job.id,p_lease_token:job.lease_token,p_reason:"request_mismatch"});
        if(failed.error||failed.data!==true)throw new Error("metadata request mismatch release uncertain");
        return {status:"requires_review",jobId:job.id};
      }
      await waitRenewal();await claimPricedDispatch(sb,{jobId:job.id,leaseToken:job.lease_token,inputSha256:quote.scope.inputSha256,model:quote.price.model});
      dispatchAttempted=true;
      await waitRenewal();
      try{
        const response=await fetcher(`${serviceUrl()}/v1/ai/jobs`,{method:"POST",redirect:"error",signal:AbortSignal.any([abort.signal,AbortSignal.timeout(150000)]),
          headers:headers(),body:JSON.stringify({...gen,idempotencyKey:`quoted-metadata:${job.id}`,expectedInputSha256:quote.scope.inputSha256})});
        const text=await response.text();if(!response.ok||Buffer.byteLength(text)>2_000_000)throw new Error("metadata generation outcome unavailable");raw=JSON.parse(text);
      }catch{
        try{raw=await readSavedResult(fetcher,job.id);}catch{return await holdForReview("provider_outcome_unknown",`metadata-dispatch-unknown:${job.id}`);}
      }
    }
    let completion:Completion;
    try{completion=validateResult(raw,job,gen,quote.price.model);}catch{return await holdForReview("invalid_result",`metadata-result-review:${job.id}`);}
    const measured={scope:quote.scope,provider:"openai" as const,model:completion.model,requestId:completion.requestId,
      measurement:"measured" as const,tokens:completion.usage.measuredTokens};
    let settlement:ReturnType<typeof reconcileUsage>;
    try{settlement=reconcileUsage(quote,measured);}catch{return await holdForReview("unreconciled_receipt",completion.requestId);}
    if(settlement.status==="requires_review")return await holdForReview("unreconciled_receipt",completion.requestId);
    await waitRenewal();
    completionAttempted=true;
    const completed=await sb.rpc("complete_quoted_metadata_job",{p_job_id:job.id,p_lease_token:job.lease_token,
      p_provider:completion.provider,p_model:completion.model,
      p_usage:completion.usage,p_diagnostics:completion.diagnostics,p_candidate:completion.candidate,p_settlement:settlement});
    const completedJob=first(completed.data) as {id?:string;status?:string}|null;
    if(completed.error||completedJob?.id!==job.id||completedJob.status!=="succeeded"){
      return {status:await savedCompletion()?"succeeded":"completion_unknown",jobId:job.id};
    }
    return {status:"succeeded",jobId:job.id};
  }catch{
    if(completionAttempted){try{if(await savedCompletion())return {status:"succeeded",jobId:job.id};}catch{/* Keep the ambiguous completion for status recovery. */}
      return {status:"completion_unknown",jobId:job.id};}
    if(abort.signal.aborted)return {status:"completion_unknown",jobId:job.id};
    if(dispatchAttempted){
      // The durable AI service result endpoint is the only safe retry path;
      // a future lease will read it. Never turn a timeout into another POST.
      try{const raw=await readSavedResult(fetcher,job.id);validateResult(raw,job,request.parse((await savedQuote(sb,job)).request),
        (await loadFundedUsage(sb,job.id))!.quote_json.price.model);}
      catch{return await holdForReview("provider_outcome_unknown",`metadata-dispatch-unknown:${job.id}`);}
    }
    return {status:"completion_unknown",jobId:job.id};
  }finally{clearInterval(heartbeat);await renewal;}
}
