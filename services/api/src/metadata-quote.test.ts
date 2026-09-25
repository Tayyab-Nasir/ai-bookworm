import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { availableMetadataModels, prepareMetadataQuote } from "./lib/metadata-quote.js";
import { reconcileUsage } from "./lib/usage-pricing.js";

const now = "2026-09-24T10:00:00.000Z";
const ids = Array.from({ length: 6 }, (_, index) => `a9000000-0000-4000-8000-00000000000${index}`);
const scope = { jobId: ids[0], workspaceId: ids[1], userId: ids[2], bookId: ids[3] };
const text = "A mapmaker enters the winter city with her silver compass.";
const hash = createHash("sha256").update(text).digest("hex");
const context = () => ({
  chapterIds: [ids[4]], chapters: { [ids[4]]: { id: ids[4], documentVersionId: ids[5], version: 1,
    title: "The compass", order: 0, nodes: [{ id: "n1", text, textHash: hash, truncated: false }] } },
  book: { title: "Winter city", subtitle: null, author: "Test author", language: "en" },
  styleGuide: { tone: "warm" }, bookBible: [], relatedContext: [],
  userInstruction: "Create a grounded metadata candidate for author review.",
});
const catalog = () => ({
  version: "synthetic-metadata-catalog", approved: true, approvalReference: "synthetic-test-only",
  effectiveAt: "2026-09-24T00:00:00.000Z", expiresAt: "2026-09-25T00:00:00.000Z", quoteLifetimeSeconds: 600,
  entries: [{ id: "metadata", label: "Synthetic model", maxInputTokens: 1000, maxOutputTokens: 2000,
    price: { version: "synthetic-price", provider: "openai", model: "synthetic-model-2026-09-01", rates: [
      { dimension: "text_input", microUsdPerMillionTokens: "1000000" },
      { dimension: "text_cached_input", microUsdPerMillionTokens: "100000" },
      { dimension: "text_output", microUsdPerMillionTokens: "2000000" },
    ] },
    policy: { version: "synthetic-policy", approved: true, microUsdPerCredit: "1000",
      markupBasisPoints: 15000, platformMicroUsd: "100", minimumCredits: "1" },
  }],
});
const input = () => ({ rawCatalog: JSON.stringify(catalog()), modelId: "metadata", scope,
  context: context(), maxTokens: 12000, allowProviderTokenCounting: true });
const counted = () => ({ inputTokens: 321, inputSha256: "a".repeat(64), model: "synthetic-model-2026-09-01",
  agentType: "metadata", maxOutputTokens: 2000 });

function configure(t: TestContext) {
  const original = process.env.AI_SERVICE_TOKEN;
  process.env.AI_SERVICE_TOKEN = "synthetic-internal-token";
  t.after(() => {
    if (original === undefined) delete process.env.AI_SERVICE_TOKEN;
    else process.env.AI_SERVICE_TOKEN = original;
  });
}

test("metadata quote pins saved context, exact provider identity and approved credit math", async (t) => {
  configure(t);
  const sent: { path: string; body: unknown }[] = [];
  const prepared = await prepareMetadataQuote(input(), {
    clock: () => now,
    fetcher: async (url, init) => {
      sent.push({ path: String(url), body: JSON.parse(String(init?.body)) });
      assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("x-service-token"), "synthetic-internal-token");
      return Response.json(counted());
    },
  });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].path.endsWith("/v1/ai/text/quote"));
  assert.deepEqual(sent[0].body, prepared.generationRequest);
  assert.deepEqual(prepared.generationRequest.input, context());
  assert.equal(prepared.generationRequest.maxOutputTokens, 2000);
  assert.equal(prepared.quote.scope.inputSha256, counted().inputSha256);
  assert.equal(prepared.quote.expiresAt, "2026-09-24T10:10:00.000Z");
  assert.equal(prepared.quote.reservedCredits, "7");
  const settled = reconcileUsage(prepared.quote, {
    scope: prepared.quote.scope, provider: "openai", model: counted().model, requestId: "req-synthetic",
    measurement: "measured", tokens: [{ dimension: "text_input", tokens: "221" },
      { dimension: "text_cached_input", tokens: "100" }, { dimension: "text_output", tokens: "100" }],
  });
  assert.equal(settled.status, "settle");
  if (settled.status === "settle") {
    assert.equal(settled.debitCredits, "1"); assert.equal(settled.releaseCredits, "6");
  }
  const models = availableMetadataModels(input().rawCatalog, now);
  assert.equal(models.models[0].id, "metadata");
  assert.ok(!JSON.stringify(models).includes("approvalReference"));
  assert.ok(!JSON.stringify(models).includes("microUsd"));
});

