import { test } from "node:test";
import assert from "node:assert/strict";
import { summarizeTranslationBilling } from "./lib/translation-billing.js";

const user = "d8000000-0000-4000-8000-000000000001";
const workspace = "d8000000-0000-4000-8000-000000000002";
const ids = [3,4,5,6].map((n) => `d8000000-0000-4000-8000-00000000000${n}`);
const base = (index: number, status: string, settlement_json: unknown) => ({ job_id: ids[index], user_id: user,
  workspace_id: workspace, reserved_credits: 10, status, settlement_json });
test("translation billing projects held, settled, review and cancelled credits without private receipts", () => {
  const rows = [base(0,"held",null), base(1,"settled",{status:"settle",debitCredits:"6",releaseCredits:"4",requestId:"private"}),
    base(2,"requires_review",{status:"requires_review",heldCredits:"10",requestId:"private"}),
    base(3,"cancelled",{status:"cancelled",releaseCredits:"10"})];
  assert.deepEqual(summarizeTranslationBilling(rows,ids,user,workspace), {
    reservedCredits:"40",heldCredits:"20",chargedCredits:"6",returnedCredits:"14",reviewChapters:1,chapterCount:4,
  });
});
test("translation billing refuses missing, duplicate, foreign and inconsistent receipts", () => {
  const valid = base(0,"held",null);
  for (const rows of [[],[valid,valid],[{...valid,user_id:workspace}],[{...valid,workspace_id:user}],
    [base(0,"settled",{status:"settle",debitCredits:"9",releaseCredits:"2"})],
    [base(0,"requires_review",{status:"requires_review",heldCredits:"0"})],
    [base(0,"cancelled",{status:"cancelled",releaseCredits:"9"})],
    [base(0,"held",{})]]) assert.throws(() => summarizeTranslationBilling(rows,[ids[0]],user,workspace));
});
