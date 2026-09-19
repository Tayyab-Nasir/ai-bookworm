import { test } from "node:test";
import assert from "node:assert/strict";
import { availableTranslationModels, quoteCatalogTranslation, readTranslationCatalog } from "./lib/translation-catalog.js";

const now = "2026-09-19T12:00:00.000Z";
const config = () => ({ version:"test-catalog-1",approved:true,approvalReference:"test-only-not-a-commercial-offer",
  effectiveAt:"2026-09-19T00:00:00.000Z",expiresAt:"2026-09-20T00:00:00.000Z",quoteLifetimeSeconds:600,
  entries:[{id:"test-text",label:"Synthetic test model",maxInputTokens:1000,maxOutputTokens:2000,
    price:{version:"test-price-1",provider:"openai",model:"test-model-2026-09-01",rates:[
      {dimension:"text_input",microUsdPerMillionTokens:"1000000"},
      {dimension:"text_cached_input",microUsdPerMillionTokens:"100000"},
      {dimension:"text_output",microUsdPerMillionTokens:"2000000"}]},
    policy:{version:"test-policy-1",approved:true,microUsdPerCredit:"1000",markupBasisPoints:15000,platformMicroUsd:"100",minimumCredits:"1"}}] });
const scope = {jobId:"d9000000-0000-4000-8000-000000000001",userId:"d9000000-0000-4000-8000-000000000002",
  workspaceId:"d9000000-0000-4000-8000-000000000003",inputSha256:"a".repeat(64)};

test("catalog uses approved snapshots and emits only safe model choices", () => {
  const catalog=readTranslationCatalog(JSON.stringify(config()),now);
  assert.deepEqual(availableTranslationModels(catalog),{catalogVersion:"test-catalog-1",models:[{
    id:"test-text",label:"Synthetic test model",model:"test-model-2026-09-01",priceVersion:"test-price-1",policyVersion:"test-policy-1"}]});
  const {quote}=quoteCatalogTranslation(JSON.stringify(config()),{modelId:"test-text",scope,maximumInputTokens:1000,now});
  assert.equal(quote.reservedCredits,"8"); assert.equal(quote.expiresAt,"2026-09-19T12:10:00.000Z");
  assert.deepEqual(quote.scope,scope);
});
test("catalog refuses absent, expired, unapproved, alias, free and ambiguous configuration", () => {
  for (const raw of [undefined,"{",JSON.stringify({...config(),approved:false}),JSON.stringify({...config(),approvalReference:""}),
    JSON.stringify({...config(),expiresAt:now}),JSON.stringify({...config(),effectiveAt:"2027-01-01T00:00:00.000Z"})]) {
    assert.throws(() => readTranslationCatalog(raw,now),/not configured/);
  }
  for (const mutate of [
    (c:ReturnType<typeof config>) => { c.entries[0].price.model="gpt-latest"; },
    (c:ReturnType<typeof config>) => { c.entries[0].price.rates.pop(); },
    (c:ReturnType<typeof config>) => { c.entries[0].price.rates[0].microUsdPerMillionTokens="0"; },
    (c:ReturnType<typeof config>) => { c.entries.push(structuredClone(c.entries[0])); },
    (c:ReturnType<typeof config>) => { const second=structuredClone(c.entries[0]); second.id="other"; second.price.rates[0].microUsdPerMillionTokens="2"; c.entries.push(second); },
  ]) { const c=config(); mutate(c); assert.throws(() => readTranslationCatalog(JSON.stringify(c),now),/not configured/); }
});
test("catalog quotes enforce input limits and clip validity to catalog expiry", () => {
  const c=config(); c.expiresAt="2026-09-19T12:00:30.000Z";
  const raw=JSON.stringify(c);
  assert.equal(quoteCatalogTranslation(raw,{modelId:"test-text",scope,maximumInputTokens:1,now}).quote.expiresAt,c.expiresAt);
  for (const count of [0,-1,1001,1.5,NaN]) assert.throws(() => quoteCatalogTranslation(raw,{modelId:"test-text",scope,maximumInputTokens:count,now}));
  assert.throws(() => quoteCatalogTranslation(raw,{modelId:"unlisted",scope,maximumInputTokens:1,now}));
});
