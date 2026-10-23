import { test } from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { chapterRoutes } from "./routes/chapters.js";
import { AppError } from "./errors.js";

const user = "11111111-1111-4111-8111-111111111111", chapter = "22222222-2222-4222-8222-222222222222", operation = "33333333-3333-4333-8333-333333333333";
const body = [{ id: "n", type: "paragraph", text: "Saved base" }];
type Row = { id: string; chapter_id: string; operation_id: string; created_by: string; version_number: number; content_json: { schemaVersion: string; nodes: typeof body } };
const row = (op = "initial", version = 1): Row => ({ id: `v${version}`, chapter_id: chapter, operation_id: op, created_by: user, version_number: version, content_json: { schemaVersion: "1.0", nodes: structuredClone(body) } });
async function fixture({ role = "writer", initial = [row()], race = false } = {}) {
  const rows = structuredClone(initial); let writes = 0;
  const sb = { from(table: string) {
    const filters: Record<string, unknown> = {}; let ordered = false;
    const query = { select: () => query, eq: (key: string, value: unknown) => { filters[key] = value; return query; },
      in: (key: string, value: unknown[]) => { filters[key] = value; return query; }, order: () => { ordered = true; return query; }, limit: () => query,
      maybeSingle: async () => {
        if (table === "chapters") return { data: { id: chapter, book_id: "book" }, error: null };
        if (table === "books") return { data: { id: "book", workspace_id: "workspace" }, error: null };
        if (table === "workspace_members") return { data: role ? { role } : null, error: null };
        const matches = rows.filter(r => Object.entries(filters).every(([k, v]) => Array.isArray(v) ? v.includes(r[k as keyof Row]) : r[k as keyof Row] === v));
        return { data: (ordered ? matches.sort((a, b) => b.version_number - a.version_number) : matches)[0] ?? null, error: null };
      } };
    return query;
  }, async rpc(name: string, params: Record<string, unknown>) {
    assert.equal(name, "append_chapter_version"); writes++;
    if (race) rows.push(row(operation, 2));
    if (rows.at(-1)!.version_number !== params.p_expected_version) return { data: null, error: { code: "40001" } };
    const next = row(String(params.p_operation_id), 2); next.content_json = params.p_content_json as Row["content_json"]; rows.push(next);
    return { data: next, error: null };
  } };
  const app = Fastify(); app.decorate("supabaseFactory", (() => sb) as never);
  app.addHook("preHandler", async req => { req.userId = user; req.userToken = "fixture-only"; });
  app.setErrorHandler((e, _req, reply) => reply.code(e instanceof AppError ? e.status : 500).send({ message: e instanceof Error ? e.message : "Failed" }));
  chapterRoutes(app);
  const url = `/chapters/${chapter}/manual-saves/${operation}`;
  return { app, rows, writes: () => writes, read: () => app.inject({ url: `${url}?expectedVersion=1`, headers: { "x-bookworm-actor": user } }),
    close: (actor = user) => app.inject({ method: "POST", url: `${url}/close`, headers: { "x-bookworm-actor": actor }, payload: { expectedVersion: 1 } }) };
}

test("manual save read is private, author-bound, read-only and keeps missing outcomes unresolved", async () => {
  const f = await fixture(); try { const r = await f.read(); assert.equal(r.statusCode, 200); assert.equal(r.json().status, "not_found"); assert.equal(r.headers["cache-control"], "private, no-store"); assert.equal(f.writes(), 0); } finally { await f.app.close(); }
});
test("manual save closure appends one unchanged version and is recoverable after a lost reply", async () => {
  const f = await fixture(); try {
    assert.equal((await f.close()).json().status, "closed"); assert.deepEqual(f.rows[1].content_json.nodes, body);
    assert.equal((await f.read()).json().status, "closed"); assert.equal((await f.close()).json().status, "closed"); assert.equal(f.writes(), 1);
  } finally { await f.app.close(); }
});
test("a committed original wins recovery and is never undone by close", async () => {
  const f = await fixture({ initial: [row(), row(operation, 2), row("later", 3)] }); try {
    const r = await f.close(); assert.equal(r.json().status, "saved"); assert.equal(r.json().receipt.document.version, 2); assert.equal(r.json().currentVersion, 3); assert.equal(f.writes(), 0);
  } finally { await f.app.close(); }
});
test("later versions fence an absent original; close does not append another version", async () => {
  const f = await fixture({ initial: [row(), row("other", 2)] }); try { assert.equal((await f.close()).json().status, "superseded"); assert.equal(f.writes(), 0); } finally { await f.app.close(); }
});
test("an original committing during closure wins its version lock and stays recoverable", async () => {
  const f = await fixture({ race: true }); try { assert.equal((await f.close()).statusCode, 409); assert.equal((await f.read()).json().status, "saved"); assert.equal(f.rows.length, 2); } finally { await f.app.close(); }
});
test("account crossover and read-only membership cannot create a closure", async () => {
  const f = await fixture({ role: "viewer" }); try {
    assert.equal((await f.read()).statusCode, 200); assert.equal((await f.close()).statusCode, 403);
    assert.equal((await f.close("44444444-4444-4444-8444-444444444444")).statusCode, 409); assert.equal(f.writes(), 0);
  } finally { await f.app.close(); }
});

test("malformed recovery identities and revisions cannot reach a database write", async () => {
  const f = await fixture();
  const url = `/chapters/${chapter}/manual-saves/${operation}`;
  try {
    for (const expectedVersion of [null, "1", -1, 1.5, 2147483646]) {
      assert.equal((await f.app.inject({ method: "POST", url: `${url}/close`, headers: { "x-bookworm-actor": user }, payload: { expectedVersion } })).statusCode, 422);
    }
    for (const query of ["", "?expectedVersion=01", "?expectedVersion=1.0", "?expectedVersion=1&extra=ignored"]) {
      assert.equal((await f.app.inject({ url: `${url}${query}`, headers: { "x-bookworm-actor": user } })).statusCode, 422);
    }
    assert.equal((await f.app.inject({ url: `${url}?expectedVersion=1` })).statusCode, 422);
    assert.equal((await f.app.inject({ method: "PUT", url: `/chapters/${chapter}/document`, headers: { "x-bookworm-actor": "44444444-4444-4444-8444-444444444444" }, payload: { expectedVersion: 1, nodes: body, operationId: operation } })).statusCode, 409);
    assert.equal(f.writes(), 0);
  } finally { await f.app.close(); }
});

test("another author's receipt cannot be returned as this author's saved content", async () => {
  const f = await fixture({ initial: [row(), { ...row(operation, 2), created_by: "44444444-4444-4444-8444-444444444444" }] });
  try { const r = (await f.read()).json(); assert.equal(r.status, "superseded"); assert.equal(r.receipt, null); assert.equal(f.writes(), 0); }
  finally { await f.app.close(); }
});
