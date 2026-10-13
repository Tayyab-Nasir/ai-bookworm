import { createHash, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import Fastify from "fastify";
import { makeAuthPlugin } from "./plugins/auth.js";
import { idempotencyPlugin } from "./plugins/idempotency.js";
import { errorHandlerPlugin } from "./plugins/error-handler.js";
import { bookMemoryRoutes } from "./routes/book-memory.js";

const BOOK = "b1000000-0000-4000-8000-000000000001";
const WORKSPACE = "b1000000-0000-4000-8000-000000000002";
const USER = "b1000000-0000-4000-8000-000000000003";
const ITEM = "b1000000-0000-4000-8000-000000000004";
const OTHER = "b1000000-0000-4000-8000-000000000005";
const INCARNATION = "b1000000-0000-4000-8000-000000000006";
const TIME = "2026-10-13T08:00:00.000Z";
const auth = { authorization: "Bearer member", "x-bookworm-actor": USER };
const body = () => ({ requestId: randomUUID(), type: "character", name: "  Elara  ", description: " mapmaker ", sourceRefs: [{ chapterId: OTHER, nodeId: "original-unpinned-node" }] });
type Row = Record<string, unknown>;
function store() {
  return { books: [{ id: BOOK, workspace_id: WORKSPACE }], members: [{ workspace_id: WORKSPACE, user_id: USER, role: "editor", status: "active" }],
    calls: [] as { name: string; args: Row }[], reads: [] as string[], directWrites: [] as string[], tokens: [] as (string | undefined)[],
    receipts: new Map<string, { receipt: Row; original: string }>(), closures: new Map<string, Row>(), closureWrites: 0, item: null as Row | null, writes: 0,
    error: null as string | null, loseReply: false, override: null as ((result: Row) => Row) | null };
}
type Store = ReturnType<typeof store>;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function projection(saved: Store, receipt: Row | null, replayed: boolean, closure: Row | null = null) {
  const current = saved.item;
  const result: Row = receipt ? { receipt, disposition: !current ? "deleted" : receipt.action === "delete" || digest(current) !== receipt.resultHash ? "changed" : "unchanged", item: current, replayed, closed: false, closure: null }
    : { receipt: null, disposition: null, item: null, replayed: false, closed: !!closure, closure };
  return saved.override ? saved.override(structuredClone(result)) : structuredClone(result);
}
function factory(saved: Store) {
  return (token?: string) => {
    saved.tokens.push(token);
    return { auth: { getUser: async () => ({ data: { user: token === "member" ? { id: USER } : null }, error: null }) },
      from(table: string) {
        saved.reads.push(table);
        const rows = table === "books" ? saved.books : table === "workspace_members" ? saved.members : (() => { throw new Error(`Dynamic validation/direct table access is forbidden: ${table}`); })();
        const filters: [string, unknown][] = [];
        const builder = { select: () => builder, eq: (key: string, value: unknown) => { filters.push([key, value]); return builder; },
          maybeSingle: async () => ({ data: rows.find(row => filters.every(([key, value]) => (row as Row)[key] === value)) ?? null, error: null }),
          insert: () => { saved.directWrites.push(table); throw new Error("No direct insert fallback"); },
          update: () => { saved.directWrites.push(table); throw new Error("No direct update fallback"); },
          delete: () => { saved.directWrites.push(table); throw new Error("No direct delete fallback"); } };
        return builder;
      },
      async rpc(name: string, args: Row) {
        saved.calls.push({ name, args: structuredClone(args) });
        if (saved.error) return { data: null, error: { code: saved.error, message: "private SQL body and source" } };
        const requestId = String(args.p_request_id); const existing = saved.receipts.get(requestId);
        if (name === "recover_book_bible_mutation") return { data: projection(saved, existing?.receipt ?? null, !!existing, saved.closures.get(requestId) ?? null), error: null };
        if (name === "close_book_bible_mutation") {
          if (existing) return { data: projection(saved, existing.receipt, true), error: null };
          if (!saved.closures.has(requestId)) { saved.closures.set(requestId, { requestId, bookId: BOOK, closedAt: TIME }); saved.closureWrites++; }
          if (saved.loseReply) { saved.loseReply = false; return { data: null, error: { code: "08006" } }; }
          return { data: projection(saved, null, false, saved.closures.get(requestId)!), error: null };
        }
        assert.equal(name, "mutate_book_bible_item");
        const original = JSON.stringify(args);
        if (existing) return existing.original === original ? { data: projection(saved, existing.receipt, true), error: null }
          : { data: null, error: { code: "40001", message: "private mismatch details" } };
        if (saved.closures.has(requestId)) return { data: null, error: { code: "55000" } };
        const action = String(args.p_action); const intent = args.p_body as Row | null;
        if (action !== "create" && (!saved.item || saved.item.id !== args.p_item_id || saved.item.updated_at !== args.p_expected_updated_at
          || saved.item.mutation_incarnation_id !== args.p_expected_incarnation_id)) return { data: null, error: { code: "40001" } };
        let resultRow = saved.item;
        if (action !== "delete") {
          resultRow = { id: action === "create" ? ITEM : args.p_item_id, book_id: BOOK, type: intent!.type, name: intent!.name, description: intent!.description || null,
            attributes_json: { ...intent!.attributes as Row, imageAssetIds: intent!.imageAssetIds }, source_refs_json: intent!.sourceRefs,
            created_at: TIME, updated_at: action === "create" ? TIME : "2026-10-13T08:00:01.000Z", confidence: null,
            mutation_incarnation_id: action === "create" ? INCARNATION : saved.item!.mutation_incarnation_id };
          saved.item = resultRow;
        } else saved.item = null;
        saved.writes++;
        const receipt = { requestId, bookId: BOOK, action, itemId: resultRow!.id, intentHash: digest(args), resultHash: digest(resultRow), resultUpdatedAt: resultRow!.updated_at, committedAt: TIME };
        saved.receipts.set(requestId, { receipt, original });
        if (saved.loseReply) { saved.loseReply = false; return { data: null, error: { code: "08006" } }; }
        return { data: projection(saved, receipt, false), error: null };
      },
    } as never;
  };
}
async function appWith(saved: Store) {
  const app = Fastify(); await app.register(errorHandlerPlugin); await app.register(makeAuthPlugin(factory(saved))); await app.register(idempotencyPlugin);
  await app.register(async v1 => bookMemoryRoutes(v1), { prefix: "/v1" });
  app.post("/legacy-mutation-fixture", async () => ({ legacy: true }));
  return app;
}
const create = (app: Awaited<ReturnType<typeof appWith>>, intent: Row, headers = auth) => app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, headers, payload: intent });

