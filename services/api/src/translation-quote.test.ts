import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareTranslationQuote, openAiTranslationTokenCounter } from "./lib/translation-quote.js";
import { translationProviderRequest, translationRequestHash } from "./lib/translation-generation.js";

const now="2026-09-19T12:00:00.000Z";
const config=JSON.stringify({version:"test-1",approved:true,approvalReference:"synthetic-test-only",
  effectiveAt:"2026-09-19T00:00:00.000Z",expiresAt:"2026-09-20T00:00:00.000Z",quoteLifetimeSeconds:600,
  entries:[{id:"test",label:"Test",maxInputTokens:1000,maxOutputTokens:2000,
    price:{version:"p1",provider:"openai",model:"test-model-2026-09-01",rates:[
      {dimension:"text_input",microUsdPerMillionTokens:"1000000"},{dimension:"text_cached_input",microUsdPerMillionTokens:"100000"},
      {dimension:"text_output",microUsdPerMillionTokens:"2000000"}]},
    policy:{version:"r1",approved:true,microUsdPerCredit:"1000",markupBasisPoints:15000,platformMicroUsd:"100",minimumCredits:"1"}}]});
const input={modelId:"test",text:"A story.\nاردو — 日本語 📚",sourceLanguage:"en",targetLanguage:"es",
  scope:{jobId:"da000000-0000-4000-8000-000000000001",userId:"da000000-0000-4000-8000-000000000002",workspaceId:"da000000-0000-4000-8000-000000000003"}};
test("SDK counter uses only input_tokens endpoint and does not retry provider errors",async () => {
  const originalFetch=globalThis.fetch, originalKey=process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY="synthetic-test-key";
  let calls=0;
  const request={model:"test-model-2026-09-01",input:[{role:"user" as const,content:"test"}]};
  globalThis.fetch=async (url,init)=>{
    calls++; assert.equal(String(url),"https://api.openai.com/v1/responses/input_tokens");
    assert.equal(init?.method,"POST"); assert.deepEqual(JSON.parse(String(init?.body)),request);
    return Response.json({error:{message:"private provider detail"}},{status:429});
  };
  try {
    await assert.rejects(openAiTranslationTokenCounter(request),/Could not verify/);
    assert.equal(calls,1);
    delete process.env.OPENAI_API_KEY;
    await assert.rejects(openAiTranslationTokenCounter(request),/Could not verify/);
    assert.equal(calls,1);
  } finally {
    globalThis.fetch=originalFetch;
    if (originalKey===undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY=originalKey;
  }
});
test("translation quote counts exact provider messages and binds the generation hash",async () => {
  let calls=0;
  const generation={text:input.text,sourceLanguage:"en",targetLanguage:"es",model:"test-model-2026-09-01",maxOutputTokens:2000};
  const expected=translationProviderRequest(generation);
  const result=await prepareTranslationQuote(config,input,{clock:()=>now,counter:async (request)=>{
    calls++; assert.deepEqual(request,{model:expected.model,input:expected.input});
    assert.equal("max_output_tokens" in request,false);
    return {object:"response.input_tokens",input_tokens:1000};
  }});
  assert.equal(calls,1); assert.equal(result.quote.scope.inputSha256,translationRequestHash(generation));
  assert.equal(result.quote.reservedCredits,"8"); assert.equal(result.countedInputTokens,1000);
  assert.equal(result.maxOutputTokens,2000);
});
test("bad counts and provider failures never become a cheap fallback quote",async () => {
  for (const value of [null,{}, {object:"wrong",input_tokens:1}, ...[0,-1,1.5,NaN,Infinity,1001,"10"].map((input_tokens)=>({object:"response.input_tokens",input_tokens}))]) {
    await assert.rejects(prepareTranslationQuote(config,input,{clock:()=>now,counter:async()=>value}));
  }
  let calls=0;
  await assert.rejects(prepareTranslationQuote(config,input,{clock:()=>now,counter:async()=>{calls++;throw new Error("private provider detail");}}),/Could not verify/);
  assert.equal(calls,1);
});
test("invalid input/config prevents counting and catalog expiry during count prevents quoting",async () => {
  let calls=0; const counter=async()=>{calls++;return {object:"response.input_tokens",input_tokens:1};};
  for (const bad of [{...input,text:" "},{...input,text:"a".repeat(32001)},{...input,targetLanguage:"en"},{...input,modelId:"unlisted"}]) {
    await assert.rejects(prepareTranslationQuote(config,bad,{clock:()=>now,counter}));
  }
  await assert.rejects(prepareTranslationQuote(undefined,input,{clock:()=>now,counter}));
  assert.equal(calls,0);
  let ticks=0;
  await assert.rejects(prepareTranslationQuote(config,input,{counter,clock:()=>ticks++ === 0 ? now : "2026-09-20T00:00:00.000Z"}));
  assert.equal(calls,1);
});
