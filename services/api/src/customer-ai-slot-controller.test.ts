import assert from "node:assert/strict";
import { test } from "node:test";
import { customerAiSlotController } from "./lib/customer-ai-slot-controller.js";
import type { SupabaseClient } from "./lib/supabase.js";

const job="10000000-0000-4000-8000-000000000001",other="10000000-0000-4000-8000-000000000002";
const attempt="20000000-0000-4000-8000-000000000001",otherAttempt="20000000-0000-4000-8000-000000000002";
const identity={attemptId:attempt,jobId:job,action:"recover_receipt" as const};
const row=(job_id=job,action="receipt_available",created_at="2026-10-28T13:00:00.123456+00:00")=>({job_id,action,created_at});
type Slots=Parameters<typeof customerAiSlotController>[1];
type Journal=Parameters<typeof customerAiSlotController>[2];

function fixture() {
 let slot=false,acknowledged=false,state:"pending"|"completed"|"needs_review"="pending";
 let loseOpen=false,loseExecute=false,loseAck=false;const calls:string[]=[];let fees=-2;
 const control={get slot(){return slot},get acknowledged(){return acknowledged},get state(){return state},get fees(){return fees},calls,
  loseOpen(){loseOpen=true},loseExecute(){loseExecute=true},loseAck(){loseAck=true}};
 const receipt=()=>({...identity,state,result:state==="completed"?"settled":null});
 const slots={
  async listSlots() {calls.push("list");const rows=slot&&!acknowledged?[{job_id:job,action:"recover_receipt",version:1,attempt_id:attempt,state,result:state==="completed"?"settled":null}]:[];
   return {status:"confirmed",value:{rows,nextCursor:null}};},
  async open() {calls.push("open");if(acknowledged)return {status:"confirmed",value:{status:"not_actionable"}};slot=true;
   if(loseOpen){loseOpen=false;return {status:"unknown"};}return {status:"confirmed",value:{status:"open",version:1,attempt:receipt()}};},
  async ack(value:typeof identity & {version:number}) {calls.push("ack");assert.deepEqual(value,{...identity,version:1});acknowledged=true;
   if(loseAck){loseAck=false;return {status:"unknown"};}return {status:"confirmed",value:{status:"observed",attemptId:attempt,version:1,result:"settled"}};},
 } as unknown as Slots;
 const journal={
  async read(value:typeof identity) {calls.push("read");assert.deepEqual(value,identity);return {status:"confirmed",receipt:receipt()};},
  async execute(value:typeof identity) {calls.push("execute");assert.deepEqual(value,identity);state="completed";
   if(loseExecute){loseExecute=false;return {status:"unknown"};}return {status:"confirmed",receipt:receipt()};},
 } as unknown as Journal;
 const sb={rpc(name:string) {assert.equal(name,"discover_customer_ai_reconciliation_candidates");calls.push("discover");
  return {abortSignal:async()=>({data:acknowledged?[]:[row()],error:null})};}} as unknown as SupabaseClient;
 return {control,slots,journal,sb};
}

test("lost open, execute and ack recover by DB slot identity after restart, without provider or refund",async()=>{
 const f=fixture();f.control.loseOpen();let c=customerAiSlotController(f.sb,f.slots,f.journal);
 let result=await c.tick();assert.deepEqual(result.events,[{jobId:job,status:"unconfirmed"}]);assert.equal(f.control.slot,true);await c.close();
 f.control.loseExecute();c=customerAiSlotController(f.sb,f.slots,f.journal);
 result=await c.tick();assert(result.events.some(e=>e.status==="unconfirmed"&&e.attemptId===attempt));assert.equal(f.control.state,"completed");await c.close();
 f.control.loseAck();c=customerAiSlotController(f.sb,f.slots,f.journal);
 result=await c.tick();assert(result.events.some(e=>e.status==="unconfirmed"&&e.attemptId===attempt));assert.equal(f.control.acknowledged,true);await c.close();
 c=customerAiSlotController(f.sb,f.slots,f.journal);result=await c.tick();assert.deepEqual(result.events,[]);await c.close();
 assert.equal(f.control.calls.filter(x=>x==="execute").length,1);assert.equal(f.control.calls.filter(x=>x==="ack").length,1);
 assert.equal(f.control.fees,-2);assert(!f.control.calls.some(x=>/dispatch|provider|refund|cancel/u.test(x)));
});