test("manual create delegates original normalized intent before any mutable image or source validation", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close()); const intent = body();
  const response = await create(app, intent); assert.equal(response.statusCode, 201, response.body); assert.equal(response.headers["cache-control"], "private, no-store");
  assert.deepEqual(saved.calls[0], { name: "mutate_book_bible_item", args: { p_book_id: BOOK, p_request_id: intent.requestId, p_action: "create", p_item_id: null,
    p_expected_updated_at: null, p_body: { type: "character", name: "Elara", description: "mapmaker", attributes: {}, imageAssetIds: [], sourceRefs: intent.sourceRefs }, p_expected_incarnation_id: null } });
  assert.deepEqual(saved.reads, ["books", "workspace_members"]); assert.deepEqual(saved.directWrites, []); assert.ok(saved.tokens.every(token => token === "member"));
});
test("a committed create with a lost reply is read-only recoverable and same-key retry creates no duplicate", async t => {
  const saved = store(); saved.loseReply = true; const app = await appWith(saved); t.after(() => app.close()); const intent = body();
  assert.equal((await create(app, intent)).statusCode, 503); assert.equal(saved.writes, 1);
  const recovered = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/bible/requests/${intent.requestId}`, headers: auth });
  assert.equal(recovered.statusCode, 200, recovered.body); assert.equal(recovered.json().receipt.itemId, ITEM); assert.equal(recovered.json().replayed, true); assert.equal(saved.writes, 1);
  const replayed = await create(app, intent); assert.equal(replayed.statusCode, 200); assert.equal(replayed.json().replayed, true); assert.equal(saved.writes, 1);
  const changed = await create(app, { ...intent, name: "Different original intent" }); assert.equal(changed.statusCode, 409); assert.equal(saved.writes, 1);
});
test("durable POST replay bypasses the real idempotency plugin while unmarked POST retains duplicate rejection", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close()); const intent = body();
  const headers = { ...auth, "idempotency-key": randomUUID() };
  assert.equal((await create(app, intent, headers)).statusCode, 201); assert.equal((await create(app, intent, headers)).statusCode, 200);
  assert.equal((await create(app, { ...intent, name: "Changed" }, headers)).statusCode, 409); assert.equal(saved.calls.length, 3);
  const legacyHeaders = { ...auth, "idempotency-key": randomUUID() };
  assert.equal((await app.inject({ method: "POST", url: "/legacy-mutation-fixture", headers: legacyHeaders, payload: {} })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/legacy-mutation-fixture", headers: legacyHeaders, payload: {} })).statusCode, 409);
});
test("update/delete replay honors original concurrency identity and reports later changes rather than restoring or deleting again", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close()); await create(app, body());
  const update = { ...body(), requestId: randomUUID(), name: "Revised Elara", expectedUpdatedAt: TIME, expectedIncarnationId: INCARNATION };
  const url = `/v1/books/${BOOK}/bible/${ITEM}`;
  const changed = await app.inject({ method: "PUT", url, headers: auth, payload: update }); assert.equal(changed.statusCode, 200, changed.body);
  assert.equal(saved.calls[1].args.p_expected_incarnation_id, INCARNATION); assert.ok(!Object.hasOwn(saved.calls[1].args.p_body as Row, "expectedIncarnationId"));
  assert.equal(changed.json().item.mutation_incarnation_id, INCARNATION);
  const changedIntent = await app.inject({ method: "PUT", url, headers: auth, payload: { ...update, expectedIncarnationId: OTHER } });
  assert.equal(changedIntent.statusCode, 409); assert.equal(saved.writes, 2);
  const deletion = { requestId: randomUUID(), expectedUpdatedAt: changed.json().item.updated_at, expectedIncarnationId: INCARNATION };
  assert.equal((await app.inject({ method: "DELETE", url, headers: auth, payload: deletion })).statusCode, 200); assert.equal(saved.writes, 3);
  assert.equal((await app.inject({ method: "DELETE", url, headers: auth, payload: deletion })).json().disposition, "deleted"); assert.equal(saved.writes, 3);
  saved.item = { ...changed.json().item, name: "Later restored entry", mutation_incarnation_id: randomUUID() };
  const replay = await app.inject({ method: "DELETE", url, headers: auth, payload: deletion }); assert.equal(replay.statusCode, 200); assert.equal(replay.json().disposition, "changed");
  assert.equal(replay.json().item.name, "Later restored entry"); assert.equal(saved.writes, 3);
});
test("unknown recovery returns the exact missing envelope without writes or source reads", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close());
  const response = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/bible/requests/${randomUUID()}`, headers: auth });
  assert.equal(response.statusCode, 200); assert.deepEqual(response.json(), { receipt: null, disposition: null, item: null, replayed: false, closed: false, closure: null });
  assert.equal(saved.calls[0].name, "recover_book_bible_mutation"); assert.equal(saved.writes, 0); assert.deepEqual(saved.reads, ["books", "workspace_members"]);
});
for (const [code, status] of [["42501", 403], ["P0002", 404], ["22023", 422], ["40001", 409], ["55000", 409], ["0A000", 503], ["42883", 503], ["PGRST202", 503], ["08006", 503]] as const) {
  test(`RPC ${code} becomes ${status} without diagnostics or direct-write fallback`, async t => {
    const saved = store(); saved.error = code; const app = await appWith(saved); t.after(() => app.close());
    const response = await create(app, body()); assert.equal(response.statusCode, status); assert.ok(!response.body.includes("private SQL")); assert.deepEqual(saved.directWrites, []); assert.equal(saved.writes, 0);
  });
}
for (const [name, mutate] of [
  ["request ID", (result: Row) => { (result.receipt as Row).requestId = OTHER; }],
  ["book", (result: Row) => { (result.receipt as Row).bookId = OTHER; }],
  ["action", (result: Row) => { (result.receipt as Row).action = "delete"; }],
  ["hash", (result: Row) => { (result.receipt as Row).resultHash = "bad"; }],
  ["item", (result: Row) => { (result.item as Row).id = OTHER; }],
  ["item incarnation missing", (result: Row) => { delete (result.item as Row).mutation_incarnation_id; }],
  ["item incarnation invalid", (result: Row) => { (result.item as Row).mutation_incarnation_id = "bad"; }],
  ["unchanged timestamp", (result: Row) => { (result.item as Row).updated_at = "2026-10-13T09:00:00.000Z"; }],
  ["disposition", (result: Row) => { result.disposition = "deleted"; }],
  ["fresh changed projection", (result: Row) => { result.disposition = "changed"; }],
] as const) test(`unverified SQL ${name} never claims successful canon save`, async t => {
  const saved = store(); saved.override = result => { mutate(result); return result; }; const app = await appWith(saved); t.after(() => app.close());
  assert.equal((await create(app, body())).statusCode, 503); assert.equal(saved.writes, 1); assert.deepEqual(saved.directWrites, []);
});
test("authentication, current editing access and UUID/body syntax fail before the RPC", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close());
  assert.equal((await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible`, payload: body() })).statusCode, 401);
  assert.equal((await create(app, { ...body(), requestId: "bad" })).statusCode, 422);
  assert.equal((await create(app, { ...body(), book_id: OTHER })).statusCode, 422);
  saved.members[0].role = "viewer"; assert.equal((await create(app, body())).statusCode, 403);
  assert.equal((await app.inject({ method: "GET", url: `/v1/books/${BOOK}/bible/requests/${randomUUID()}`, headers: auth })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/requests/${randomUUID()}/close`, headers: auth, payload: {} })).statusCode, 403);
  assert.equal(saved.calls.length, 0); assert.deepEqual(saved.directWrites, []);
});
test("impossible unchanged delete replay cannot acknowledge a second deletion", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close()); await create(app, body());
  const intent = { requestId: randomUUID(), expectedUpdatedAt: TIME, expectedIncarnationId: INCARNATION }; const url = `/v1/books/${BOOK}/bible/${ITEM}`;
  assert.equal((await app.inject({ method: "DELETE", url, headers: auth, payload: intent })).statusCode, 200);
  saved.item = { id: ITEM, book_id: BOOK, type: "character", name: "Restored", description: null, attributes_json: {}, source_refs_json: [], created_at: TIME, updated_at: TIME, confidence: null, mutation_incarnation_id: randomUUID() };
  saved.override = result => ({ ...result, disposition: "unchanged" });
  const response = await app.inject({ method: "DELETE", url, headers: auth, payload: intent }); assert.equal(response.statusCode, 503); assert.equal(saved.writes, 2);
});
test("mutation and recovery errors keep private no-store caching, including auth and invalid input", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close());
  for (const options of [
    { method: "POST" as const, url: `/v1/books/${BOOK}/bible`, payload: body() },
    { method: "POST" as const, url: `/v1/books/${BOOK}/bible`, headers: auth, payload: { ...body(), requestId: "bad" } },
    { method: "GET" as const, url: `/v1/books/${BOOK}/bible/requests/${randomUUID()}`, headers: auth },
    { method: "POST" as const, url: `/v1/books/${BOOK}/bible/requests/${randomUUID()}/close`, payload: {} },
  ]) { const response = await app.inject(options); assert.equal(response.headers["cache-control"], "private, no-store"); }
});
test("expected actor header binds manual requests to the authenticated account before any scope or RPC access", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close());
  for (const header of [undefined, "bad", OTHER]) {
    const headers = { authorization: "Bearer member", ...(header ? { "x-bookworm-actor": header } : {}) };
    for (const options of [
      { method: "POST" as const, url: `/v1/books/${BOOK}/bible`, payload: body() },
      { method: "PUT" as const, url: `/v1/books/${BOOK}/bible/${ITEM}`, payload: { ...body(), expectedUpdatedAt: TIME, expectedIncarnationId: INCARNATION } },
      { method: "DELETE" as const, url: `/v1/books/${BOOK}/bible/${ITEM}`, payload: { requestId: randomUUID(), expectedUpdatedAt: TIME, expectedIncarnationId: INCARNATION } },
      { method: "GET" as const, url: `/v1/books/${BOOK}/bible/requests/${randomUUID()}` },
      { method: "POST" as const, url: `/v1/books/${BOOK}/bible/requests/${randomUUID()}/close`, payload: {} },
    ]) {
      const response = await app.inject({ ...options, headers });
      assert.equal(response.statusCode, header === OTHER ? 409 : 422); assert.equal(response.headers["cache-control"], "private, no-store");
    }
  }
  assert.equal(saved.calls.length, 0); assert.deepEqual(saved.reads, []); assert.deepEqual(saved.directWrites, []);
});

