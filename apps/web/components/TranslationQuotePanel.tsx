"use client";

import { useEffect, useRef, useState } from "react";
import type { TranslationModelChoice, TranslationProjectResult, TranslationProposalResult, TranslationQuoteRequestResult } from "@bookworm/api-client";
import { apiClient } from "./api";

const button="rounded-full border border-white/20 px-4 py-2 text-sm hover:border-white/50 disabled:cursor-not-allowed disabled:opacity-40";
const input="mt-2 w-full rounded-xl border border-white/20 bg-black px-3 py-3 text-sm text-white";

export default function TranslationQuotePanel({bookId,sourceLanguage,editable,disabled,onAccepted}:{
  bookId:string;sourceLanguage:string;editable:boolean;disabled:boolean;onAccepted:(project:TranslationProjectResult)=>void;
}) {
  const api=apiClient();
  const [models,setModels]=useState<TranslationModelChoice[]>([]),[modelId,setModelId]=useState("");
  const [target,setTarget]=useState(""),[consent,setConsent]=useState(false);
  const [requests,setRequests]=useState<TranslationQuoteRequestResult[]>([]);
  const [proposal,setProposal]=useState<TranslationProposalResult|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[catalogError,setCatalogError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null);
  const lock=useRef(false),intent=useRef<{signature:string;key:string}|null>(null);
  useEffect(()=>{
    let active=true;
    void api.listTranslationModels().then((result)=>{if(active){setModels(result.models);setModelId(result.models[0]?.id??"");}})
      .catch(()=>{if(active)setCatalogError("New usage-priced quotes are currently unavailable. You can still refresh existing requests and accepted translations.");});
    void api.listTranslationQuoteRequests(bookId).then((result)=>{if(active)setRequests(result.requests);})
      .catch(()=>{if(active)setError("Could not load your quote history. Refresh before creating another request.");});
    return()=>{active=false;};
  },[api,bookId]);
  const run=async(action:()=>Promise<void>)=>{
    if(lock.current||disabled)return; lock.current=true;setBusy(true);setError(null);setNotice(null);
    try{await action();}catch(reason){setError(reason instanceof Error?reason.message:"Could not confirm the result. Refresh this request before retrying.");}
    finally{lock.current=false;setBusy(false);}
  };
  const refresh=()=>run(async()=>{
    const result=await api.listTranslationQuoteRequests(bookId);setRequests(result.requests);
    if(proposal)setProposal(await api.getTranslationProposal(proposal.id));
  });
  const requestQuote=()=>run(async()=>{
    const language=target.trim().toLowerCase();
    if(!editable||!consent||!modelId||!/^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/.test(language)||language===sourceLanguage.toLowerCase())throw new Error("Choose a different target language and consent to token counting.");
    const signature=JSON.stringify({bookId,modelId,language});
    if(intent.current?.signature!==signature)intent.current={signature,key:crypto.randomUUID()};
    const result=await api.requestTranslationQuote(bookId,{targetLanguage:language,modelId,idempotencyKey:intent.current.key,allowProviderTokenCounting:true});
    setRequests((current)=>[result,...current.filter((item)=>item.id!==result.id)]);
    setNotice("Quote preparation requested. No translation has started and no credits are held. Refresh to check progress.");
  });
  const review=(proposalId:string)=>run(async()=>{setProposal(null);setProposal(await api.getTranslationProposal(proposalId));});
  const freshRequest=(request:TranslationQuoteRequestResult)=>{
    intent.current=null;setModelId(request.modelId);setTarget(request.targetLanguage);setProposal(null);setConsent(false);
    setNotice("Review the language and model above, then consent and prepare a new quote. The previous request will not be repeated.");
  };
  const accept=()=>run(async()=>{
    if(!proposal||!editable)return;
    if(proposal.acceptedProjectId){onAccepted(await api.getTranslationProject(proposal.acceptedProjectId));return;}
    if(proposal.status!=="ready"||Date.parse(proposal.expiresAt)<=Date.now())throw new Error("This quote expired. Request a fresh quote before confirming credits.");
    const project=await api.acceptTranslationQuote(proposal.id,proposal.reservedCredits);
    setProposal({...proposal,status:"accepted",acceptedProjectId:project.id});onAccepted(project);
    setNotice("Quote accepted. Credits are held and the translation is queued. Final measured usage releases unused credits.");
  });
  const locked=busy||disabled;
  return <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6" aria-labelledby="translation-quote-heading">
    <h2 id="translation-quote-heading" className="text-xl font-medium">Review the cost before translating</h2>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">Source: {sourceLanguage.toUpperCase()}. Prepare a quote for your saved chapters, review the maximum credit hold, then confirm. Your source manuscript stays unchanged.</p>
    {catalogError&&<p role="status" className="mt-4 text-sm text-amber-100">{catalogError}</p>}
    {error&&<p role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">{error}</p>}
    {notice&&<p role="status" className="mt-4 text-sm text-emerald-100">{notice}</p>}
    <fieldset disabled={!editable||locked||!models.length} className="mt-5 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-white/75">Translation model<select className={input} value={modelId} onChange={(event)=>{setModelId(event.target.value);intent.current=null;}}><option value="" disabled>Select a model</option>{models.map((model)=><option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
        <label className="text-sm text-white/75">Target language code<input className={input} placeholder="es or pt-BR" maxLength={35} value={target} onChange={(event)=>{setTarget(event.target.value);intent.current=null;}} /></label>
      </div>
      <label className="flex items-start gap-3 text-sm leading-6 text-white/70"><input className="mt-1 size-4 shrink-0" type="checkbox" checked={consent} onChange={(event)=>setConsent(event.target.checked)} />I agree to send the saved chapter text to OpenAI to count input tokens for this quote. This does not start translation or authorize a credit hold.</label>
      <button type="button" className={button} disabled={!consent||!modelId} onClick={()=>void requestQuote()}>{busy?"Working…":"Prepare quote"}</button>
    </fieldset>
    {!editable&&<p className="mt-3 text-sm text-amber-100">Editing access is required to request or accept a quote.</p>}
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-5"><h3 className="font-medium">Your quote requests</h3><button type="button" className={button} disabled={locked} onClick={()=>void refresh()}>Refresh quotes</button></div>
    {!requests.length?<p className="mt-3 text-sm text-white/50">No recent quote requests. If a response was lost, refresh here before requesting again.</p>:<ul className="mt-3 space-y-3">{requests.map((request)=><li key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 p-4"><div><p className="text-sm">{request.targetLanguage.toUpperCase()} · {request.countedChapters}/{request.chapterCount} chapters counted</p><p className="mt-1 text-xs text-white/55">{request.status==="failed"?"Preparation stopped. No translation was purchased. Review the request before trying again.":request.status==="ready"?"Quote ready for review":request.status==="running"?"Counting a chapter…":"Waiting for the quote worker"}</p></div>{request.status==="failed"&&<button type="button" className={button} disabled={locked||!editable} onClick={()=>freshRequest(request)}>Prepare a new quote</button>}{request.proposalId&&<button type="button" className={button} disabled={locked} onClick={()=>void review(request.proposalId!)}>Review quote</button>}</li>)}</ul>}
    {proposal&&<div className="mt-6 rounded-xl border border-emerald-300/25 bg-emerald-300/[0.04] p-5" aria-label="Review translation quote">
      <p className="text-sm text-white/60">{proposal.sourceLanguage.toUpperCase()} → {proposal.targetLanguage.toUpperCase()} · {proposal.chapters.length} saved chapters</p>
      <p className="mt-2 text-3xl font-medium tabular-nums">{proposal.reservedCredits} <span className="text-base text-white/60">credits maximum hold</span></p>
      <p className="mt-3 text-sm leading-6 text-white/65">Unused held credits return after measured usage is settled. Usage outside the quote stays held for review. Cancellation is available only before any chapter is dispatched.</p>
      <p className="mt-2 text-xs text-white/55">Expires: {new Date(proposal.expiresAt).toLocaleString()} · {proposal.status}</p>
      <details className="mt-4 text-sm"><summary className="cursor-pointer">Saved chapter versions and model</summary><ul className="mt-2 space-y-2 text-xs text-white/60">{proposal.chapters.map((chapter)=><li key={chapter.chapterId} className="break-words">Chapter {chapter.chapterOrder+1}: {chapter.reservedCredits} credits · {chapter.model}<br/>Saved version: {chapter.documentVersionId}</li>)}</ul></details>
      <button type="button" className={`${button} mt-5 bg-white text-black`} disabled={locked||!editable||proposal.status==="expired"} onClick={()=>void accept()}>{proposal.acceptedProjectId?"Open accepted translation":`Confirm ${proposal.reservedCredits}-credit hold & translate`}</button>
      {proposal.status==="expired"&&<button type="button" className={`${button} ml-3 mt-3`} disabled={locked} onClick={()=>{intent.current=null;setProposal(null);setNotice("Choose a model and language above to request a fresh quote.");}}>Request a fresh quote</button>}
    </div>}
  </section>;
}
