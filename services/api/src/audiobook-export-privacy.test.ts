import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { audiobookRoutes } from "./routes/audiobooks.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";

const JOB="b6000000-0000-4000-8000-000000000011", WORKSPACE="b6000000-0000-4000-8000-000000000002", BOOK="b6000000-0000-4000-8000-000000000008", EDITION="b6000000-0000-4000-8000-000000000009", USER="b6000000-0000-4000-8000-000000000003", LEASE="b6000000-0000-4000-8000-000000000012";
const safeRow = () => ({ id:JOB, workspace_id:WORKSPACE, book_id:BOOK, edition_id:EDITION,status:"succeeded", progress_chapters:1,progress_total:1,error_code:null,created_at:"2026-10-28T00:00:00Z",completed_at:"2026-10-28T00:01:00Z",output_size_bytes:100,total_duration_seconds:300 });
function setup() {
 const state={ visible:true,revokeAfterSign:false, wrongScope:false,badPath:false,serviceCalls:0,checks:0,signed:[] as Array<{path:string; name:unknown}>,selected:[] as Array<{side:string;columns:string}>,status:"succeeded" };
 const full = () => ({...safeRow(),status:state.status,workspace_id:state.wrongScope?USER:WORKSPACE, output_storage_path:state.badPath?`workspaces/${USER}/other.zip`:`workspaces/${WORKSPACE}/audiobook-exports/${JOB}/${LEASE}.zip`,identifier:"PRIVATE-ISBN",idempotency_key:"PRIVATE-KEY",lease_token:"PRIVATE-LEASE",snapshot_json:{title:"PRIVATE-TITLE"}});
 const client=(side:"caller"|"service")=>({
  from:(table:string)=>{assert.equal(table,"audiobook_google_play_export_jobs");const filters:Array<(r:Record<string,any>)=>boolean>=[]; let columns="";
   const rows=()=>{if(side==="caller"&&!state.visible)return [];return [side==="caller"?{...safeRow(),status:state.status}:full()].filter(row=>filters.every(f=>f(row)));};
   const query:any={select:(value:string)=>{columns=value;state.selected.push({side,columns});return query;},eq:(key:string,value:unknown)=>{filters.push(r=>r[key]===value);return query;},in:(key:string,values:unknown[])=>{if(side==="caller") state.checks++;filters.push(r=>values.includes(r[key]));return query;},order:()=>query,limit:()=>query,maybeSingle:async()=>({data:rows()[0]??null,error:null}),then:(resolve:(value:unknown)=>void)=>resolve({data:rows(),error:null})};return query;},
  storage:{from:()=>({createSignedUrl:async(path:string,_seconds:number,opts:{download:unknown})=>{state.signed.push({path,name:opts.download});if(state.revokeAfterSign)state.visible=false;return {data:{signedUrl:"https://signed.example/opaque"},error:null};}})},
 });
 const app=Fastify();app.decorate("supabaseFactory",(token?:string)=>{if(!token)state.serviceCalls++;return client(token?"caller":"service") as never;});app.addHook("onRequest",async(req)=>{req.userId=USER;req.userToken="fixture";});app.register(errorHandlerPlugin);audiobookRoutes(app);
 return {app,state};
}

test("authorized viewer gets signed archive without sensitive job columns",async()=>{const {app,state}=setup();try{for(const url of [`/editions/${EDITION}/audiobook-google-play-exports`,`/audiobook-google-play-exports/${JOB}`]){const r=await app.inject({method:"GET",url});assert.equal(r.statusCode,200,r.body);assert.match(r.body,/https:\/\/signed\.example\/opaque/);assert.doesNotMatch(r.body,/PRIVATE-|workspaces\//);assert.equal(r.headers["cache-control"],"private, no-store");}assert.equal(state.serviceCalls,2);assert.equal(state.signed.length,2);assert.ok(state.signed.every(x=>x.name==="PRIVATE-ISBN.zip"));assert.equal(state.checks,4);assert.ok(state.selected.filter(x=>x.side==="caller").every(x=>!x.columns.includes("*")&&!/identifier|idempotency_key|lease_token|snapshot_json|output_storage_path/.test(x.columns)));}finally{await app.close()}});

test("invisible foreign job never obtains a service signing client",async()=>{const {app,state}=setup();state.visible=false;try{const r=await app.inject({method:"GET",url:`/audiobook-google-play-exports/${JOB}`});assert.equal(r.statusCode,404,r.body);assert.equal(state.serviceCalls,0);assert.equal(state.signed.length,0);}finally{await app.close()}});

test("membership withdrawn during signing suppresses the signed URL response",async()=>{const {app,state}=setup();state.revokeAfterSign=true;try{const r=await app.inject({method:"GET",url:`/audiobook-google-play-exports/${JOB}`});assert.equal(r.statusCode,503,r.body);assert.doesNotMatch(r.body,/signed\.example|PRIVATE-/);assert.equal(state.signed.length,1);assert.equal(state.checks,2);}finally{await app.close()}});

for(const change of ["wrongScope","badPath"] as const)test(`untrusted ${change} fails before signing`,async()=>{const {app,state}=setup();state[change]=true;try{const r=await app.inject({method:"GET",url:`/audiobook-google-play-exports/${JOB}`});assert.equal(r.statusCode,503,r.body);assert.equal(state.signed.length,0);assert.doesNotMatch(r.body,/PRIVATE-|workspaces\//);}finally{await app.close()}});

test("pending job returns without privileged service access",async()=>{const {app,state}=setup();state.status="running";try{const r=await app.inject({method:"GET",url:`/audiobook-google-play-exports/${JOB}`});assert.equal(r.statusCode,200,r.body);assert.equal(r.json().job.downloadUrl,null);assert.equal(state.serviceCalls,0);}finally{await app.close()}});
