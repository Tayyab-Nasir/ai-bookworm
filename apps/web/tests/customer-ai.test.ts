import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { createClient } from "../../../packages/api-client/src/index.js";
import { parseCustomerAiOptions, parseCustomerAiReceipt, type CustomerAiPreparation, type CustomerAiSaved, type CustomerAiOption } from "../../../packages/api-client/src/customer-ai.js";
import { readCustomerAiPending, saveCustomerAiPending, clearCustomerAiPending } from "../lib/customer-ai-recovery.js";
const actor = randomUUID(), other = randomUUID(), book = randomUUID(), operationId = randomUUID();
const selection = { workspaceId: randomUUID(), bookId: book, connectionId: randomUUID(), credentialRevision: 1, provider: "openai" as const, agentType: "writer" as const };
const option: CustomerAiOption = { id: randomUUID(), provider: "openai", agentType: "writer", model: "synthetic-1", upstream: null, maxOutputTokens: 1024,
  platformFee: { mode: "platform_plan", credits: 0 }, providerCostStatus: "unknown", expiresAt: new Date(Date.now() + 3600000).toISOString() };
const source = { chapterId: randomUUID(), documentVersionId: randomUUID(), version: 1 };
const saved: CustomerAiSaved = { ...selection, operationId, jobId: null, policyId: option.id, model: option.model, upstream: null,
  maxOutputTokens: 1024, platformFee: option.platformFee, providerCostStatus: "unknown", sourceVersions: [source], contextOmitted: 0,
  chapterCount: 1, status: "prepared", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 900000).toISOString() };
const body: CustomerAiPreparation = { operationId, selection, policyId: option.id, source: { bookId: book, agentType: "writer", chapters: [source], userInstruction: "Synthetic direction",
  contextPolicy: { includeBookBible: false, includeStyleGuide: false, includeRelatedContext: false, semanticTopK: 5, maxTokens: 4096 } } };

test("customer client actor binding, exact source/policy/fee receipt and bounded no-random-id transport", async () => {
  const original = globalThis.fetch, calls: { url: string; init: RequestInit }[] = [];
  let result: unknown = { viewerId: actor, options: [option] };
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init! }); return Response.json(result); };
  try {
    const api = createClient({ baseUrl: "http://local.test" });
    assert.deepEqual(await api.listCustomerAiOptions(selection, actor), [option]);
    result = { viewerId: actor, receipt: saved };
    const r = await api.prepareCustomerAi(body, option, actor); assert.deepEqual(r, saved);
    result = { viewerId: actor, receipt: { ...saved, jobId: randomUUID(), status: "queued" } };
    assert.equal((await api.confirmCustomerAi(r, actor)).status, "queued");
    assert.deepEqual(JSON.parse(String(calls.at(-1)!.init.body)), { operationId, expectedPlatformFeeCredits: 0, consent: true });
    assert.equal((await api.getCustomerAiStatus(book, operationId, actor)).status, "queued");
    result = { viewerId: actor, receipt: { ...saved, status: "succeeded", jobId: randomUUID() } };
    assert.equal((await api.recoverCustomerAi(book, operationId, actor)).status, "succeeded");
    result = { viewerId: actor, receipt: { operationId, bookId: book, status: "closed_before_prepare" } };
    assert.equal((await api.closeCustomerAi(book, operationId, actor)).status, "closed_before_prepare");
    for (const c of calls) {
      assert.equal(new Headers(c.init.headers).get("x-bookworm-actor"), actor);
      assert(!new Headers(c.init.headers).has("idempotency-key")); assert(c.init.signal); assert.equal(c.init.credentials, "same-origin");
    }
    for (const delta of [{ sourceVersions: [{ ...source, documentVersionId: other }] }, { model: "different" }, { upstream: "unapproved" }, { policyId: other },
      { platformFee: { mode: "per_request_credits", credits: 3 } }]) {
      result = { viewerId: actor, receipt: { ...saved, ...delta } }; await assert.rejects(api.prepareCustomerAi(body, option, actor));
      result = { viewerId: actor, receipt: { ...saved, ...delta, status: "queued", jobId: randomUUID() } }; await assert.rejects(api.confirmCustomerAi(r, actor));
    }
    result = { viewerId: actor, receipt: { operationId, status: "not_found" } }; await assert.rejects(api.closeCustomerAi(book, operationId, actor));
  } finally { globalThis.fetch = original; }
});