test("lost closure reply is read-only recoverable and durably fences an originally invalid request", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close()); const intent = body();
  assert.equal((await create(app, { ...intent, attributes: { imageAssetIds: [] } })).statusCode, 422);
  saved.loseReply = true;
  const url = `/v1/books/${BOOK}/bible/requests/${intent.requestId}`;
  const closed = await app.inject({ method: "POST", url: `${url}/close`, headers: auth, payload: {} });
  assert.equal(closed.statusCode, 503); assert.equal(saved.writes, 0); assert.equal(saved.closureWrites, 1);
  const proof = await app.inject({ method: "GET", url, headers: auth });
  assert.equal(proof.statusCode, 200); assert.deepEqual(proof.json(), { receipt: null, disposition: null, item: null, replayed: false, closed: true,
    closure: { requestId: intent.requestId, bookId: BOOK, closedAt: TIME } });
  assert.deepEqual(saved.calls.slice(0, 2).map(call => call.name), ["close_book_bible_mutation", "recover_book_bible_mutation"]);
  const retry = await create(app, intent); assert.equal(retry.statusCode, 409); assert.equal(retry.json().error.code, "book_bible_request_closed");
  for (const options of [
    { method: "PUT" as const, payload: { ...intent, expectedUpdatedAt: TIME, expectedIncarnationId: INCARNATION } },
    { method: "DELETE" as const, payload: { requestId: intent.requestId, expectedUpdatedAt: TIME, expectedIncarnationId: INCARNATION } },
  ]) {
    const response = await app.inject({ ...options, url: `/v1/books/${BOOK}/bible/${ITEM}`, headers: auth });
    assert.equal(response.statusCode, 409); assert.equal(response.json().error.code, "book_bible_request_closed");
  }
  assert.equal(saved.writes, 0); assert.equal(saved.closureWrites, 1);
  assert.equal((await create(app, { ...intent, requestId: randomUUID() })).statusCode, 201); assert.equal(saved.writes, 1);
  assert.deepEqual(saved.directWrites, []);
});

