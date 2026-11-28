import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { chapterRoutes } from "./routes/chapters.js";
import { AppError } from "./errors.js";

const actor = "b5100000-0000-4000-8000-000000000001";
const chapter = "b5100000-0000-4000-8000-000000000002";
const book = "b5100000-0000-4000-8000-000000000003";
const operation = "b5100000-0000-4000-8000-000000000004";
const title = "The Arrival";
const digest = createHash("sha256").update(title).digest("hex");
const current = { title: "Original", revision: 0, updatedAt: "2026-10-23T15:00:00Z" };
const result = { chapterId: chapter, bookId: book, operationId: operation, expectedRevision: 0,
  titleDigest: digest, status: "not_found", receipt: null, current };

async function fixture(options: { role?: string; result?: unknown; error?: { code: string }; revision?: number | null } = {}) {
  const calls: { name: string; body: Record<string, unknown> }[] = [];
  const sb = { from(table: string) {
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ error: null,
      data: table === "chapters" ? { id: chapter, book_id: book, title: "Original", title_revision: options.revision === null ? undefined : options.revision ?? 0, updated_at: current.updatedAt }
        : table === "books" ? { id: book, workspace_id: "workspace" } : { role: options.role ?? "writer" } }) };
    return query;
  }, async rpc(name: string, body: Record<string, unknown>) { calls.push({ name, body }); return { data: options.result ?? result, error: options.error ?? null }; } };
  const app = Fastify(); app.decorate("supabaseFactory", (() => sb) as never);
  app.addHook("preHandler", async req => { req.userId = actor; req.userToken = "fixture-only"; });
  app.setErrorHandler((e, _req, reply) => reply.code(e instanceof AppError ? e.status : 500).send({ message: e instanceof Error ? e.message : "Failed" }));
  chapterRoutes(app);
  const root = `/chapters/${chapter}/title-changes/${operation}`;
  const headers = { "x-bookworm-actor": actor };
  return { app, calls, root, headers, read: () => app.inject({ url: `${root}?expectedRevision=0&titleDigest=${digest}`, headers }),
    save: (payload: unknown = { expectedRevision: 0, title }) => app.inject({ method: "PUT", url: root, headers, payload: payload as never }),
    close: () => app.inject({ method: "POST", url: `${root}/close`, headers, payload: { expectedRevision: 0, titleDigest: digest } }) };
}

test("chapter title read is private, member-scoped and independent of manuscript reads", async () => {
  const f = await fixture({ role: "viewer" }); try {
    const r = await f.app.inject({ url: `/chapters/${chapter}/title`, headers: f.headers });
    assert.equal(r.statusCode, 200); assert.equal(r.headers["cache-control"], "private, no-store");
    assert.deepEqual(r.json(), { bookId: book, chapterId: chapter, ...current, role: "viewer" }); assert.equal(f.calls.length, 0);
  } finally { await f.app.close(); }
});
test("chapter title change delegates one exact actor-scoped, revision-checked request", async () => {
  const saved = { ...result, status: "saved", receipt: { title, revision: 1 }, current: { ...current, title, revision: 1 } };
  const f = await fixture({ result: saved }); try {
    const r = await f.save(); assert.equal(r.statusCode, 200); assert.deepEqual(r.json(), saved);
    assert.deepEqual(f.calls, [{ name: "change_chapter_title", body: { p_chapter_id: chapter, p_operation_id: operation, p_expected_revision: 0, p_title: title } }]);
  } finally { await f.app.close(); }
});
test("chapter title recovery reads its receipt without replaying a mutation", async () => {
  const f = await fixture(); try {
    const r = await f.read(); assert.equal(r.statusCode, 200); assert.equal(r.json().status, "not_found");
    assert.deepEqual(f.calls, [{ name: "get_chapter_title_change", body: { p_chapter_id: chapter, p_operation_id: operation, p_expected_revision: 0, p_title_digest: digest } }]);
  } finally { await f.app.close(); }
});
test("explicit title closure sends only identity and digest, never a replacement title", async () => {
  const f = await fixture({ result: { ...result, status: "closed" } }); try {
    assert.equal((await f.close()).statusCode, 200);
    assert.equal(f.calls[0].name, "close_chapter_title_change"); assert.equal(f.calls[0].body.p_title_digest, digest);
    assert.equal("p_title" in f.calls[0].body, false);
  } finally { await f.app.close(); }
});
test("title writes require editing permission; readers can check an existing result", async () => {
  const f = await fixture({ role: "viewer" }); try {
    assert.equal((await f.save()).statusCode, 403); assert.equal((await f.close()).statusCode, 403);
    assert.equal(f.calls.length, 0); assert.equal((await f.read()).statusCode, 200);
  } finally { await f.app.close(); }
});
test("chapter title requests refuse missing actors and account crossover before database access", async () => {
  const f = await fixture(); try {
    for (const headers of [{}, { "x-bookworm-actor": book }]) {
      const r = await f.app.inject({ method: "PUT", url: f.root, headers, payload: { expectedRevision: 0, title } });
      assert.equal(r.statusCode, "x-bookworm-actor" in headers ? 409 : 422);
    } assert.equal(f.calls.length, 0);
  } finally { await f.app.close(); }
});
test("chapter title validation rejects blank, control, oversized, stale-shaped and extraneous input", async () => {
  const f = await fixture(); try {
    for (const patch of [{ title: " " }, { title: "One\nTwo" }, { title: "x".repeat(501) }, { title: " One " }, { expectedRevision: -1 }, { expectedRevision: "0" }, { expectedRevision: 2147483647 }, { nodes: [] }]) {
      assert.equal((await f.save({ expectedRevision: 0, title, ...patch })).statusCode, 422, JSON.stringify(patch));
    }
    assert.equal((await f.app.inject({ url: `${f.root}?expectedRevision=00&titleDigest=${digest}`, headers: f.headers })).statusCode, 422);
    assert.equal((await f.app.inject({ url: `${f.root}?expectedRevision=0&titleDigest=bad`, headers: f.headers })).statusCode, 422);
    assert.equal(f.calls.length, 0);
  } finally { await f.app.close(); }
});
test("a missing title migration fails closed without claiming that the title was saved", async () => {
  const f = await fixture({ revision: null }); try {
    assert.equal((await f.app.inject({ url: `/chapters/${chapter}/title`, headers: f.headers })).statusCode, 503);
  } finally { await f.app.close(); }
  const g = await fixture({ error: { code: "PGRST202" } }); try { assert.equal((await g.save()).statusCode, 503); } finally { await g.app.close(); }
});
test("wrong-scope or internally inconsistent title receipts cannot report success", async () => {
  for (const patch of [{ chapterId: book }, { titleDigest: "a".repeat(64) }, { expectedRevision: 1 }, { status: "saved", receipt: null }, { status: "closed", receipt: { title, revision: 1 } }, { status: "saved", receipt: { title: "Wrong", revision: 1 }, current: { ...current, title: "Wrong", revision: 1 } }]) {
    const f = await fixture({ result: { ...result, ...patch } }); try { assert.equal((await f.save()).statusCode, 503); } finally { await f.app.close(); }
  }
});