test("open review and investigate remain visible, never acknowledged",async()=>{
 for(const [state,resultValue] of [["needs_review",null],["completed","requires_review"]] as const){
 const review={job_id:job,action:"reconcile",version:1,attempt_id:attempt,state,result:resultValue};let acks=0,executions=0;
 const slots={async listSlots(){return {status:"confirmed",value:{rows:[review],nextCursor:null}};},
  async open(){throw new Error("must not open");},async ack(){acks++;throw new Error("must not ack");}} as unknown as Slots;
 const journal={async read(){return {status:"confirmed",receipt:{attemptId:attempt,jobId:job,action:"reconcile",state,result:resultValue}};},
  async execute(){executions++;throw new Error("must not execute");}} as unknown as Journal;
 const sb={rpc(){return {abortSignal:async()=>({data:[row(other,"investigate")],error:null})};}} as unknown as SupabaseClient;
 const c=customerAiSlotController(sb,slots,journal);const result=await c.tick();
 assert.deepEqual(result.events,[{jobId:job,attemptId:attempt,status:"review"},{jobId:other,status:"investigate"}]);assert.equal(acks,0);assert.equal(executions,0);await c.close();
 }
});

test("close drains an in-flight execute and prevents acknowledgement until restart",async()=>{
 const f=fixture();await f.slots.open({jobId:job,action:"recover_receipt"});
 let release!:()=>void,started!:()=>void;const began=new Promise<void>(done=>{started=done;});
 const slow={...f.journal,async execute(value:typeof identity){started();await new Promise<void>(done=>{release=done;});return f.journal.execute(value);}} as unknown as Journal;
 const c=customerAiSlotController(f.sb,f.slots,slow),pending=c.tick();await began;const closing=c.close();release();await pending;await closing;
 assert.equal(f.control.state,"completed");assert.equal(f.control.acknowledged,false);
 const resumed=customerAiSlotController(f.sb,f.slots,f.journal);await resumed.tick();assert.equal(f.control.acknowledged,true);await resumed.close();
});

test("invalid or lost slot discovery never advances to candidate actions",async()=>{
 let discoveries=0;const sb={rpc(){discoveries++;throw new Error("must not discover");}} as unknown as SupabaseClient;
 const slots={async listSlots(){return {status:"unknown"};},async open(){throw new Error();},async ack(){throw new Error();}} as unknown as Slots;
 const journal={async read(){throw new Error();},async execute(){throw new Error();}} as unknown as Journal;
 const c=customerAiSlotController(sb,slots,journal);await assert.rejects(c.tick(),/unavailable/u);assert.equal(discoveries,0);await c.close();
});

test("candidate pages reject duplicates, reordered timestamps and mismatched slot identity",async()=>{
 let response:unknown=[row(job),row(other,"none","2026-10-28T13:00:00.123455+00:00")];
 const sb={rpc(){return {abortSignal:async()=>({data:response,error:null})};}} as unknown as SupabaseClient;
 const slots={async listSlots(){return {status:"confirmed",value:{rows:[],nextCursor:null}};},
  async open(){return {status:"confirmed",value:{status:"open",version:1,attempt:{attemptId:otherAttempt,jobId:other,action:"recover_receipt",state:"pending",result:null}}};},async ack(){throw new Error();}} as unknown as Slots;
 const journal={async read(){throw new Error();},async execute(){throw new Error();}} as unknown as Journal;
 const c=customerAiSlotController(sb,slots,journal,{pageSize:2});
 await assert.rejects(c.tick(),/unavailable/u);
 response=[row(job)];await assert.rejects(c.tick(),/unavailable/u);await c.close();
});