test("customer receipt strict parsing rejects private fields, mismatched actors/books and inconsistent source/lifecycle metadata", () => {
  for (const delta of [{ apiKey: "forbidden" }, { request: "private source" }, { bookId: other }, { operationId: other }, { workspaceId: "bad" },
    { sourceVersions: [{ ...source, text: "forbidden" }] }, { sourceVersions: [source, source], chapterCount: 2 }, { chapterCount: 2 },
    { jobId: randomUUID() }, { status: "succeeded" }, { providerCostStatus: "free" }, { model: "https://bad?key=value" },
    { platformFee: { mode: "platform_plan", credits: 2 } }, { expiresAt: "2000-01-01T00:00:00Z" }])
    assert.throws(() => parseCustomerAiReceipt({ viewerId: actor, receipt: { ...saved, ...delta } }, actor, book, operationId));
  assert.throws(() => parseCustomerAiReceipt({ viewerId: other, receipt: saved }, actor, book, operationId));
  assert.throws(() => parseCustomerAiReceipt({ viewerId: actor, receipt: { operationId, bookId: other, status: "closed_before_prepare" } }, actor, book, operationId));
  for (const options of [[option, option], [{ ...option, provider: "xai" }], [{ ...option, expiresAt: "2000-01-01T00:00:00Z" }], [{ ...option, key: "hidden" }]])
    assert.throws(() => parseCustomerAiOptions({ viewerId: actor, options }, actor, selection));
});

test("paid-plan client refuses credit-fee creation but keeps historical recovery readable", async () => {
  const original = globalThis.fetch; let requests = 0;
  const historical: CustomerAiSaved = { ...saved, platformFee: { mode: "per_request_credits", credits: 2 } };
  globalThis.fetch = async () => { requests++; return Response.json({ viewerId: actor, receipt: historical }); };
  try {
    assert.throws(() => parseCustomerAiOptions({ viewerId: actor, options: [{ ...option, platformFee: historical.platformFee }] }, actor, selection));
    const api = createClient({ baseUrl: "http://local.test" });
    await assert.rejects(api.confirmCustomerAi(historical, actor));
    assert.equal(requests, 0, "Old credit-fee receipts cannot authorize new confirmation");
    const recovered = await api.getCustomerAiStatus(book, operationId, actor);
    assert("platformFee" in recovered); assert.deepEqual(recovered.platformFee, historical.platformFee);
  } finally { globalThis.fetch = original; }
});

test("customer recovery stores only an opaque owner/book operation, refuses replacement and unknown outcome clearing", () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage"), store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string): void => { store.set(k, v); }, removeItem: (k: string) => store.delete(k) };
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  try {
    saveCustomerAiPending(actor, book, operationId); assert.deepEqual([...store.values()], [operationId]);
    assert.equal(readCustomerAiPending(other, book), null); assert.equal(readCustomerAiPending(actor, other), null);
    assert.throws(() => saveCustomerAiPending(actor, book, other));
    for (const status of ["not_found", "prepared", "expired", "queued", "running", "requires_review"] as const)
      assert.throws(() => clearCustomerAiPending(actor, book, { ...saved, status }));
    clearCustomerAiPending(actor, book, { operationId, bookId: book, status: "closed_before_prepare" }); assert.equal(store.size, 0);
    storage.setItem = () => { throw new Error("blocked"); }; assert.throws(() => saveCustomerAiPending(actor, book, operationId));
    storage.setItem = () => undefined; assert.throws(() => saveCustomerAiPending(actor, book, operationId));
    store.set(`bookworm:customer-ai:${actor}:${book}`, '{"apiKey":"never-accept"}'); assert.throws(() => readCustomerAiPending(actor, book));
  } finally { if (original) Object.defineProperty(globalThis, "sessionStorage", original); else Reflect.deleteProperty(globalThis, "sessionStorage"); }
});
