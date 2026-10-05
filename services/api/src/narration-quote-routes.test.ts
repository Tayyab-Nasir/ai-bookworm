import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { makeAuthPlugin } from "./plugins/auth.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { narrationQuoteRoutes } from "./routes/narration-quotes.js";
import { quoteUsage } from "./lib/usage-pricing.js";
import { narrationRequestHash, narrationChapterSegmentKey } from "./lib/narration-pricing.js";

const uuid = (n: number) => `a6500000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const USER = uuid(1), WORKSPACE = uuid(2), BOOK = uuid(3), EDITION = uuid(4), CHAPTER = uuid(5), DOCUMENT = uuid(6), QUOTE = uuid(7);
const headers = { authorization: "Bearer valid" };
const base = `/workspaces/${WORKSPACE}`;
const payload = { editionId: EDITION, chapterId: CHAPTER, modelId: "mini", idempotencyKey: "original-narration-key",
  segmentIndex: 0, voice: "marin", speed: 1, instructions: "PRIVATE-DELIVERY", consentToQuoteStorage: true };
const { segmentIndex: _segmentIndex, ...chapterPayload } = payload;
const CHAPTER_QUOTE = uuid(200);

async function setup(t: TestContext) {
  const previousCatalog = process.env.NARRATION_PRICING_CATALOG_JSON;
  const previousGate = process.env.NARRATION_QUOTE_PURCHASE_ENABLED;
  const previousPurchaseGate = process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED;
  delete process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED;
  process.env.NARRATION_PRICING_CATALOG_JSON = JSON.stringify({ version: "synthetic-catalog", approved: true,
    approvalReference: "PRIVATE-APPROVAL", effectiveAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z", quoteLifetimeSeconds: 600,
    entries: [{ id: "mini", label: "Mini narration", maxInputTokens: 128_000, maxOutputTokens: 1_024,
      price: { version: "synthetic-price", provider: "openai", model: "gpt-realtime-2.1-mini", rates: [
        { dimension: "text_input", microUsdPerMillionTokens: "600000" }, { dimension: "text_cached_input", microUsdPerMillionTokens: "60000" },
        { dimension: "text_output", microUsdPerMillionTokens: "2400000" }, { dimension: "audio_output", microUsdPerMillionTokens: "20000000" },
      ] }, policy: { version: "synthetic-policy", approved: true, microUsdPerCredit: "100", markupBasisPoints: 15_000,
        platformMicroUsd: "0", minimumCredits: "1" } }],
  });
  const rows: Record<string, Record<string, any>[]> = {
    workspace_members: [{ workspace_id: WORKSPACE, user_id: USER, role: "writer", status: "active" }],
    books: [{ id: BOOK, workspace_id: WORKSPACE }], editions: [{ id: EDITION, book_id: BOOK, type: "audiobook" }],
    chapters: [{ id: CHAPTER, book_id: BOOK, current_document_version_id: DOCUMENT }],
    document_versions: [{ id: DOCUMENT, chapter_id: CHAPTER, plain_text: "PRIVATE-MANUSCRIPT Café 😀. " + "A".repeat(2_000) }],
    narration_quote_snapshots: [], narration_chapter_quote_snapshots: [], narration_chapter_quote_segments: [],
    narration_chapter_quote_acceptances: [], audiobook_projects: [],
  };
  const reads: { table: string; token?: string; filters: [string, unknown][] }[] = [];
  const calls: { name: string; args: Record<string, any> }[] = [];
  const control: { errorTable?: string; rpcError?: string; lostReply?: boolean; malformedReply?: boolean; throwReply?: boolean;
    overrideTable?: string; override?: unknown; afterAcceptance?: () => void } = {};
  const factory = (token?: string) => ({
    auth: { getUser: async (value: string) => ({ data: { user: value === "valid" ? { id: USER } : value === "foreign" ? { id: uuid(9) } : null }, error: null }) },
    from(table: string) {
      if (["narration_quote_snapshots", "narration_chapter_quote_snapshots", "narration_chapter_quote_segments",
        "narration_chapter_quote_acceptances", "audiobook_projects"].includes(table)) {
        assert.equal(token, undefined, "private snapshots require the server client");
      }
      else assert.notEqual(token, undefined, "source and current membership must use caller-token RLS");
      const filters: [string, unknown][] = [];
      reads.push({ table, token, filters });
      return { select() { return this; }, eq(key: string, value: unknown) { filters.push([key, value]); return this; },
        async order() {
          if (control.errorTable === table) return { data: null, error: { message: "PRIVATE-DATABASE-ERROR" } };
          if (control.overrideTable === table) return { data: control.override, error: null };
          return { data: rows[table]!.filter(row => filters.every(([key, value]) => row[key] === value))
            .sort((a, b) => a.segment_index - b.segment_index)
            .map(row => ({ ...row, quote: rows.narration_quote_snapshots!.find(child => child.id === row.quote_id) })), error: null };
        },
        async maybeSingle() {
          if (control.errorTable === table) return { data: null, error: { message: "PRIVATE-DATABASE-ERROR" } };
          if (control.overrideTable === table) return { data: control.override, error: null };
          return { data: rows[table]?.find(row => filters.every(([key, value]) => row[key] === value)) ?? null, error: null };
        } };
    },
    async rpc(name: string, args: Record<string, any>) {
      assert.equal(token, undefined, "saving private offers requires the server client");
      assert(["save_narration_quote_snapshot", "save_narration_chapter_quote_snapshot", "accept_narration_chapter_quote"].includes(name),
        "only immutable offer saves and explicit atomic chapter acceptance are allowed");
      calls.push({ name, args });
      if (control.rpcError) return { data: null, error: { code: control.rpcError, message: "PRIVATE-DATABASE-ERROR" } };
      if (name === "accept_narration_chapter_quote") {
        // Only a transport fixture. Real all-segment funding/rollback is tested
        // by narration-funded-lifecycle.mjs against disposable PostgreSQL.
        const saved = rows.narration_chapter_quote_snapshots!.find(row => row.id === args.p_quote_id)!;
        const project = { id: uuid(201), workspace_id: saved.workspace_id, book_id: saved.book_id, edition_id: saved.edition_id,
          chapter_id: saved.chapter_id, document_version_id: saved.document_version_id, created_by: saved.user_id,
          narration_quote_id: saved.id, billing_mode: "quoted", voice: saved.voice, speed: saved.speed, status: "queued",
          segment_count: saved.segment_count, credit_units: saved.reserved_credits, created_at: new Date().toISOString(),
          instructions: "PRIVATE-DELIVERY", idempotency_key: "PRIVATE-PROJECT-KEY" };
        rows.audiobook_projects!.push(structuredClone(project));
        rows.narration_chapter_quote_acceptances!.push({ quote_id: saved.id, project_id: project.id,
          expected_credits: saved.reserved_credits, ai_disclosure_accepted: true, accepted_at: new Date().toISOString() });
        control.afterAcceptance?.();
        if (control.throwReply) throw new Error("PRIVATE-TRANSPORT-ERROR");
        if (control.lostReply) return { data: null, error: { code: "PGRST000", message: "PRIVATE-TRANSPORT-ERROR" } };
        return { data: control.malformedReply ? { ...project, edition_id: uuid(9) } : [project], error: null };
      }
      if (name === "save_narration_chapter_quote_snapshot") {
        const children = args.p_offers.map((offer: any, index: number) => ({ id: uuid(100 + index),
          user_id: args.p_user_id, workspace_id: args.p_workspace_id, book_id: args.p_book_id, edition_id: args.p_edition_id,
          chapter_id: args.p_chapter_id, document_version_id: args.p_document_version_id,
          generation_job_id: offer.request.jobId, request_sha256: narrationRequestHash(offer.request), request_json: offer.request,
          catalog_version: args.p_catalog_version, model_option_id: args.p_model_option_id,
          idempotency_key: narrationChapterSegmentKey(args.p_idempotency_key, index),
          quote_json: offer.quote, expires_at: offer.quote.expiresAt }));
        const row = { id: CHAPTER_QUOTE, user_id: args.p_user_id, workspace_id: args.p_workspace_id, book_id: args.p_book_id,
          edition_id: args.p_edition_id, chapter_id: args.p_chapter_id, document_version_id: args.p_document_version_id,
          source_sha256: args.p_source_sha256, idempotency_key: args.p_idempotency_key, catalog_version: args.p_catalog_version,
          model_option_id: args.p_model_option_id, voice: children[0].request_json.voice, speed: children[0].request_json.speed,
          instructions: children[0].request_json.instructions, segment_count: children.length,
          reserved_credits: Number(children.reduce((sum: bigint, child: any) => sum + BigInt(child.quote_json.reservedCredits), 0n)),
          expires_at: children[0].expires_at };
        rows.narration_quote_snapshots!.push(...structuredClone(children));
        rows.narration_chapter_quote_snapshots!.push(structuredClone(row));
        rows.narration_chapter_quote_segments!.push(...children.map((child: any, index: number) => ({ chapter_quote_id: row.id, segment_index: index, quote_id: child.id })));
        if (control.throwReply) throw new Error("PRIVATE-TRANSPORT-ERROR");
        if (control.lostReply) return { data: null, error: { code: "PGRST000", message: "PRIVATE-TRANSPORT-ERROR" } };
        return { data: control.malformedReply ? { ...row, source_sha256: "a".repeat(64) } : [row], error: null };
      }
      const row = { id: QUOTE, user_id: args.p_user_id, workspace_id: args.p_workspace_id, book_id: args.p_book_id,
        edition_id: args.p_edition_id, chapter_id: args.p_chapter_id, document_version_id: args.p_document_version_id,
        generation_job_id: args.p_job_id, request_sha256: args.p_request_sha256, request_json: args.p_request,
        catalog_version: args.p_catalog_version, model_option_id: args.p_model_option_id, idempotency_key: args.p_idempotency_key,
        quote_json: args.p_quote, expires_at: args.p_quote.expiresAt };
      rows.narration_quote_snapshots!.push(structuredClone(row));
      if (control.throwReply) throw new Error("PRIVATE-TRANSPORT-ERROR");
      if (control.lostReply) return { data: null, error: { code: "PGRST000", message: "PRIVATE-TRANSPORT-ERROR" } };
      return { data: control.malformedReply ? { ...row, idempotency_key: "changed-receipt-key" } : [row], error: null };
    },
  });
  const app = Fastify();
  await app.register(errorHandlerPlugin);
  await app.register(makeAuthPlugin(factory as never));
  narrationQuoteRoutes(app);
  await app.ready();
  t.after(async () => {
    if (previousCatalog === undefined) delete process.env.NARRATION_PRICING_CATALOG_JSON; else process.env.NARRATION_PRICING_CATALOG_JSON = previousCatalog;
    if (previousGate === undefined) delete process.env.NARRATION_QUOTE_PURCHASE_ENABLED; else process.env.NARRATION_QUOTE_PURCHASE_ENABLED = previousGate;
    if (previousPurchaseGate === undefined) delete process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED; else process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = previousPurchaseGate;
    await app.close();
  });
  const create = (next = payload) => app.inject({ method: "POST", url: `${base}/narration-quotes`, headers, payload: next });
  const recover = () => app.inject({ method: "POST", url: `${base}/narration-quotes/recover`, headers, payload: { idempotencyKey: payload.idempotencyKey } });
  const createChapter = (next = chapterPayload) => app.inject({ method: "POST", url: `${base}/narration-chapter-quotes`, headers, payload: next });
  const recoverChapter = () => app.inject({ method: "POST", url: `${base}/narration-chapter-quotes/recover`, headers,
    payload: { idempotencyKey: chapterPayload.idempotencyKey } });
  const acceptChapter = (change: Record<string, unknown> = {}) => app.inject({ method: "POST",
    url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}/accept`, headers,
    payload: { expectedCredits: String(rows.narration_chapter_quote_snapshots![0]?.reserved_credits ?? 1),
      consentToAiVoice: true, consentToGenerate: true, ...change } });
  const acceptedChapter = () => app.inject({ url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}/project`, headers });
  return { app, rows, reads, calls, control, create, recover, createChapter, recoverChapter, acceptChapter, acceptedChapter };
}

test("narration offer admission requires authentication, valid scope and storage consent without client pricing", async t => {
  const { app, calls, create } = await setup(t);
  assert.equal((await app.inject({ method: "POST", url: `${base}/narration-quotes`, payload })).statusCode, 401);
  for (const next of [{ ...payload, consentToQuoteStorage: false }, { ...payload, voice: "fable" }, { ...payload, speed: 1.005 },
    { ...payload, segmentIndex: 250 }, { ...payload, editionId: "invalid" }, { ...payload, expectedCredits: "1" },
    { ...payload, plainText: "DIY source" }, { ...payload, userId: uuid(9) }, { ...payload, maximumTokens: {} }, { ...payload, price: {} },
    { ...payload, instructions: " padded " }, { ...payload, instructions: "\ud800" }]) {
    assert.equal((await create(next as never)).statusCode, 422);
  }
  assert.equal((await app.inject({ method: "POST", url: "/workspaces/invalid/narration-quotes", headers, payload })).statusCode, 422);
  assert.equal(calls.length, 0);
});

test("narration public models and one-segment offers are private, source-pinned and never purchasable", async t => {
  const { app, calls, create } = await setup(t);
  process.env.NARRATION_QUOTE_PURCHASE_ENABLED = "true";
  const models = await app.inject({ url: `${base}/narration-models`, headers });
  assert.equal(models.statusCode, 200);
  assert.equal(models.headers["cache-control"], "private, no-store");
  assert.equal(models.json().purchaseAvailable, false);
  assert.equal(models.json().voices.length, 10);
  const result = await create();
  assert.equal(result.statusCode, 200);
  assert.equal(result.headers["cache-control"], "private, no-store");
  assert.equal(result.json().quoteId, QUOTE);
  assert.equal(result.json().purchaseAvailable, false);
  assert.equal(result.json().pricingBasis, "maximum_token_budget");
  assert.deepEqual(result.json().source, { bookId: BOOK, editionId: EDITION, chapterId: CHAPTER, documentVersionId: DOCUMENT,
    segmentIndex: 0, textStart: 0, textEnd: calls[0]!.args.p_request.textEnd });
  assert.equal(calls.length, 1);
  const saved = JSON.stringify(calls[0]!.args);
  assert(!saved.includes("PRIVATE-MANUSCRIPT"), "RPC snapshots must contain source pointers, not copied manuscript text");
  for (const body of [result.body, models.body]) for (const privateField of ["PRIVATE", "microUsd", "approvalReference", "request_sha256", "instructions", "quote_json"]) {
    assert(!body.includes(privateField), `public projection leaked ${privateField}`);
  }
  assert.equal((await app.inject({ method: "POST", url: `${base}/narration-quotes/${QUOTE}/accept`, headers,
    payload: { consentToGenerate: true, expectedCredits: result.json().reservedCredits } })).statusCode, 404);
});

test("lost narration save is recoverable with only the original key and without source/catalog access or another RPC", async t => {
  const { app, rows, reads, calls, control, create, recover } = await setup(t);
  control.lostReply = true;
  const uncertain = await create();
  assert.equal(uncertain.statusCode, 503);
  assert(!uncertain.body.includes("PRIVATE"));
  delete process.env.NARRATION_PRICING_CATALOG_JSON;
  rows.document_versions = []; rows.chapters = [];
  reads.length = 0;
  const recovered = await recover();
  assert.equal(recovered.statusCode, 200);
  assert.equal(recovered.json().quoteId, QUOTE);
  const byId = await app.inject({ url: `${base}/narration-quotes/${QUOTE}`, headers });
  assert.deepEqual(byId.json(), recovered.json());
  const retried = await create();
  assert.deepEqual(retried.json(), recovered.json());
  assert.equal(calls.length, 1);
  assert(reads.every(read => ["workspace_members", "narration_quote_snapshots"].includes(read.table)), "recovery must not reread changed sources");
  assert.equal(recovered.headers["cache-control"], "private, no-store");
});

test("saved key rejects changed delivery or identity and remains scoped to its author", async t => {
  const { app, calls, create } = await setup(t);
  assert.equal((await create()).statusCode, 200);
  for (const change of [{ voice: "cedar" }, { speed: 0.9 }, { instructions: "Changed" }, { modelId: "other" },
    { editionId: uuid(8) }, { chapterId: uuid(8) }, { segmentIndex: 1 }]) {
    assert.equal((await create({ ...payload, ...change } as never)).statusCode, 409);
  }
  assert.equal((await app.inject({ url: `${base}/narration-quotes/${QUOTE}`, headers: { authorization: "Bearer foreign" } })).statusCode, 403);
  assert.equal(calls.length, 1);
});

test("current roles fence creation and revoked membership fences read-only recovery", async t => {
  const { app, rows, calls, create, recover } = await setup(t);
  for (const role of ["designer", "illustrator", "reviewer", "viewer"]) {
    rows.workspace_members![0]!.role = role;
    assert.equal((await create()).statusCode, 403);
  }
  assert.equal(calls.length, 0);
  rows.workspace_members![0]!.role = "editor";
  assert.equal((await create()).statusCode, 200);
  rows.workspace_members![0]!.role = "viewer";
  assert.equal((await recover()).statusCode, 200, "active owner may read their own immutable offer after losing write access");
  assert.equal((await create()).statusCode, 403);
  rows.workspace_members![0]!.status = "suspended";
  assert.equal((await recover()).statusCode, 403);
  assert.equal((await app.inject({ url: `${base}/narration-models`, headers })).statusCode, 403);
});

test("new offers fail closed for unavailable, foreign, wrong-format and invalid saved source", async t => {
  const { rows, calls, create, control } = await setup(t);
  const original = structuredClone(rows);
  for (const [table, change, expected] of [
    ["editions", { type: "epub" }, 404], ["books", { workspace_id: uuid(9) }, 404], ["chapters", { book_id: uuid(9) }, 404],
    ["chapters", { current_document_version_id: null }, 404], ["document_versions", { chapter_id: uuid(9) }, 422],
    ["document_versions", { plain_text: 4 }, 422], ["document_versions", { plain_text: " " }, 422],
    ["document_versions", { plain_text: "A".repeat(1_000_001) }, 422],
  ] as const) {
    Object.assign(rows, structuredClone(original));
    Object.assign(rows[table]![0]!, change);
    assert.equal((await create()).statusCode, expected);
  }
  Object.assign(rows, structuredClone(original));
  assert.equal((await create({ ...payload, segmentIndex: 249 })).statusCode, 422);
  assert.equal((await create({ ...payload, modelId: "unknown" })).statusCode, 422);
  for (const table of ["narration_quote_snapshots", "editions", "books", "chapters", "document_versions"]) {
    control.errorTable = table;
    const result = await create();
    assert.equal(result.statusCode, 503);
    assert(!result.body.includes("PRIVATE-DATABASE-ERROR"));
  }
  delete control.errorTable;
  delete process.env.NARRATION_PRICING_CATALOG_JSON;
  assert.equal((await create()).statusCode, 503);
  assert.equal(calls.length, 0);
});

test("save failures map safe errors without leaking database detail or treating uncertainty as funding", async t => {
  const { create, control, calls } = await setup(t);
  for (const [code, status] of [["42501", 403], ["23505", 409], ["23514", 409], ["22023", 409], ["PRIVATE-UNKNOWN-CODE", 503]] as const) {
    control.rpcError = code;
    const result = await create();
    assert.equal(result.statusCode, status);
    assert(!result.body.includes("PRIVATE"));
  }
  assert(calls.every(call => call.name === "save_narration_quote_snapshot"));
});

test("malformed save receipts and thrown lost replies preserve recoverable identity", async t => {
  const { rows, create, recover, control } = await setup(t);
  control.malformedReply = true;
  assert.equal((await create()).statusCode, 503);
  assert.equal((await recover()).statusCode, 200);
  rows.narration_quote_snapshots = [];
  control.malformedReply = false; control.throwReply = true;
  const thrown = await create();
  assert.equal(thrown.statusCode, 500);
  assert(!thrown.body.includes("PRIVATE"));
  assert.equal((await recover()).statusCode, 200);
});

test("saved offer recovery rejects corrupted rows and canonical-but-discounted budgets", async t => {
  const { rows, create, recover, control } = await setup(t);
  assert.equal((await create()).statusCode, 200);
  const original = structuredClone(rows.narration_quote_snapshots![0]!);
  const discounted = quoteUsage({ ...original.quote_json, maximumTokens: original.quote_json.maximumTokens.map((value: any) => ({ ...value, tokens: "1" })) });
  for (const change of [{ quote_json: discounted }, { quote_json: { ...original.quote_json, reservedCredits: "1" } },
    { request_sha256: "a".repeat(64) }, { generation_job_id: uuid(9) }, { expires_at: "2099-01-01T00:00:00.000Z" },
    { request_json: { ...original.request_json, promptSha256: "a".repeat(64) } }, { request_json: { ...original.request_json, extra: true } }]) {
    rows.narration_quote_snapshots![0] = { ...structuredClone(original), ...change };
    const result = await recover();
    assert.equal(result.statusCode, 503);
    assert(!result.body.includes("PRIVATE"));
  }
  control.overrideTable = "narration_quote_snapshots";
  for (const change of [{ user_id: uuid(9) }, { workspace_id: uuid(9) }, { idempotency_key: "foreign-key" }, { id: "invalid" }]) {
    control.override = { ...structuredClone(original), ...change };
    assert.equal((await recover()).statusCode, 503);
  }
});

test("read-only recovery admission, missing keys and storage errors never invoke writes", async t => {
  const { app, calls, recover, control } = await setup(t);
  assert.equal((await recover()).statusCode, 404);
  assert.equal((await app.inject({ url: `${base}/narration-quotes/${QUOTE}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: `${base}/narration-quotes/recover`, headers,
    payload: { idempotencyKey: payload.idempotencyKey, instructions: "Do not reread" } })).statusCode, 422);
  assert.equal((await app.inject({ url: `${base}/narration-quotes/invalid`, headers })).statusCode, 422);
  assert.equal((await app.inject({ url: "/workspaces/invalid/narration-models", headers })).statusCode, 422);
  control.errorTable = "narration_quote_snapshots";
  assert.equal((await recover()).statusCode, 503);
  assert.equal((await app.inject({ url: `${base}/narration-quotes/${QUOTE}`, headers })).statusCode, 503);
  control.errorTable = "workspace_members";
  assert.equal((await recover()).statusCode, 403);
  assert.equal(calls.length, 0);
});

