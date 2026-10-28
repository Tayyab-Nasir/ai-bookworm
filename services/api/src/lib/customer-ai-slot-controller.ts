/** Explicitly invoked service-only controller. No provider, timer, launcher,
 * external sink or client-side attempt-id persistence is installed here.
 * Cursors wrap in memory; operator review/investigation events and cursor
 * progress are not durable, although slot intents/outcomes/observations are.
 */
import { z } from "zod";
import type { SupabaseClient } from "./supabase.js";
import type { customerAiMaintenanceSlots } from "./customer-ai-maintenance-slots.js";
import type { customerAiMaintenanceJournal, CustomerAiMaintenanceIdentity } from "./customer-ai-maintenance-journal.js";

const id = z.string().uuid().regex(/^[0-9a-f-]+$/u);
const timestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/u);
const candidate = z.object({ job_id: id, created_at: timestamp, action: z.enum(["none", "investigate", "review", "reconcile", "receipt_available"]) }).strict();
type Slots = Pick<ReturnType<typeof customerAiMaintenanceSlots>, "open" | "ack" | "listSlots">;
type Journal = Pick<ReturnType<typeof customerAiMaintenanceJournal>, "read" | "execute">;
type SlotCursor = { jobId: string; action: "reconcile" | "recover_receipt" };
type CandidateCursor = { createdAt: string; jobId: string };
type Event = { jobId: string; attemptId?: string; status: "investigate" | "review" | "unconfirmed" | "unchanged" | "settled" | "released" };
type Summary = { slotsScanned: number; candidatesScanned: number; events: Event[]; slotsCycleComplete: boolean; candidatesCycleComplete: boolean };

function timeKey(value: string): bigint {
  const day=value.slice(0,10), midnight=Date.parse(day+"T00:00:00Z");
  if(!Number.isFinite(midnight)||new Date(midnight).toISOString().slice(0,10)!==day) throw new Error();
  const suffix=value.match(/([+-]\d{2})(?::?(\d{2}))?$/u);
  const normalized=suffix?value.slice(0,-suffix[0].length)+suffix[1]+":"+(suffix[2]??"00"):value;
  const ms=Date.parse(normalized);if(!Number.isFinite(ms))throw new Error();
  return BigInt(ms)*1_000n+BigInt((value.match(/\.(\d{1,6})/u)?.[1]??"").padEnd(6,"0").slice(3));
}
function later(a: CandidateCursor,b: CandidateCursor) {
 const left=timeKey(a.createdAt),right=timeKey(b.createdAt);
 return right>left || (right===left && b.jobId>a.jobId);
}

