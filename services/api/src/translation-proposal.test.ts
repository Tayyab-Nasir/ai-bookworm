import { test } from "node:test";
import assert from "node:assert/strict";
import { publicTranslationProposal } from "./lib/translation-proposal.js";
import { quoteUsage } from "./lib/usage-pricing.js";
const id=(n:number)=>`dc000000-0000-4000-8000-${String(n).padStart(12,"0")}`;
function fixture() {
  const quote=quoteUsage({scope:{jobId:id(1),userId:id(2),workspaceId:id(3),inputSha256:"a".repeat(64)},
    price:{version:"synthetic",provider:"openai",model:"test-2026-09-01",rates:[{dimension:"text_input",microUsdPerMillionTokens:"1000000"}]},
    policy:{version:"test",approved:true,microUsdPerCredit:"1000",markupBasisPoints:15000,platformMicroUsd:"0",minimumCredits:"1"},
    maximumTokens:[{dimension:"text_input",tokens:"1000"}],createdAt:"2026-09-19T12:00:00.000Z",expiresAt:"2026-09-19T12:10:00.000Z"});
  return {id:id(4),book_id:id(5),workspace_id:id(3),user_id:id(2),source_language:"en",target_language:"es",
    reserved_credits:Number(quote.reservedCredits),expires_at:quote.expiresAt,accepted_project_id:null as string|null,
    chapters_json:[{jobId:id(1),chapterId:id(6),documentVersionId:id(7),chapterOrder:0,quote}]};
}
test("proposal review exposes safe total and pinned chapter details, including expired and accepted recovery",()=>{
  const raw=fixture(); const result=publicTranslationProposal(raw,Date.parse("2026-09-19T12:01:00Z"));
  assert.equal(result.status,"ready");assert.equal(result.reservedCredits,2);
  assert.equal(result.chapters[0].documentVersionId,id(7));
  assert.equal(JSON.stringify(result).includes("microUsd"),false);assert.equal(JSON.stringify(result).includes("inputSha256"),false);
  assert.equal(publicTranslationProposal(raw,Date.parse("2026-09-19T12:11:00Z")).status,"expired");
  raw.accepted_project_id=id(4);
  assert.equal(publicTranslationProposal(raw,Date.parse("2026-09-19T12:11:00Z")).status,"accepted");
});
test("proposal review rejects changed quote prices, scope and mismatched total",()=>{
  const wrongTotal=fixture();wrongTotal.reserved_credits++;
  const wrongPrice=fixture();wrongPrice.chapters_json[0].quote.price.rates[0].microUsdPerMillionTokens="1";
  const wrongScope=fixture();wrongScope.user_id=id(8);
  for(const raw of [wrongTotal,wrongPrice,wrongScope]) assert.throws(()=>publicTranslationProposal(raw),/Could not verify/);
});
