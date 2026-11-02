"use client";

import { useEffect, useRef, useState } from "react";
import type { TranslationModelChoice, TranslationProjectResult, TranslationProposalResult, TranslationQuoteRequestResult } from "@bookworm/api-client";
import { apiClient } from "./api";

const button="rounded-full border border-white/20 px-4 py-2 text-sm hover:border-white/50 disabled:cursor-not-allowed disabled:opacity-40";
const input="mt-2 w-full rounded-xl border border-white/20 bg-black px-3 py-3 text-sm text-white";

type TranslationScope = { actor: string; current: () => boolean; begin: () => () => boolean; checked: <T>(work: () => Promise<T>) => Promise<T> };
type PendingQuote = { bookId: string; key: string; fingerprint: string };
type PendingAcceptance = { bookId: string; proposalId: string; fingerprint: string };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/iu;
const canonicalUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const languageCode = /^[a-z]{2,8}(?:-[a-z0-9]{2,8})*$/;
const digestPattern = /^[a-f0-9]{64}$/;
async function fingerprint(value: unknown): Promise<string> {
  const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("");
}
function pendingStorageKey(actor: string, bookId: string) {
  if (!uuid.test(actor) || !uuid.test(bookId)) throw new Error("A verified account and book are required.");
  return `bookworm:translation-quote:${actor}:${bookId}`;
}
function readPending(actor: string, bookId: string): PendingQuote | null {
  const raw = sessionStorage.getItem(pendingStorageKey(actor, bookId));
  if (raw === null) return null;
  if (raw.length > 500) throw new Error("Recovery data is unreadable.");
  const value = JSON.parse(raw) as Partial<PendingQuote> | null;
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "bookId,fingerprint,key"
    || value.bookId !== bookId || typeof value.key !== "string" || !canonicalUuid.test(value.key)
    || typeof value.fingerprint !== "string" || !digestPattern.test(value.fingerprint)) throw new Error("Recovery data is unreadable.");
  return value as PendingQuote;
}
function savePending(actor: string, pending: PendingQuote) {
  const key = pendingStorageKey(actor, pending.bookId), encoded = JSON.stringify(pending);
  if (readPending(actor, pending.bookId) || readAcceptance(actor, pending.bookId)) throw new Error("A prior translation request still needs recovery.");
  sessionStorage.setItem(key, encoded);
  if (sessionStorage.getItem(key) !== encoded) throw new Error("The recovery request could not be saved.");
}
function clearPending(actor: string, pending: PendingQuote) {
  const current = readPending(actor, pending.bookId);
  if (!current || current.key !== pending.key || current.fingerprint !== pending.fingerprint) throw new Error("The recovery request changed.");
  const key = pendingStorageKey(actor, pending.bookId); sessionStorage.removeItem(key);
  if (sessionStorage.getItem(key) !== null) throw new Error("The recovery request could not be cleared.");
}

function acceptanceStorageKey(actor: string, bookId: string) {
  if (!uuid.test(actor) || !uuid.test(bookId)) throw new Error("A verified account and book are required.");
  return `bookworm:translation-accept:${actor}:${bookId}`;
}
function readAcceptance(actor: string, bookId: string): PendingAcceptance | null {
  const raw=sessionStorage.getItem(acceptanceStorageKey(actor,bookId)); if(raw===null)return null;
  if(raw.length>400)throw new Error("Acceptance recovery is unreadable.");
  const value=JSON.parse(raw) as Partial<PendingAcceptance>|null;
  if(!value||typeof value!=="object"||Object.keys(value).sort().join()!=="bookId,fingerprint,proposalId"||value.bookId!==bookId
    ||typeof value.proposalId!=="string"||!uuid.test(value.proposalId)||typeof value.fingerprint!=="string"||!digestPattern.test(value.fingerprint))throw new Error("Acceptance recovery is unreadable.");
  return value as PendingAcceptance;
}
function saveAcceptance(actor:string,value:PendingAcceptance) {
  const key=acceptanceStorageKey(actor,value.bookId), encoded=JSON.stringify(value);
  if(readPending(actor,value.bookId)||readAcceptance(actor,value.bookId))throw new Error("A prior translation request still needs recovery.");
  sessionStorage.setItem(key,encoded);
  if(sessionStorage.getItem(key)!==encoded)throw new Error("Acceptance recovery could not be saved.");
}
function clearAcceptance(actor:string,value:PendingAcceptance) {
  const existing=readAcceptance(actor,value.bookId);
  if(!existing||existing.proposalId!==value.proposalId||existing.fingerprint!==value.fingerprint)throw new Error("Acceptance recovery changed.");
  const key=acceptanceStorageKey(actor,value.bookId);sessionStorage.removeItem(key);
  if(sessionStorage.getItem(key)!==null)throw new Error("Acceptance recovery could not be cleared.");
}