test("whole chapter admission requires exact storage consent and excludes client source, budgets and segment selection", async t => {
  const { app, calls, createChapter } = await setup(t);
  assert.equal((await app.inject({ method: "POST", url: `${base}/narration-chapter-quotes`, payload: chapterPayload })).statusCode, 401);
  for (const change of [{ consentToQuoteStorage: false }, { segmentIndex: 0 }, { expectedCredits: "1" }, { sourceText: "Client manuscript" },
    { modelId: "unknown" }, { chapterId: "invalid" }, { voice: "nova" }, { speed: 1.005 }, { instructions: " padded " }, { instructions: "\ud800" }]) {
    assert.equal((await createChapter({ ...chapterPayload, ...change } as never)).statusCode, 422);
  }
  assert.equal(calls.length, 0);
});

test("whole chapter offer contains every saved segment and exact aggregate without manuscript, payment or generation", async t => {
  const { app, rows, calls, createChapter } = await setup(t);
  rows.document_versions![0]!.plain_text = "A".repeat(4_000);
  const result = await createChapter();
  assert.equal(result.statusCode, 200, result.body);
  const offer = result.json();
  assert.equal(offer.quoteId, CHAPTER_QUOTE);
  assert.equal(offer.purchaseAvailable, false);
  assert.equal(offer.pricingBasis, "maximum_token_budget");
  assert.deepEqual(offer.source, { bookId: BOOK, editionId: EDITION, chapterId: CHAPTER, documentVersionId: DOCUMENT });
  assert.equal(offer.segmentCount, 3);
  assert.equal(offer.reservedCredits, String(offer.segments.reduce((sum: number, segment: any) => sum + Number(segment.reservedCredits), 0)));
  assert.deepEqual(offer.segments.map((segment: any) => [segment.segmentIndex, segment.textStart, segment.textEnd]),
    [[0, 0, 1_784], [1, 1_784, 3_568], [2, 3_568, 4_000]]);
  assert.equal(result.headers["cache-control"], "private, no-store");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, "save_narration_chapter_quote_snapshot");
  assert.equal(rows.narration_chapter_quote_snapshots!.length, 1);
  assert.equal(rows.narration_chapter_quote_segments!.length, 3);
  for (const privateField of ["PRIVATE", "instructions", "microUsd", "jobId", "request_json", "source_sha256", "idempotencyKey"]) {
    assert(!result.body.includes(privateField), `chapter response leaked ${privateField}`);
  }
  assert(!JSON.stringify(calls[0]!.args).includes("A".repeat(100)), "saved RPC must use source pointers, not copied manuscript");
  assert.equal((await app.inject({ method: "POST", url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}/accept`, headers,
    payload: { consentToGenerate: true, expectedCredits: offer.reservedCredits } })).statusCode, 422);
});

test("whole chapter uncertain save recovers every original child without catalog, manuscript read or second save", async t => {
  for (const mode of ["lostReply", "malformedReply", "throwReply"] as const) await t.test(mode, async sub => {
    const { app, rows, reads, calls, control, createChapter, recoverChapter } = await setup(sub);
    control[mode] = true;
    const uncertain = await createChapter();
    assert.equal(uncertain.statusCode, mode === "throwReply" ? 500 : 503);
    assert(!uncertain.body.includes("PRIVATE"));
    delete process.env.NARRATION_PRICING_CATALOG_JSON;
    rows.document_versions = []; rows.chapters = [];
    reads.length = 0;
    const recovered = await recoverChapter();
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().quoteId, CHAPTER_QUOTE);
    assert.equal(recovered.json().segmentCount, rows.narration_chapter_quote_segments!.length);
    assert.deepEqual((await app.inject({ url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}`, headers })).json(), recovered.json());
    assert.deepEqual((await createChapter()).json(), recovered.json());
    assert.equal(calls.length, 1);
    assert(reads.every(read => ["workspace_members", "narration_chapter_quote_snapshots", "narration_chapter_quote_segments"].includes(read.table)));
  });
});

