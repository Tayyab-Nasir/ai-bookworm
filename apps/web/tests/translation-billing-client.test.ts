import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient } from "@bookworm/api-client";

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