test("metadata quote source snapshot cannot mutate across async counting and has canonical key ordering", async (t) => {
  configure(t);
  const body = input(); const initial = structuredClone(body.context);
  const first = await prepareMetadataQuote(body, { clock: () => now, fetcher: async () => {
    body.context.book.title = "Changed while counting";
    body.context.chapters[ids[4]].nodes[0].text = "Changed source";
    return Response.json(counted());
  } });
  assert.deepEqual(first.generationRequest.input, initial);
  const reordered = Object.fromEntries(Object.entries(initial).reverse());
  const second = await prepareMetadataQuote({ ...input(), context: reordered }, {
    clock: () => now, fetcher: async () => Response.json(counted()),
  });
  assert.equal(first.sourceSha256, second.sourceSha256);
  const changed = await prepareMetadataQuote({ ...input(), context: { ...initial, book: { ...initial.book, title: "Changed title" } } }, {
    clock: () => now, fetcher: async () => Response.json(counted()),
  });
  assert.notEqual(first.sourceSha256, changed.sourceSha256);
});

test("invalid scope, consent, catalog or saved source never reaches the counter", async (t) => {
  configure(t);
  const bad = [
    { ...input(), allowProviderTokenCounting: false }, { ...input(), rawCatalog: undefined },
    { ...input(), modelId: "missing" }, { ...input(), maxTokens: 4095 },
    { ...input(), scope: { ...scope, userId: "not-an-id" } },
    { ...input(), context: { ...context(), chapterIds: [ids[4], ids[4]] } },
    { ...input(), context: { ...context(), chapterIds: [ids[0]] } },
    { ...input(), context: { ...context(), styleGuide: { unsupported: Number.NaN } } },
    { ...input(), context: { ...context(), extra: "unsupported" } },
    { ...input(), context: { ...context(), book: { ...context().book, title: "Invalid \ud800 surrogate" } } },
    { ...input(), context: { ...context(), userInstruction: "x".repeat(2001) } },
    { ...input(), rawCatalog: JSON.stringify({ ...catalog(), approved: false }) },
  ];
  const wrongHash = input(); wrongHash.context.chapters[ids[4]].nodes[0].textHash = "b".repeat(64); bad.push(wrongHash);
  const duplicateNode = input(); duplicateNode.context.chapters[ids[4]].nodes.push(duplicateNode.context.chapters[ids[4]].nodes[0]); bad.push(duplicateNode);
  let calls = 0;
  for (const body of bad) {
    await assert.rejects(prepareMetadataQuote(body, { clock: () => now, fetcher: async () => {
      calls++; return Response.json(counted());
    } }));
  }
  assert.equal(calls, 0);
});

test("metadata counter rejects changed model/cap/type, invalid usage and unknown service outcomes", async (t) => {
  configure(t);
  for (const result of [
    { ...counted(), model: "wrong-model" }, { ...counted(), maxOutputTokens: 1999 },
    { ...counted(), agentType: "writer" }, { ...counted(), inputTokens: true },
    { ...counted(), inputTokens: 0 }, { ...counted(), inputTokens: 1001 },
    { ...counted(), inputSha256: "bad" }, { ...counted(), unexpected: "value" },
  ]) {
    await assert.rejects(prepareMetadataQuote(input(), { clock: () => now, fetcher: async () => Response.json(result) }));
  }
  for (const response of [new Response("not json"), new Response("x".repeat(65_537)), new Response("no", { status: 503 })]) {
    await assert.rejects(prepareMetadataQuote(input(), { clock: () => now, fetcher: async () => response }));
  }
  let calls = 0;
  await assert.rejects(prepareMetadataQuote(input(), { clock: () => now, fetcher: async () => {
    calls++; throw new Error("private upstream detail");
  } }), /Could not verify metadata/);
  assert.equal(calls, 1);
});

test("quote expiry is anchored before counting and catalog expiry is rechecked afterwards", async (t) => {
  configure(t);
  for (const after of ["2026-09-24T10:10:00.000Z", "2026-09-24T09:59:59.000Z", "2026-09-25T00:00:00.000Z"]) {
    let ticks = 0;
    await assert.rejects(prepareMetadataQuote(input(), { clock: () => ticks++ === 0 ? now : after,
      fetcher: async () => Response.json(counted()) }));
  }
  const expiring = catalog(); expiring.expiresAt = "2026-09-24T10:00:30.000Z";
  const prepared = await prepareMetadataQuote({ ...input(), rawCatalog: JSON.stringify(expiring) }, {
    clock: () => now, fetcher: async () => Response.json(counted()),
  });
  assert.equal(prepared.quote.expiresAt, expiring.expiresAt);
});

test("missing internal authentication stops before any content leaves the API", async (t) => {
  configure(t); delete process.env.AI_SERVICE_TOKEN;
  let calls = 0;
  await assert.rejects(prepareMetadataQuote(input(), { clock: () => now, fetcher: async () => {
    calls++; return Response.json(counted());
  } }), /authentication is not configured/);
  assert.equal(calls, 0);
});