test("whole chapter keys and delivery stay immutable; current permission gates new writes and private recovery", async t => {
  const { app, rows, calls, createChapter, recoverChapter } = await setup(t);
  for (const role of ["viewer", "designer", "reviewer", "illustrator"]) {
    rows.workspace_members![0]!.role = role;
    assert.equal((await createChapter()).statusCode, 403);
  }
  rows.workspace_members![0]!.role = "owner";
  assert.equal((await createChapter()).statusCode, 200);
  for (const change of [{ voice: "cedar" }, { speed: 0.5 }, { instructions: null }, { modelId: "different" }, { chapterId: uuid(9) }, { editionId: uuid(9) }]) {
    assert.equal((await createChapter({ ...chapterPayload, ...change } as never)).statusCode, 409);
  }
  rows.workspace_members![0]!.role = "viewer";
  assert.equal((await recoverChapter()).statusCode, 200);
  assert.equal((await createChapter()).statusCode, 403);
  rows.workspace_members![0]!.status = "suspended";
  assert.equal((await recoverChapter()).statusCode, 403);
  assert.equal((await app.inject({ url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}`, headers })).statusCode, 403);
  assert.equal(calls.length, 1);
});

test("whole chapter recovery rejects corrupt aggregates, missing, foreign, duplicated and mismatched canonical children", async t => {
  const { rows, createChapter, recoverChapter, control } = await setup(t);
  assert.equal((await createChapter()).statusCode, 200);
  const parent = structuredClone(rows.narration_chapter_quote_snapshots![0]!);
  const children = structuredClone(rows.narration_quote_snapshots!);
  const links = structuredClone(rows.narration_chapter_quote_segments!);
  for (const change of [{ reserved_credits: 1 }, { segment_count: 250 }, { voice: "cedar" }, { speed: 0.5 }, { document_version_id: uuid(9) },
    { catalog_version: "different" }, { expires_at: "2099-01-01T00:00:00.000Z" }, { instructions: null }]) {
    rows.narration_chapter_quote_snapshots![0] = { ...parent, ...change };
    assert.equal((await recoverChapter()).statusCode, 503);
  }
  rows.narration_chapter_quote_snapshots![0] = parent;
  for (const change of [{ user_id: uuid(9) }, { workspace_id: uuid(9) }, { id: "invalid" }, { idempotency_key: "foreign-parent-key" }]) {
    control.overrideTable = "narration_chapter_quote_snapshots"; control.override = { ...parent, ...change };
    assert.equal((await recoverChapter()).statusCode, 503);
  }
  delete control.overrideTable;
  for (const corrupt of [[], [links[0], links[0]], [{ ...links[1], segment_index: 0 }, { ...links[0], segment_index: 1 }],
    [{ ...links[0], quote_id: uuid(9) }, links[1]]]) {
    rows.narration_chapter_quote_segments = structuredClone(corrupt) as never;
    assert.equal((await recoverChapter()).statusCode, 503);
  }
  rows.narration_chapter_quote_segments = links;
  for (const change of [{ catalog_version: "different" }, { generation_job_id: uuid(9) }, { request_sha256: "a".repeat(64) },
    { request_json: { ...children[0]!.request_json, extra: true } }, { idempotency_key: "borrowed-other-chapter-key" }]) {
    rows.narration_quote_snapshots![0] = { ...children[0]!, ...change };
    assert.equal((await recoverChapter()).statusCode, 503, JSON.stringify(change));
  }
  rows.narration_quote_snapshots = children;
  control.errorTable = "narration_chapter_quote_segments";
  assert.equal((await recoverChapter()).statusCode, 503);
});

test("whole chapter safe database errors and key-only read admission never become acceptance or reveal private details", async t => {
  const { app, rows, calls, createChapter, recoverChapter, control } = await setup(t);
  assert.equal((await recoverChapter()).statusCode, 404);
  assert.equal((await app.inject({ url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ url: `${base}/narration-chapter-quotes/invalid`, headers })).statusCode, 422);
  assert.equal((await app.inject({ method: "POST", url: `${base}/narration-chapter-quotes/recover`, headers,
    payload: { idempotencyKey: chapterPayload.idempotencyKey, consentToQuoteStorage: true } })).statusCode, 422);
  for (const [code, status] of [["42501", 403], ["23505", 409], ["23514", 409], ["22023", 409], ["unknown", 503]] as const) {
    control.rpcError = code;
    const result = await createChapter();
    assert.equal(result.statusCode, status);
    assert(!result.body.includes("PRIVATE"));
  }
  delete control.rpcError;
  control.errorTable = "narration_chapter_quote_snapshots";
  assert.equal((await createChapter()).statusCode, 503);
  assert.equal((await recoverChapter()).statusCode, 503);
  assert.equal((await app.inject({ url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}`, headers })).statusCode, 503);
  delete control.errorTable;
  rows.workspace_members!.push({ workspace_id: WORKSPACE, user_id: uuid(9), role: "viewer", status: "active" });
  assert.equal((await app.inject({ url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}`, headers: { authorization: "Bearer foreign" } })).statusCode, 404);
  assert(calls.every(call => call.name === "save_narration_chapter_quote_snapshot"));
});

test("chapter purchase admission requires exact integer credits and two explicit consents", async t => {
  const { app, calls, createChapter, acceptChapter } = await setup(t);
  await createChapter();
  assert.equal((await app.inject({ method: "POST", url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}/accept`, payload: {} })).statusCode, 401);
  for (const change of [{ consentToAiVoice: false }, { consentToGenerate: false }, { consentToAiVoice: undefined },
    { expectedCredits: "0" }, { expectedCredits: "01" }, { expectedCredits: "2147483648" }, { expectedCredits: 1 },
    { expectedCredits: "1.5" }, { catalog: {} }, { userId: uuid(9) }, { projectId: uuid(201) }, { instructions: "Client delivery" }]) {
    assert.equal((await acceptChapter(change)).statusCode, 422, JSON.stringify(change));
  }
  assert.equal((await app.inject({ method: "POST", url: `${base}/narration-chapter-quotes/invalid/accept`, headers, payload: {} })).statusCode, 422);
  assert.equal(calls.length, 1, "admission cannot fund or dispatch work");
});