// The injected Supabase client must be service-role scoped, bounded and have
// SDK retries disabled. The caller owns all clients and their lifecycle.
export function customerAiSlotController(sb: SupabaseClient, slots: Slots, journal: Journal, options: { pageSize?: number } = {}) {
 const pageSize=options.pageSize??20;
 if(!Number.isInteger(pageSize)||pageSize<1||pageSize>100||!slots||!journal
  ||typeof slots.open!=="function"||typeof slots.ack!=="function"||typeof slots.listSlots!=="function"
  ||typeof journal.read!=="function"||typeof journal.execute!=="function") throw new Error("Customer AI maintenance controller configuration is invalid.");
 let slotCursor: SlotCursor|undefined,candidateCursor: CandidateCursor|undefined,active: Promise<Summary>|undefined,closed=false;
 return {
  async tick(signal?: AbortSignal): Promise<Summary> {
   if(closed)throw new Error("Customer AI maintenance controller is closed.");
   if(active)throw new Error("Customer AI maintenance controller is already running.");
   if(signal!==undefined&&!(signal instanceof AbortSignal))throw new Error("Customer AI maintenance controller is unavailable.");
   const perform=async():Promise<Summary>=>{
    const output:Summary={slotsScanned:0,candidatesScanned:0,events:[],slotsCycleComplete:false,candidatesCycleComplete:false};
    const seen=new Set<string>();
    const stopped=()=>closed||signal?.aborted===true;
    const process=async(identity:CustomerAiMaintenanceIdentity,version:number)=>{
     if(stopped()||seen.has(identity.attemptId))return;
     seen.add(identity.attemptId);
     const read=await journal.read(identity,signal);
     if(read.status!=="confirmed") {output.events.push({jobId:identity.jobId,attemptId:identity.attemptId,status:"unconfirmed"});return;}
     if(stopped())return;
     let entry=read.receipt;
     if(entry.attemptId!==identity.attemptId||entry.jobId!==identity.jobId||entry.action!==identity.action) {
      output.events.push({jobId:identity.jobId,attemptId:identity.attemptId,status:"unconfirmed"});return;
     }
     if(entry.state==="pending") {
      const execute=await journal.execute(identity,signal);
      if(execute.status!=="confirmed") {output.events.push({jobId:identity.jobId,attemptId:identity.attemptId,status:"unconfirmed"});return;}
      entry=execute.receipt;
      if(entry.attemptId!==identity.attemptId||entry.jobId!==identity.jobId||entry.action!==identity.action) {
       output.events.push({jobId:identity.jobId,attemptId:identity.attemptId,status:"unconfirmed"});return;
      }
     }
     if(entry.state==="needs_review"||(entry.state==="completed"&&entry.result==="requires_review")) {
      output.events.push({jobId:identity.jobId,attemptId:identity.attemptId,status:"review"});return;
     }
     if(entry.state!=="completed"||!entry.result||stopped())return;
     const acknowledged=await slots.ack({...identity,version},signal);
     if(acknowledged.status!=="confirmed"||acknowledged.value.attemptId!==identity.attemptId
      ||acknowledged.value.version!==version||acknowledged.value.result!==entry.result) {
      output.events.push({jobId:identity.jobId,attemptId:identity.attemptId,status:"unconfirmed"});return;
     }
     output.events.push({jobId:identity.jobId,attemptId:identity.attemptId,status:entry.result});
    };
    if(stopped())return output;
    const page=await slots.listSlots({limit:pageSize,...(slotCursor?{cursor:slotCursor}:{})},signal);
    if(page.status!=="confirmed")throw new Error();
    for(const row of page.value.rows) {
     if(stopped())return output;
     await process({attemptId:row.attempt_id,jobId:row.job_id,action:row.action},row.version);
     slotCursor={jobId:row.job_id,action:row.action};output.slotsScanned++;
    }
    output.slotsCycleComplete=page.value.nextCursor===null;
    if(output.slotsCycleComplete)slotCursor=undefined;
    if(stopped())return output;
    const deadline=AbortSignal.any([AbortSignal.timeout(15_000),...(signal?[signal]:[])]);
    let abort:(()=>void)|undefined;
    try {
     const interrupted=new Promise<never>((_,reject)=>{abort=()=>reject(new Error());deadline.addEventListener("abort",abort,{once:true});if(deadline.aborted)abort();});
     const response=await Promise.race([sb.rpc("discover_customer_ai_reconciliation_candidates",{
      p_limit:pageSize,p_after_created_at:candidateCursor?.createdAt??null,p_after_job_id:candidateCursor?.jobId??null,
     }).abortSignal(deadline),interrupted]);
     if(deadline.aborted||response.error)throw new Error();
     const rows=z.array(candidate).max(pageSize).parse(response.data);
     if(new Set(rows.map(row=>row.job_id)).size!==rows.length)throw new Error();
     let previous=candidateCursor;
     for(const row of rows) {const current={createdAt:row.created_at,jobId:row.job_id};timeKey(current.createdAt);
      if(previous&&!later(previous,current))throw new Error();previous=current;}
     for(const row of rows) {
      if(stopped())return output;
      if(row.action==="review"||row.action==="investigate")output.events.push({jobId:row.job_id,status:row.action});
      else if(row.action==="reconcile"||row.action==="receipt_available") {
       const action=row.action==="reconcile"?"reconcile":"recover_receipt";
       const opened=await slots.open({jobId:row.job_id,action},signal);
       if(opened.status!=="confirmed")output.events.push({jobId:row.job_id,status:"unconfirmed"});
       else if(opened.value.status==="open") {
        const {attemptId,jobId,action}=opened.value.attempt;
        if(jobId!==row.job_id||action!==(row.action==="reconcile"?"reconcile":"recover_receipt"))throw new Error();
        await process({attemptId,jobId,action},opened.value.version);
       }
      }
      candidateCursor={createdAt:row.created_at,jobId:row.job_id};output.candidatesScanned++;
     }
     output.candidatesCycleComplete=rows.length<pageSize;
     if(output.candidatesCycleComplete)candidateCursor=undefined;
     return output;
    } finally {if(abort)deadline.removeEventListener("abort",abort);}
   };
   const operation=perform();active=operation;
   try{return await operation;}catch{throw new Error("Customer AI maintenance controller is unavailable.");}
   finally{if(active===operation)active=undefined;}
  },
  async close():Promise<void> {closed=true;try{await active;}catch{/* tick caller observes its result */}},
 };
}
