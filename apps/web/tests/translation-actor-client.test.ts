import assert from "node:assert/strict";import {test} from "node:test";
import {createClient} from "../../../packages/api-client/src/index";
test("every translation operation carries the original actor, and lost preparation is checked with GET",async()=>{
 const prior=globalThis.fetch, calls:{url:string;method:string;actor:string|null;body:unknown}[]=[];
 globalThis.fetch=async(url,init)=>{calls.push({url:String(url),method:init?.method??"GET",actor:new Headers(init?.headers).get("x-bookworm-actor"),body:typeof init?.body==="string"?JSON.parse(init.body):null});return Response.json({});};
 try{const api=createClient({baseUrl:"/api/backend"}),actor="11111111-1111-4111-8111-111111111111",book="22222222-2222-4222-8222-222222222222",key="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",id="33333333-3333-4333-8333-333333333333";
 await api.listTranslationProjects(book,actor);await api.getTranslationProject(id,true,actor);await api.getTranslationBilling(id,actor);await api.adoptTranslationProject(id,{title:"Synthetic"},actor);await api.cancelQuotedTranslation(id,actor);await api.listTranslationModels(actor);await api.listTranslationQuoteRequests(book,actor);await api.getTranslationQuoteRequest(id,actor);await api.getTranslationProposal(id,actor);await api.requestTranslationQuote(book,{targetLanguage:"es",modelId:"test",idempotencyKey:key,allowProviderTokenCounting:true},actor);await api.acceptTranslationQuote(id,23,actor);await api.findTranslationQuoteRequest(book,key,actor);
 assert.equal(calls.length,12);assert(calls.every(call=>call.actor===actor));assert.equal(calls.at(-1)?.method,"GET");assert.equal(calls.at(-1)?.url,`/api/backend/v1/books/${book}/translation-quote-requests/${key}`);assert.equal(calls.at(-1)?.body,null);
 }finally{globalThis.fetch=prior;}
});
test("existing unbound translation client calls remain compatible",async()=>{
 const prior=globalThis.fetch,actors:(string|null)[]=[];globalThis.fetch=async(_url,init)=>{actors.push(new Headers(init?.headers).get("x-bookworm-actor"));return Response.json({});};
 try { const api=createClient({baseUrl:"/api/backend"});await api.listTranslationModels();await api.requestTranslationQuote("book",{targetLanguage:"es",modelId:"test",idempotencyKey:"legacy-key",allowProviderTokenCounting:true});await api.getTranslationProposal("quote");await api.acceptTranslationQuote("quote",23);await api.getTranslationBilling("project");assert.deepEqual(actors,[null,null,null,null,null]); } finally { globalThis.fetch=prior; }
});