test("new chapter purchases stay closed without the actual operator gate and matching approved profile", async t => {
  const { app, calls, createChapter, acceptChapter } = await setup(t);
  const offer = (await createChapter()).json();
  const catalog = JSON.parse(process.env.NARRATION_PRICING_CATALOG_JSON!);
  for (const gate of [undefined, "false", "TRUE"]) {
    if (gate === undefined) delete process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED; else process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = gate;
    assert.equal((await acceptChapter()).statusCode, 503);
  }
  process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = "true";
  for (const mutate of [
    (value: any) => { value.approved = false; }, (value: any) => { value.version = "different"; },
    (value: any) => { value.entries[0].maxOutputTokens = 512; }, (value: any) => { value.entries[0].price.rates[0].microUsdPerMillionTokens = "1"; },
    (value: any) => { value.entries[0].policy.markupBasisPoints = 10_000; }, (value: any) => { value.quoteLifetimeSeconds = 30; },
    (value: any) => { value.entries[0].id = "other"; }, (value: any) => { value.expiresAt = "2026-01-02T00:00:00.000Z"; },
  ]) {
    const changed = structuredClone(catalog); mutate(changed); process.env.NARRATION_PRICING_CATALOG_JSON = JSON.stringify(changed);
    const recovered = await app.inject({ url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}`, headers });
    assert.equal(recovered.statusCode, 200, "closed pricing must not break saved offer recovery");
    assert.equal(recovered.json().purchaseAvailable, false);
    assert.equal((await acceptChapter()).statusCode, 503);
  }
  process.env.NARRATION_PRICING_CATALOG_JSON = JSON.stringify(catalog);
  t.mock.method(Date, "now", () => Date.parse(offer.expiresAt));
  assert.equal((await acceptChapter()).statusCode, 503, "an expired original cannot be newly purchased");
  assert.equal(calls.length, 1);
});

test("enabled chapter acceptance funds once and returns only the scoped authoritative project projection", async t => {
  const { app, rows, reads, calls, createChapter, acceptChapter, acceptedChapter } = await setup(t);
  process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = "true";
  const offer = (await createChapter()).json();
  assert.equal(offer.purchaseAvailable, true);
  assert.equal((await app.inject({ url: `${base}/narration-models`, headers })).json().purchaseAvailable, true);
  assert.deepEqual((await acceptedChapter()).json(), { quoteId: CHAPTER_QUOTE, accepted: false, project: null });
  const accepted = await acceptChapter();
  assert.equal(accepted.statusCode, 200, accepted.body);
  const projected = { quoteId: CHAPTER_QUOTE, accepted: true,
    project: { id: uuid(201), billingMode: "quoted", status: "queued", reservedCredits: offer.reservedCredits } };
  assert.deepEqual(accepted.json(), projected);
  assert.equal(accepted.headers["cache-control"], "private, no-store");
  const funded = calls.find(call => call.name === "accept_narration_chapter_quote")!;
  assert.equal(funded.args.p_expected_credits, Number(offer.reservedCredits));
  assert.equal(funded.args.p_ai_disclosure_accepted, true);
  assert.equal(funded.args.p_user_id, USER); assert.equal(funded.args.p_quote_id, CHAPTER_QUOTE);
  assert.equal(funded.args.p_catalog.approved, true);
  for (const privateField of ["PRIVATE", "instructions", "user_id", "expected_credits", "ai_disclosure", "microUsd", "approvalReference"]) {
    assert(!accepted.body.includes(privateField), `acceptance leaked ${privateField}`);
  }
  delete process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED; delete process.env.NARRATION_PRICING_CATALOG_JSON;
  rows.chapters = []; rows.document_versions = []; reads.length = 0;
  assert.deepEqual((await acceptedChapter()).json(), projected);
  assert.deepEqual((await acceptChapter()).json(), projected, "same confirmed replay recovers the original even after operator/source changes");
  assert.equal((await acceptChapter({ expectedCredits: "1" })).statusCode, 409);
  assert.equal(calls.filter(call => call.name === "accept_narration_chapter_quote").length, 1);
  assert(reads.every(read => ["workspace_members", "narration_chapter_quote_snapshots", "narration_chapter_quote_segments",
    "narration_chapter_quote_acceptances", "audiobook_projects"].includes(read.table)), "recovery must not reread mutable sources");
  const projectRead = reads.find(read => read.table === "audiobook_projects")!;
  for (const pin of [["id", uuid(201)], ["workspace_id", WORKSPACE], ["created_by", USER], ["narration_quote_id", CHAPTER_QUOTE]]) {
    assert(projectRead.filters.some(filter => filter[0] === pin[0] && filter[1] === pin[1]));
  }
});

test("lost or malformed chapter acceptance replies recover read-only without a new purchase", async t => {
  for (const mode of ["lostReply", "throwReply", "malformedReply"] as const) await t.test(mode, async sub => {
    const { rows, calls, control, createChapter, acceptChapter, acceptedChapter } = await setup(sub);
    await createChapter(); process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = "true"; control[mode] = true;
    const uncertain = await acceptChapter();
    assert.equal(uncertain.statusCode, 503); assert(!uncertain.body.includes("PRIVATE"));
    delete process.env.NARRATION_PRICING_CATALOG_JSON; delete process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED;
    rows.chapters = []; rows.document_versions = [];
    const recovered = await acceptedChapter();
    assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(recovered.json().project.id, uuid(201));
    assert.equal(rows.audiobook_projects!.length, 1);
    assert.equal(rows.narration_chapter_quote_acceptances!.length, 1);
    assert.equal(calls.filter(call => call.name === "accept_narration_chapter_quote").length, 1);
  });
});

test("chapter acceptance and recovery enforce current actor, scope and immutable accepted identity", async t => {
  const { app, rows, control, calls, createChapter, acceptChapter, acceptedChapter } = await setup(t);
  await createChapter(); process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = "true";
  for (const role of ["viewer", "reviewer", "designer", "illustrator"]) {
    rows.workspace_members![0]!.role = role; assert.equal((await acceptChapter()).statusCode, 403);
  }
  rows.workspace_members![0]!.role = "writer";
  assert.equal((await acceptChapter()).statusCode, 200);
  for (const status of ["queued", "running", "succeeded", "failed"]) {
    rows.audiobook_projects![0]!.status = status;
    assert.equal((await acceptedChapter()).json().project.status, status);
  }
  const project = structuredClone(rows.audiobook_projects![0]!);
  control.overrideTable = "audiobook_projects";
  for (const change of [{ id: uuid(9) }, { workspace_id: uuid(9) }, { created_by: uuid(9) }, { book_id: uuid(9) },
    { edition_id: uuid(9) }, { chapter_id: uuid(9) }, { document_version_id: uuid(9) }, { narration_quote_id: uuid(9) },
    { billing_mode: "operational" }, { voice: "cedar" }, { speed: 0.5 }, { segment_count: 1 }, { credit_units: 1 },
    { status: "unknown" }, { created_at: "invalid" }]) {
    control.override = { ...project, ...change };
    assert.equal((await acceptedChapter()).statusCode, 503, JSON.stringify(change));
  }
  delete control.overrideTable;
  const acceptance = structuredClone(rows.narration_chapter_quote_acceptances![0]!);
  control.overrideTable = "narration_chapter_quote_acceptances";
  for (const change of [{ quote_id: uuid(9) }, { project_id: "invalid" }, { expected_credits: 1 }, { ai_disclosure_accepted: false }, { accepted_at: "invalid" }]) {
    control.override = { ...acceptance, ...change }; assert.equal((await acceptedChapter()).statusCode, 503);
  }
  delete control.overrideTable;
  rows.workspace_members!.push({ workspace_id: WORKSPACE, user_id: uuid(9), role: "writer", status: "active" });
  assert.equal((await app.inject({ url: `${base}/narration-chapter-quotes/${CHAPTER_QUOTE}/project`, headers: { authorization: "Bearer foreign" } })).statusCode, 404);
  rows.workspace_members![0]!.role = "viewer";
  assert.equal((await acceptedChapter()).statusCode, 200); assert.equal((await acceptChapter()).statusCode, 403);
  rows.workspace_members![0]!.status = "suspended";
  assert.equal((await acceptedChapter()).statusCode, 403);
  assert.equal(calls.filter(call => call.name === "accept_narration_chapter_quote").length, 1);
});

test("chapter purchase failures remain private and cannot bypass unavailable acceptance recovery", async t => {
  const { rows, control, calls, createChapter, acceptChapter, acceptedChapter } = await setup(t);
  await createChapter(); process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = "true";
  for (const [code, status] of [["42501", 403], ["P0002", 404], ["23514", 409], ["22023", 409], ["23505", 409], ["private-unknown", 503]] as const) {
    control.rpcError = code; const result = await acceptChapter();
    assert.equal(result.statusCode, status); assert(!result.body.includes("PRIVATE"));
  }
  delete control.rpcError;
  const before = calls.length;
  control.errorTable = "narration_chapter_quote_acceptances";
  assert.equal((await acceptChapter()).statusCode, 503); assert.equal((await acceptedChapter()).statusCode, 503);
  assert.equal(calls.length, before, "unknown prior acceptance must not be treated as unpurchased");
  delete control.errorTable;
  assert.equal((await acceptChapter()).statusCode, 200);
  rows.audiobook_projects = [];
  assert.equal((await acceptedChapter()).statusCode, 503);
  assert.equal((await acceptChapter()).statusCode, 503, "missing original project cannot authorize another purchase");
  assert.equal(calls.length, before + 1);
});

test("post-commit authoritative readback failures never confirm or repeat the purchase", async t => {
  for (const fault of ["acceptanceRead", "projectRead", "missingAcceptance", "mismatchedProject"] as const) await t.test(fault, async sub => {
    const { rows, control, calls, createChapter, acceptChapter, acceptedChapter } = await setup(sub);
    await createChapter(); process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED = "true";
    control.afterAcceptance = () => {
      if (fault === "acceptanceRead") control.errorTable = "narration_chapter_quote_acceptances";
      if (fault === "projectRead") control.errorTable = "audiobook_projects";
      if (fault === "missingAcceptance") { control.overrideTable = "narration_chapter_quote_acceptances"; control.override = null; }
      if (fault === "mismatchedProject") { control.overrideTable = "audiobook_projects"; control.override = { ...rows.audiobook_projects![0], id: uuid(9) }; }
    };
    const uncertain = await acceptChapter();
    assert.equal(uncertain.statusCode, 503, uncertain.body); assert(!uncertain.body.includes("PRIVATE"));
    delete control.errorTable; delete control.overrideTable; delete control.afterAcceptance;
    delete process.env.AUDIOBOOK_QUOTE_PURCHASE_ENABLED; delete process.env.NARRATION_PRICING_CATALOG_JSON;
    const recovered = await acceptedChapter();
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(recovered.json().accepted, true); assert.equal(recovered.json().project.id, uuid(201));
    assert.equal(calls.filter(call => call.name === "accept_narration_chapter_quote").length, 1);
    assert.equal(rows.audiobook_projects!.length, 1);
  });
});
