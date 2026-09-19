import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@bookworm/api-client";

test("translation quote client keeps preparation distinct from purchase confirmation",async()=>{
  const original=globalThis.fetch;const calls:{url:string;init?:RequestInit}[]=[];
  globalThis.fetch=async(url,init)=>{calls.push({url:String(url),init});return Response.json({});};
  try{
    const api=createClient({baseUrl:"/api/backend"});
    await api.listTranslationModels();
    await api.requestTranslationQuote("book",{targetLanguage:"es",modelId:"model",idempotencyKey:"stable-key",allowProviderTokenCounting:true});
    await api.getTranslationProposal("proposal");
    await api.acceptTranslationQuote("proposal",12);
    assert.equal(calls[0].url,"/api/backend/v1/translations/models");
    assert.equal(calls[1].url,"/api/backend/v1/books/book/translation-quotes");
    assert.deepEqual(JSON.parse(String(calls[1].init?.body)),{targetLanguage:"es",modelId:"model",idempotencyKey:"stable-key",allowProviderTokenCounting:true});
    assert.equal(calls[2].url,"/api/backend/v1/translation-quotes/proposal");
    assert.equal(calls[3].url,"/api/backend/v1/translation-quotes/proposal/accept");
    assert.deepEqual(JSON.parse(String(calls[3].init?.body)),{expectedCredits:12});
    assert.ok(calls.every((call)=>call.init?.credentials==="same-origin"));
  }finally{globalThis.fetch=original;}
});

test("translation billing reads private totals through same-origin authentication", async () => {
  const original = globalThis.fetch;
  const calls: { url: string; init?: RequestInit }[] = [];
  const summary = { reservedCredits: "9007199254740993", heldCredits: "9007199254740993",
    chargedCredits: "0", returnedCredits: "0", chapterCount: 1, reviewChapters: 1 };
  globalThis.fetch = async (url, init) => { calls.push({url:String(url),init}); return Response.json(summary); };
  try {
    const api = createClient({baseUrl:"/api/backend"});
    assert.deepEqual(await api.getTranslationBilling("project-1"),summary);
    assert.equal(calls[0].url,"/api/backend/v1/translations/project-1/billing");
    assert.equal(calls[0].init?.method,"GET");
    assert.equal(calls[0].init?.credentials,"same-origin");
    assert.equal(calls[0].init?.body,undefined);
  } finally { globalThis.fetch = original; }
});