test("closing an already committed request returns its exact current canon evidence without a closure or second write", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close()); const intent = body();
  const original = (await create(app, intent)).json(); saved.item = { ...saved.item!, name: "Latest canon" };
  const response = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/requests/${intent.requestId}/close`, headers: auth, payload: {} });
  assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json().receipt, original.receipt);
  assert.equal(response.json().disposition, "changed"); assert.equal(response.json().item.name, "Latest canon");
  assert.equal(response.json().closed, false); assert.equal(response.json().replayed, true); assert.equal(saved.writes, 1); assert.equal(saved.closureWrites, 0);
  saved.item = null;
  const deleted = await app.inject({ method: "POST", url: `/v1/books/${BOOK}/bible/requests/${intent.requestId}/close`, headers: auth, payload: {} });
  assert.equal(deleted.statusCode, 200); assert.deepEqual(deleted.json().receipt, original.receipt); assert.equal(deleted.json().disposition, "deleted");
  assert.equal(deleted.json().closed, false); assert.equal(saved.writes, 1); assert.equal(saved.closureWrites, 0);
  assert.equal(saved.calls[1].name, "close_book_bible_mutation"); assert.deepEqual(saved.directWrites, []);
});

test("closure POST bypasses process idempotency and repeats only the same durable closure RPC", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close()); const request = randomUUID();
  const options = { method: "POST" as const, url: `/v1/books/${BOOK}/bible/requests/${request}/close`, headers: { ...auth, "idempotency-key": randomUUID() }, payload: {} };
  for (let index = 0; index < 2; index++) { const response = await app.inject(options); assert.equal(response.statusCode, 200); assert.equal(response.json().closed, true); }
  assert.equal(saved.closureWrites, 1); assert.equal(saved.writes, 0); assert.equal(saved.calls.length, 2);
  assert.ok(saved.calls.every(call => call.name === "close_book_bible_mutation" && call.args.p_book_id === BOOK && call.args.p_request_id === request));
});

test("closure never invents evidence from malformed RPC outcomes or unavailable migration", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close());
  const options = { method: "POST" as const, url: `/v1/books/${BOOK}/bible/requests/${randomUUID()}/close`, headers: auth, payload: {} };
  for (const override of [(result: Row) => ({ ...result, closed: false }), (result: Row) => ({ ...result, replayed: true }),
    (result: Row) => ({ ...result, disposition: "deleted" }), (result: Row) => ({ ...result, item: {} })]) {
    saved.override = override; const response = await app.inject(options); assert.equal(response.statusCode, 503); assert.equal(response.headers["cache-control"], "private, no-store");
  }
  saved.override = null; saved.error = "PGRST202";
  assert.equal((await app.inject(options)).statusCode, 503); assert.equal(saved.writes, 0); assert.deepEqual(saved.directWrites, []);
});

test("a receipt marked closed cannot acknowledge a committed canon mutation", async t => {
  const saved = store(); saved.override = result => ({ ...result, closed: true }); const app = await appWith(saved); t.after(() => app.close());
  assert.equal((await create(app, body())).statusCode, 503); assert.equal(saved.writes, 1);
});

test("closure proof must bind the exact book and original request before closure or GET is acknowledged", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close()); const requestId = randomUUID();
  const url = `/v1/books/${BOOK}/bible/requests/${requestId}`;
  for (const closure of [null, { requestId: OTHER, bookId: BOOK, closedAt: TIME }, { requestId, bookId: OTHER, closedAt: TIME },
    { requestId, bookId: BOOK, closedAt: "bad" }, { requestId, bookId: BOOK, closedAt: TIME, actorId: USER }]) {
    saved.override = result => ({ ...result, closure });
    for (const options of [{ method: "POST" as const, url: `${url}/close`, payload: {} }, { method: "GET" as const, url }]) {
      const response = await app.inject({ ...options, headers: auth }); assert.equal(response.statusCode, 503); assert.equal(saved.writes, 0);
    }
  }
  saved.override = result => ({ ...result, closed: false });
  assert.equal((await app.inject({ method: "GET", url, headers: auth })).statusCode, 503);
  assert.equal(saved.closureWrites, 1); assert.deepEqual(saved.directWrites, []);
});

test("closure accepts no canon fields or query options before RPC access", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close()); const url = `/v1/books/${BOOK}/bible/requests/${randomUUID()}/close`;
  for (const options of [{ payload: { name: "Do not save" } }, { payload: {} , url: `${url}?retry=true` }, { url: url.replace(/requests\/[^/]+/u, "requests/bad"), payload: {} }]) {
    assert.equal((await app.inject({ method: "POST", url, headers: auth, ...options })).statusCode, 422);
  }
  assert.equal(saved.calls.length, 0); assert.deepEqual(saved.directWrites, []);
});

for (const action of ["update", "delete"] as const) for (const change of ["direct edit", "exact UUID recreation"] as const) {
  test(`first ${action} rejects ${change} despite the original item UUID`, async t => {
    const saved = store(); const app = await appWith(saved); t.after(() => app.close());
    const original = (await create(app, body())).json().item;
    saved.item = change === "direct edit" ? { ...original, name: "Directly edited", updated_at: "2026-10-13T08:00:00.001Z" }
      : { ...original, mutation_incarnation_id: randomUUID() };
    const current = structuredClone(saved.item);
    const requestId = randomUUID();
    const payload = { ...(action === "update" ? body() : {}), requestId, expectedUpdatedAt: original.updated_at, expectedIncarnationId: original.mutation_incarnation_id };
    const response = await app.inject({ method: action === "update" ? "PUT" : "DELETE", url: `/v1/books/${BOOK}/bible/${ITEM}`, headers: auth, payload });
    assert.equal(response.statusCode, 409); assert.equal(saved.writes, 1); assert.equal(saved.receipts.has(requestId), false);
    assert.deepEqual(saved.directWrites, []); assert.deepEqual(saved.item, current);
    const recovered = await app.inject({ method: "GET", url: `/v1/books/${BOOK}/bible/requests/${requestId}`, headers: auth });
    assert.equal(recovered.json().receipt, null); assert.equal(recovered.json().closed, false);
  });
}

test("first update/delete requires an explicit incarnation UUID before the RPC", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close());
  for (const method of ["PUT", "DELETE"] as const) for (const expectedIncarnationId of [undefined, null, "bad"]) {
    const payload = { ...(method === "PUT" ? body() : { requestId: randomUUID() }), expectedUpdatedAt: TIME,
      ...(expectedIncarnationId === undefined ? {} : { expectedIncarnationId }) };
    const response = await app.inject({ method, url: `/v1/books/${BOOK}/bible/${ITEM}`, headers: auth, payload });
    assert.equal(response.statusCode, 422); assert.equal(response.headers["cache-control"], "private, no-store");
  }
  assert.equal(saved.calls.length, 0); assert.deepEqual(saved.reads, []);
});

test("fresh update projection cannot swap the target incarnation while replay may report a later incarnation", async t => {
  const saved = store(); const app = await appWith(saved); t.after(() => app.close()); await create(app, body());
  const intent = { ...body(), expectedUpdatedAt: TIME, expectedIncarnationId: INCARNATION };
  saved.override = result => { if (result.item) (result.item as Row).mutation_incarnation_id = OTHER; return result; };
  const response = await app.inject({ method: "PUT", url: `/v1/books/${BOOK}/bible/${ITEM}`, headers: auth, payload: intent });
  assert.equal(response.statusCode, 503); assert.equal(saved.writes, 2);
  saved.override = null; saved.item = { ...saved.item!, mutation_incarnation_id: OTHER };
  const replay = await app.inject({ method: "PUT", url: `/v1/books/${BOOK}/bible/${ITEM}`, headers: auth, payload: intent });
  assert.equal(replay.statusCode, 200); assert.equal(replay.json().disposition, "changed"); assert.equal(replay.json().item.mutation_incarnation_id, OTHER); assert.equal(saved.writes, 2);
});