export default function TranslationQuotePanel({bookId,scope,active,sourceLanguage,editable,disabled,onAccepted}:{
  bookId:string;scope:TranslationScope;active:boolean;sourceLanguage:string;editable:boolean;disabled:boolean;onAccepted:(project:TranslationProjectResult)=>void;
}) {
  const api=apiClient();
  const [models,setModels]=useState<TranslationModelChoice[]>([]),[modelId,setModelId]=useState("");
  const [target,setTarget]=useState(""),[consent,setConsent]=useState(false);
  const [requests,setRequests]=useState<TranslationQuoteRequestResult[]>([]),[historyState,setHistoryState]=useState<"loading"|"ready"|"error">("loading");
  const [proposal,setProposal]=useState<TranslationProposalResult|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[catalogError,setCatalogError]=useState<string|null>(null);
  const [notice,setNotice]=useState<string|null>(null),[pending,setPending]=useState<PendingQuote|null>(null),[acceptance,setAcceptance]=useState<PendingAcceptance|null>(null),[recoveryAvailable,setRecoveryAvailable]=useState(false);
  const lock=useRef(false),recoveryLock=useRef(false),mounted=useRef(false);
  const resolvedRequests=useRef(new Set<string>()),resolvedAcceptances=useRef(new Set<string>());
  const [recoveryBusy,setRecoveryBusy]=useState(false);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{
    if(!active)return;
    let currentEffect=true;
    let saved:PendingQuote|null;
    try { saved=readPending(scope.actor,bookId); const held=readAcceptance(scope.actor,bookId); setPending(saved);setAcceptance(held);setRecoveryAvailable(true); }
    catch { saved=null; setRecoveryAvailable(false); setError("Quote recovery is unavailable. Check browser storage before requesting another quote."); }
    void scope.checked(()=>api.listTranslationModels(scope.actor)).then((result)=>{if(currentEffect&&scope.current()){setModels(result.models);setModelId(previous=>previous||result.models[0]?.id||"");}})
      .catch(()=>{if(currentEffect&&scope.current())setCatalogError("New usage-priced quotes are currently unavailable. You can still refresh existing requests and accepted translations.");});
    void scope.checked(()=>api.listTranslationQuoteRequests(bookId,scope.actor)).then((result)=>{
      if(result.requests.some(item=>item.bookId!==bookId))throw new Error("Quote history mismatch.");
      if(currentEffect&&scope.current()){setRequests(result.requests);setHistoryState("ready");}
    }).catch(()=>{if(currentEffect&&scope.current()){setHistoryState("error");setError("Could not load your quote history. Refresh before creating another request.");}});
    return()=>{currentEffect=false;};
  },[api,bookId,scope,active]);
  const run=async(action:(valid:()=>boolean)=>Promise<void>)=>{
    if(lock.current||disabled||!scope.current())return; const valid=scope.begin(); lock.current=true;setBusy(true);setError(null);setNotice(null);
    try{await action(valid);}catch(error){if(valid() && !(error instanceof Error && error.name==="TranslationScopeChanged"))setError("The result could not be confirmed. Refresh the original request before trying again.");}
    finally{lock.current=false;if(mounted.current)setBusy(false);}
  };
  // Recovery performs only actor-bound reads; it may safely run while the
  // original write is still waiting, but cannot release an unobserved pointer.
  const inspect=async(action:(valid:()=>boolean)=>Promise<void>)=>{
    if(recoveryLock.current||disabled||!scope.current())return;const valid=scope.begin();recoveryLock.current=true;setRecoveryBusy(true);setError(null);setNotice(null);
    try{await action(valid);}catch(error){if(valid() && !(error instanceof Error && error.name==="TranslationScopeChanged"))setError("The result could not be confirmed. Refresh the original request before trying again.");}
    finally{recoveryLock.current=false;if(mounted.current)setRecoveryBusy(false);}
  };
  const refresh=()=>run(async(valid)=>{
    setHistoryState("loading");
    let result: Awaited<ReturnType<typeof api.listTranslationQuoteRequests>>;
    try { result=await scope.checked(()=>api.listTranslationQuoteRequests(bookId,scope.actor)); }
    catch(error) { if(scope.current() && !(error instanceof Error && error.name==="TranslationScopeChanged"))setHistoryState("error");throw error; }
    if(result.requests.some(item=>item.bookId!==bookId)){setHistoryState("error");throw new Error("Quote history mismatch.");}
    if(!valid())return;setRequests(result.requests);setHistoryState("ready");
    if(proposal){const next=await scope.checked(()=>api.getTranslationProposal(proposal.id,scope.actor));if(next.id!==proposal.id||next.bookId!==bookId)throw new Error("Quote mismatch.");if(valid())setProposal(next);}
  });
  const requestQuote=()=>run(async(valid)=>{
    const language=target.trim().toLowerCase();
    if(historyState!=="ready"||!recoveryAvailable||pending||acceptance||!editable||!consent||!modelId||!languageCode.test(language)||language===sourceLanguage.toLowerCase())throw new Error("Choose a different target language and consent to token counting.");
    const signature=await fingerprint({bookId,modelId,language});if(!valid())return;
    const pointer={bookId,key:crypto.randomUUID(),fingerprint:signature};
    const result=await scope.checked(()=>{savePending(scope.actor,pointer);setPending(pointer);setConsent(false);return api.requestTranslationQuote(bookId,{targetLanguage:language,modelId,idempotencyKey:pointer.key,allowProviderTokenCounting:true},scope.actor);});
    if(!valid())return;
    if(result.bookId!==bookId||result.targetLanguage!==language||result.modelId!==modelId||!result.id)throw new Error("Quote request mismatch.");
    const observed=await scope.checked(()=>api.findTranslationQuoteRequest(bookId,pointer.key,scope.actor));
    if(!valid())return;
    if(observed.viewerId!==scope.actor||!observed.request||observed.request.id!==result.id||observed.request.bookId!==bookId||observed.request.targetLanguage!==language||observed.request.modelId!==modelId)throw new Error("Original quote request is not yet confirmed.");
    if(resolvedRequests.current.has(pointer.key))return;
    clearPending(scope.actor,pointer);resolvedRequests.current.add(pointer.key);setPending(null);
    setRequests((current)=>[result,...current.filter((item)=>item.id!==result.id)]);
    setNotice("Quote preparation requested. No translation has started and no credits are held. Refresh to check progress.");
  });
  const checkPending=()=>inspect(async(valid)=>{
    if(!pending||!recoveryAvailable)return;
    const result=await scope.checked(()=>api.findTranslationQuoteRequest(bookId,pending.key,scope.actor));
    if(!valid())return;
    if(result.viewerId!==scope.actor)throw new Error("Quote account mismatch.");
    if(!result.request){setNotice("The original request has not been observed. It may still arrive; check again or contact support. Do not start another quote.");return;}
    const request=result.request;
    if(request.bookId!==bookId||!request.id)throw new Error("Quote scope mismatch.");
    const signature=await fingerprint({bookId,modelId:request.modelId,language:request.targetLanguage});if(!valid())return;
    if(signature!==pending.fingerprint)throw new Error("Quote settings mismatch.");
    clearPending(scope.actor,pending);resolvedRequests.current.add(pending.key);setPending(null);
    setRequests(current=>[request,...current.filter(item=>item.id!==request.id)]);
    setNotice("The original quote request is confirmed. Refresh to check progress.");
  });
  const review=(proposalId:string)=>run(async(valid)=>{setProposal(null);const result=await scope.checked(()=>api.getTranslationProposal(proposalId,scope.actor));if(result.id!==proposalId||result.bookId!==bookId)throw new Error("Quote mismatch.");if(valid())setProposal(result);});
  const freshRequest=(request:TranslationQuoteRequestResult)=>{
    if(pending||acceptance||!recoveryAvailable)return;setModelId(request.modelId);setTarget(request.targetLanguage);setProposal(null);setConsent(false);
    setNotice("Review the language and model above, then consent and prepare a new quote. The previous request will not be repeated.");
  };
  const accept=()=>run(async(valid)=>{
    if(!proposal||!editable||pending||acceptance||!recoveryAvailable||historyState!=="ready")return;
    if(proposal.acceptedProjectId){const project=await scope.checked(()=>api.getTranslationProject(proposal.acceptedProjectId!,false,scope.actor));if(project.id!==proposal.acceptedProjectId||project.bookId!==bookId)throw new Error("Project mismatch.");if(valid())onAccepted(project);return;}
    if(proposal.status!=="ready"||!Number.isFinite(Date.parse(proposal.expiresAt))||Date.parse(proposal.expiresAt)<=Date.now())throw new Error("This quote expired. Request a fresh quote before confirming credits.");
    if(!uuid.test(proposal.id)||!Number.isSafeInteger(proposal.reservedCredits)||proposal.reservedCredits<1||proposal.reservedCredits>2147483647)throw new Error("Invalid quote.");
    const signature=await fingerprint({bookId,proposalId:proposal.id,credits:proposal.reservedCredits});if(!valid())return;
    const pointer:PendingAcceptance={bookId,proposalId:proposal.id,fingerprint:signature};
    const project=await scope.checked(()=>{saveAcceptance(scope.actor,pointer);setAcceptance(pointer);return api.acceptTranslationQuote(proposal.id,proposal.reservedCredits,scope.actor);});
    if(!valid())return;
    if(!project.id||project.bookId!==bookId||project.sourceLanguage!==proposal.sourceLanguage||project.targetLanguage!==proposal.targetLanguage)throw new Error("Project mismatch.");
    const observed=await scope.checked(()=>api.getTranslationProposal(pointer.proposalId,scope.actor));
    if(!valid())return;
    if(observed.id!==proposal.id||observed.bookId!==bookId||observed.status!=="accepted"||observed.acceptedProjectId!==project.id||observed.reservedCredits!==proposal.reservedCredits||observed.sourceLanguage!==proposal.sourceLanguage||observed.targetLanguage!==proposal.targetLanguage)throw new Error("Original quote acceptance is not yet confirmed.");
    if(resolvedAcceptances.current.has(pointer.proposalId))return;
    clearAcceptance(scope.actor,pointer);resolvedAcceptances.current.add(pointer.proposalId);setAcceptance(null);
    setProposal({...proposal,status:"accepted",acceptedProjectId:project.id});onAccepted(project);
    setNotice("Quote accepted. Credits are held and the translation is queued. Final measured usage releases unused credits.");
  });
  const recoverAcceptance=()=>inspect(async(valid)=>{
    if(!acceptance||pending||!recoveryAvailable)return;
    const original=await scope.checked(()=>api.getTranslationProposal(acceptance.proposalId,scope.actor));
    if(!valid())return;
    if(original.id!==acceptance.proposalId||original.bookId!==bookId||!Number.isSafeInteger(original.reservedCredits)||original.reservedCredits<1||original.reservedCredits>2147483647)throw new Error("Acceptance scope mismatch.");
    const signature=await fingerprint({bookId,proposalId:original.id,credits:original.reservedCredits});if(!valid())return;
    if(signature!==acceptance.fingerprint)throw new Error("Acceptance amount mismatch.");
    let project:TranslationProjectResult;
    if(original.acceptedProjectId) {
      if(original.status!=="accepted")throw new Error("Acceptance receipt mismatch.");
      project=await scope.checked(()=>api.getTranslationProject(original.acceptedProjectId!,false,scope.actor));
    }
    else { setProposal(original);setNotice("This acceptance has not been observed. It may still complete; check again or contact support. Do not start another translation.");return; }
    if(!valid())return;
    if(!project.id||project.bookId!==bookId||project.sourceLanguage!==original.sourceLanguage||project.targetLanguage!==original.targetLanguage||(original.acceptedProjectId&&project.id!==original.acceptedProjectId))throw new Error("Project mismatch.");
    clearAcceptance(scope.actor,acceptance);resolvedAcceptances.current.add(acceptance.proposalId);setAcceptance(null);setProposal({...original,status:"accepted",acceptedProjectId:project.id});onAccepted(project);
    setNotice("The original quote acceptance is confirmed. Check held credits and progress below.");
  });
  const locked=busy||disabled;
  if(!active)return null;
  return <section className="mt-8 rounded-2xl border border-white/10 bg-white/[0.025] p-5 sm:p-6" aria-labelledby="translation-quote-heading">
    <h2 id="translation-quote-heading" className="text-xl font-medium">Review the cost before translating</h2>
    <p className="mt-2 max-w-3xl text-sm leading-6 text-white/60">Source: {sourceLanguage.toUpperCase()}. Prepare a quote for your saved chapters, review the maximum credit hold, then confirm. Your source manuscript stays unchanged.</p>
    {acceptance&&<div role="status" className="mt-4 rounded-xl border border-amber-300/30 p-4 text-sm text-amber-100">
      An earlier quote acceptance is unconfirmed and may still complete. Check its status without starting another request; do not start another translation to resolve it.
      <div className="mt-3 flex flex-wrap gap-2"><button type="button" className={button} disabled={disabled||recoveryBusy||Boolean(pending)||!recoveryAvailable} onClick={()=>void recoverAcceptance()}>Check original acceptance</button></div>
    </div>}
    {pending&&<div role="status" className="mt-4 text-sm text-amber-100">A previous quote request is unconfirmed. Check the original request without starting another provider call. A missing result does not prove it cannot still arrive.
      <button type="button" className={`${button} ml-3`} disabled={disabled||recoveryBusy||!recoveryAvailable} onClick={()=>void checkPending()}>Check original quote request</button></div>}
    {catalogError&&<p role="status" className="mt-4 text-sm text-amber-100">{catalogError}</p>}
    {error&&<p role="alert" className="mt-4 rounded-xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-100">{error}</p>}
    {notice&&<p role="status" className="mt-4 text-sm text-emerald-100">{notice}</p>}
    <fieldset disabled={!editable||locked||!models.length||!recoveryAvailable||Boolean(pending)||Boolean(acceptance)||historyState!=="ready"} className="mt-5 space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="text-sm text-white/75">Translation model<select className={input} value={modelId} onChange={(event)=>{setModelId(event.target.value);setConsent(false);}}><option value="" disabled>Select a model</option>{models.map((model)=><option key={model.id} value={model.id}>{model.label}</option>)}</select></label>
        <label className="text-sm text-white/75">Target language code<input className={input} placeholder="es or pt-BR" maxLength={35} value={target} onChange={(event)=>{setTarget(event.target.value);setConsent(false);}} /></label>
      </div>
      <label className="flex items-start gap-3 text-sm leading-6 text-white/70"><input className="mt-1 size-4 shrink-0" type="checkbox" checked={consent} onChange={(event)=>setConsent(event.target.checked)} />I agree to send the saved chapter text to OpenAI to count input tokens for this quote. This does not start translation or authorize a credit hold.</label>
      <button type="button" className={button} disabled={!consent||!modelId} onClick={()=>void requestQuote()}>{busy?"Working…":"Prepare quote"}</button>
    </fieldset>
    {!editable&&<p className="mt-3 text-sm text-amber-100">Editing access is required to request or accept a quote.</p>}
    <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-white/10 pt-5"><h3 className="font-medium">Your quote requests</h3><button type="button" className={button} disabled={locked} onClick={()=>void refresh()}>Refresh quotes</button></div>
    {historyState!=="ready"?<p className="mt-3 text-sm text-white/50">{historyState==="loading"?"Loading quote history…":"Quote history is unavailable. Refresh before requesting another quote."}</p>:!requests.length?<p className="mt-3 text-sm text-white/50">No recent quote requests. If a response was lost, refresh here before requesting again.</p>:<ul className="mt-3 space-y-3">{requests.map((request)=><li key={request.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 p-4"><div><p className="text-sm">{request.targetLanguage.toUpperCase()} · {request.countedChapters}/{request.chapterCount} chapters counted</p><p className="mt-1 text-xs text-white/55">{request.status==="failed"?"Preparation stopped. No translation was purchased. Review the request before trying again.":request.status==="ready"?"Quote ready for review":request.status==="running"?"Counting a chapter…":"Waiting for the quote worker"}</p></div>{request.status==="failed"&&<button type="button" className={button} disabled={locked||!editable||Boolean(pending)||Boolean(acceptance)||!recoveryAvailable} onClick={()=>freshRequest(request)}>Prepare a new quote</button>}{request.proposalId&&<button type="button" className={button} disabled={locked} onClick={()=>void review(request.proposalId!)}>Review quote</button>}</li>)}</ul>}
    {proposal&&<div className="mt-6 rounded-xl border border-emerald-300/25 bg-emerald-300/[0.04] p-5" aria-label="Review translation quote">
      <p className="text-sm text-white/60">{proposal.sourceLanguage.toUpperCase()} → {proposal.targetLanguage.toUpperCase()} · {proposal.chapters.length} saved chapters</p>
      <p className="mt-2 text-3xl font-medium tabular-nums">{proposal.reservedCredits} <span className="text-base text-white/60">credits maximum hold</span></p>
      <p className="mt-3 text-sm leading-6 text-white/65">Unused held credits return after measured usage is settled. Usage outside the quote stays held for review. Cancellation is available only before any chapter is dispatched.</p>
      <p className="mt-2 text-xs text-white/55">Expires: {new Date(proposal.expiresAt).toLocaleString()} · {proposal.status}</p>
      <details className="mt-4 text-sm"><summary className="cursor-pointer">Saved chapter versions and model</summary><ul className="mt-2 space-y-2 text-xs text-white/60">{proposal.chapters.map((chapter)=><li key={chapter.chapterId} className="break-words">Chapter {chapter.chapterOrder+1}: {chapter.reservedCredits} credits · {chapter.model}<br/>Saved version: {chapter.documentVersionId}</li>)}</ul></details>
      <button type="button" className={`${button} mt-5 bg-white text-black`} disabled={locked||!editable||Boolean(pending)||Boolean(acceptance)||!recoveryAvailable||historyState!=="ready"||proposal.status==="expired"} onClick={()=>void accept()}>{proposal.acceptedProjectId?"Open accepted translation":`Confirm ${proposal.reservedCredits}-credit hold & translate`}</button>
      {proposal.status==="expired"&&<button type="button" className={`${button} ml-3 mt-3`} disabled={locked||!editable} onClick={()=>{setProposal(null);setConsent(false);setNotice("Choose a model and language above, then consent to request a fresh quote.");}}>Request a fresh quote</button>}
    </div>}
  </section>;
}
